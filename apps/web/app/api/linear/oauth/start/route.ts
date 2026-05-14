import { NextResponse } from "next/server";
import { issueState } from "@/lib/linear/oauth-state";
import { getServerSession } from "@/lib/session/get-server-session";

// Linear OAuth start route.
//
// Authenticated Nigel users hit this endpoint and get redirected to
// Linear's authorize page. Linear shows the consent screen, then
// returns to /api/linear/oauth/callback with the auth code.
//
// `actor=app` is the key Linear-specific param: it makes the issued
// access token authenticate as the App actor (the bot identity)
// rather than as the consenting user. That's what gives Nigel its
// own user-like entity in Linear that tickets can be assigned to.
//
// Only logged-in users can start the flow — anonymous calls 401.
// Admin-only restriction isn't enforced here yet (no admin column
// on users today); when /admin/* gains its role check, gate this
// route on it too.

export const runtime = "nodejs";

const AUTHORIZE_URL = "https://linear.app/oauth/authorize";

// The scopes we need:
//   read         — list issues, teams, users for repo/owner resolution
//   write        — issueUpdate (reassignment)
//   issues:create — currently unused but reserved for future "create
//                   issue from chat" flow; cheap to ask for now
//   comments:create — commentCreate (status comments)
const SCOPES = ["read", "write", "issues:create", "comments:create"].join(",");

export async function GET(req: Request): Promise<Response> {
  const clientId = process.env.LINEAR_OAUTH_CLIENT_ID;
  const authSecret = process.env.BETTER_AUTH_SECRET;
  if (!clientId) {
    return new NextResponse("Linear OAuth not configured", { status: 503 });
  }
  if (!authSecret) {
    return new NextResponse("BETTER_AUTH_SECRET not configured", {
      status: 500,
    });
  }

  const session = await getServerSession();
  if (!session?.user) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  // Callback URL must match exactly one of the URLs registered on the
  // Linear app. We derive it from the request's origin so prod and
  // local dev both work without a separate env var. Linear requires
  // the redirect_uri parameter on the token exchange to match the
  // one used here, so we don't take it from a header that the user
  // can spoof — we use the URL the route was actually hit on.
  const requestUrl = new URL(req.url);
  const redirectUri = `${requestUrl.origin}/api/linear/oauth/callback`;

  const state = issueState({ secret: authSecret, userId: session.user.id });

  const authorizeUrl = new URL(AUTHORIZE_URL);
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("scope", SCOPES);
  authorizeUrl.searchParams.set("actor", "app");
  authorizeUrl.searchParams.set("state", state);
  // prompt=consent forces Linear to re-show the consent screen even
  // if the user has already authorized the app. Without it, repeat
  // installs into a different workspace silently reuse the previous
  // approval — confusing during testing.
  authorizeUrl.searchParams.set("prompt", "consent");

  return NextResponse.redirect(authorizeUrl);
}
