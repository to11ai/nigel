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
  // Linear migrated to short-lived (~24h) access tokens with
  // refresh-token renewal in April 2026. Older installs may still
  // see long-lived tokens; we treat refresh_token as optional and
  // skip renewal when absent.
  refreshToken: string | null;
  // Seconds until access token expires. Translated to a wall-clock
  // Date when persisted via `accessTokenExpiresAt` on
  // LinearWorkspaceSecrets.
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
      refresh_token?: string;
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
      refreshToken: json.refresh_token ?? null,
      expiresIn: json.expires_in ?? null,
      scope: json.scope,
    };
  } finally {
    clearTimeout(timer);
  }
}

// Exchange a refresh_token for a fresh access_token. Linear's refresh
// endpoint is the same /oauth/token URL, just with grant_type=
// refresh_token. The response may include a NEW refresh_token (Linear
// rotates them) — callers MUST persist whatever value comes back, not
// the previous one.
export async function refreshAccessToken(input: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}): Promise<TokenExchangeResult> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
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
        `Linear token refresh returned ${res.status}: ${text.slice(0, 200)}`,
        res.status,
      );
    }
    const json = (await res.json().catch(() => null)) as {
      access_token?: string;
      token_type?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    } | null;
    if (!(json?.access_token && json.token_type && json.scope)) {
      throw new LinearOAuthError(
        "malformed_response",
        "Linear token refresh response missing access_token / token_type / scope",
      );
    }
    return {
      accessToken: json.access_token,
      tokenType: json.token_type,
      // Linear may return a new refresh_token (rotation) or reuse the
      // old one — either way, persist what came back. If Linear omits
      // it entirely, fall back to the input so we don't lose renewal
      // capability.
      refreshToken: json.refresh_token ?? input.refreshToken,
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
