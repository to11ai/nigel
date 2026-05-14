// Linear OAuth wiring: token exchange + identity probe.
//
// The start route redirects the browser to Linear's authorize page
// with `actor=app`. After the user consents, Linear redirects back
// to our callback with `?code=...`. The callback calls
// `exchangeCodeForToken` to swap the code for an access token, then
// `fetchAppIdentity` to read the app's GraphQL identity (viewer.id —
// for actor=app tokens, viewer is the app itself, not a real user)
// alongside the workspace's metadata.

const TOKEN_ENDPOINT = "https://api.linear.app/oauth/token";
const GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";

const REQUEST_TIMEOUT_MS = 15_000;

export type TokenExchangeResult = {
  accessToken: string;
  tokenType: string;
  // Linear's actor=app tokens are long-lived (10 years per current
  // policy); user tokens have shorter expiries. We pass it through
  // unchanged so future logic can act on it without re-parsing.
  expiresIn: number | null;
  scope: string;
};

export class LinearOAuthError extends Error {
  readonly code:
    | "token_exchange_failed"
    | "identity_fetch_failed"
    | "malformed_response";
  readonly status?: number;
  constructor(
    code:
      | "token_exchange_failed"
      | "identity_fetch_failed"
      | "malformed_response",
    message: string,
    status?: number,
  ) {
    super(message);
    this.name = "LinearOAuthError";
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

export async function exchangeCodeForToken(input: {
  code: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
}): Promise<TokenExchangeResult> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    client_secret: input.clientSecret,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new LinearOAuthError(
        "token_exchange_failed",
        `Linear token exchange returned ${res.status}: ${text.slice(0, 200)}`,
        res.status,
      );
    }
    const json = (await res.json().catch(() => null)) as {
      access_token?: string;
      token_type?: string;
      expires_in?: number;
      scope?: string;
    } | null;
    if (!(json?.access_token && json.token_type && json.scope)) {
      throw new LinearOAuthError(
        "malformed_response",
        "Linear token response missing access_token / token_type / scope",
      );
    }
    return {
      accessToken: json.access_token,
      tokenType: json.token_type,
      expiresIn: json.expires_in ?? null,
      scope: json.scope,
    };
  } finally {
    clearTimeout(timer);
  }
}

export type AppIdentity = {
  // The app's GraphQL user id. For actor=app tokens this is the
  // app's user-like entity; assignments to "Nigel" on Linear use
  // this id as the assignee. Stored as `linear_workspace.botUserId`.
  appActorId: string;
  appName: string;
  // The Linear workspace this token was issued for. Used to enforce
  // single-workspace install (the schema has a unique index on
  // workspace_id) and to display to the admin after callback.
  workspaceId: string;
  workspaceName: string;
  workspaceUrlKey: string;
};

export async function fetchAppIdentity(
  accessToken: string,
): Promise<AppIdentity> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        query: `
          query AppIdentity {
            viewer { id name }
            organization { id name urlKey }
          }
        `,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new LinearOAuthError(
        "identity_fetch_failed",
        `Linear identity probe returned ${res.status}: ${text.slice(0, 200)}`,
        res.status,
      );
    }
    const json = (await res.json().catch(() => null)) as {
      data?: {
        viewer?: { id?: string; name?: string };
        organization?: { id?: string; name?: string; urlKey?: string };
      };
      errors?: Array<{ message?: string }>;
    } | null;
    if (json?.errors && json.errors.length > 0) {
      const messages = json.errors
        .map((e) => e.message ?? "(no message)")
        .join("; ");
      throw new LinearOAuthError(
        "identity_fetch_failed",
        `Linear identity probe GraphQL errors: ${messages}`,
      );
    }
    const viewer = json?.data?.viewer;
    const org = json?.data?.organization;
    if (!(viewer?.id && viewer.name && org?.id && org.name && org.urlKey)) {
      throw new LinearOAuthError(
        "malformed_response",
        "Linear identity probe missing viewer / organization fields",
      );
    }
    return {
      appActorId: viewer.id,
      appName: viewer.name,
      workspaceId: org.id,
      workspaceName: org.name,
      workspaceUrlKey: org.urlKey,
    };
  } finally {
    clearTimeout(timer);
  }
}
