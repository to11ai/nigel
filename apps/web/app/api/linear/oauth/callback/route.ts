import { NextResponse } from "next/server";
import {
  exchangeCodeForToken,
  fetchAppIdentity,
} from "@/lib/linear/oauth-client";
import { verifyState } from "@/lib/linear/oauth-state";
import {
  createLinearWorkspace,
  getLinearWorkspaceByWorkspaceId,
  LinearWorkspaceRepositoryError,
  updateLinearWorkspace,
} from "@/lib/linear/workspace-repository";
import { getServerSession } from "@/lib/session/get-server-session";

// Linear OAuth callback route.
//
// 1. Verify session is present (defense in depth — Linear has
//    already redirected us back, but if cookies were cleared the
//    flow shouldn't silently complete).
// 2. Verify the CSRF state (HMAC signed in the start route, must
//    decode to the SAME user id session.user.id has now).
// 3. Exchange the code for an access token.
// 4. Probe the token to read the App actor id + workspace id.
// 5. Upsert linear_workspace — create on first install, update on
//    subsequent re-installs into the same workspace.
// 6. Redirect to /settings/admin/linear with a success indicator.
//
// Every failure mode redirects to /settings/admin/linear with a
// `?linear_error=<code>` query param so the admin UI can show what
// happened. Returning raw 4xx/5xx HTML would dump users into a
// dead-end "page not working" screen with no actionable recovery.

export const runtime = "nodejs";

const ADMIN_PATH = "/settings/admin/linear";

type CallbackError =
  | "not_configured"
  | "unauthorized"
  | "missing_code"
  | "state_invalid"
  | "state_mismatch"
  | "state_expired"
  | "token_exchange_failed"
  | "identity_fetch_failed"
  | "persist_failed";

export async function GET(req: Request): Promise<Response> {
  const clientId = process.env.LINEAR_OAUTH_CLIENT_ID;
  const clientSecret = process.env.LINEAR_OAUTH_CLIENT_SECRET;
  const authSecret = process.env.BETTER_AUTH_SECRET;
  if (!(clientId && clientSecret && authSecret)) {
    return redirectWithError(req, "not_configured");
  }

  const session = await getServerSession();
  if (!session?.user) {
    return redirectWithError(req, "unauthorized");
  }

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const stateParam = url.searchParams.get("state");
  if (!code) {
    return redirectWithError(req, "missing_code");
  }
  if (!stateParam) {
    // Missing state is a CSRF / wiring problem, not a missing code —
    // surface it distinctly so the admin UI can tell them apart.
    return redirectWithError(req, "state_invalid");
  }

  const stateResult = verifyState({ state: stateParam, secret: authSecret });
  if (!stateResult.ok) {
    const reason: CallbackError =
      stateResult.reason === "expired" ? "state_expired" : "state_invalid";
    return redirectWithError(req, reason);
  }
  if (stateResult.userId !== session.user.id) {
    // The user who initiated the OAuth flow is not the user whose
    // browser is hitting the callback. Likely a stale cookie or a
    // user who signed out mid-flow. Refuse — never persist a token
    // tied to the wrong identity.
    return redirectWithError(req, "state_mismatch");
  }

  const redirectUri = `${url.origin}/api/linear/oauth/callback`;

  let token: Awaited<ReturnType<typeof exchangeCodeForToken>>;
  try {
    token = await exchangeCodeForToken({
      code,
      redirectUri,
      clientId,
      clientSecret,
    });
  } catch (err) {
    console.error("[linear-oauth] token exchange failed", { err });
    return redirectWithError(req, "token_exchange_failed");
  }

  let identity: Awaited<ReturnType<typeof fetchAppIdentity>>;
  try {
    identity = await fetchAppIdentity(token.accessToken);
  } catch (err) {
    console.error("[linear-oauth] identity fetch failed", { err });
    return redirectWithError(req, "identity_fetch_failed");
  }

  // The webhook secret stays in env (PR #47 wired it via Pulumi). We
  // store a placeholder in the DB so the encrypted column stays
  // non-null; resolveLinearWorkspace prefers env over DB.
  const envWebhookSecret = process.env.LINEAR_WEBHOOK_SECRET ?? "";
  const accessTokenExpiresAt =
    token.expiresIn !== null
      ? new Date(Date.now() + token.expiresIn * 1000).toISOString()
      : null;
  const persistedSecrets = {
    accessToken: token.accessToken,
    webhookSecret: envWebhookSecret,
    refreshToken: token.refreshToken,
    accessTokenExpiresAt,
  };
  try {
    const existing = await getLinearWorkspaceByWorkspaceId(
      identity.workspaceId,
    );
    if (existing) {
      await updateLinearWorkspace({
        id: existing.id,
        botUserId: identity.appActorId,
        secrets: persistedSecrets,
      });
    } else {
      await createLinearWorkspace({
        workspaceId: identity.workspaceId,
        botUserId: identity.appActorId,
        secrets: persistedSecrets,
      });
    }
  } catch (err) {
    if (
      err instanceof LinearWorkspaceRepositoryError &&
      err.code === "already_exists"
    ) {
      // Race: another tab finished the OAuth flow first. The other
      // install wins; this one is a no-op. Treat as success — the
      // workspace IS configured, just by someone else.
      return redirectWithSuccess(req, identity.workspaceUrlKey);
    }
    console.error("[linear-oauth] persist failed", { err });
    return redirectWithError(req, "persist_failed");
  }

  return redirectWithSuccess(req, identity.workspaceUrlKey);
}

function redirectWithError(req: Request, code: CallbackError): Response {
  const url = new URL(ADMIN_PATH, req.url);
  url.searchParams.set("linear_error", code);
  return NextResponse.redirect(url);
}

function redirectWithSuccess(req: Request, workspaceUrlKey: string): Response {
  const url = new URL(ADMIN_PATH, req.url);
  url.searchParams.set("linear_connected", workspaceUrlKey);
  return NextResponse.redirect(url);
}
