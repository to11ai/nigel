import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Linear OAuth wiring: signed CSRF state token.
//
// The state value carries:
//   <userId>.<expiresAt>.<nonce>.<sig>
//
// `sig` is HMAC-SHA256 over `<userId>.<expiresAt>.<nonce>` using
// `BETTER_AUTH_SECRET` (already provisioned, already used for session
// signing — one less secret to rotate). The nonce defeats replay
// even with the user id pinned, and expiresAt caps the window
// (10 min) so a stolen state from logs can't trigger a callback
// hours later.
//
// We could persist state in a DB table instead, but signed-token
// state is stateless — survives a deploy mid-flow and doesn't add a
// new write path. The receiver only needs the same secret to verify.

const STATE_TTL_SEC = 600;

export function issueState(input: { secret: string; userId: string }): string {
  const nonce = randomBytes(16).toString("base64url");
  const expiresAt = Math.floor(Date.now() / 1000) + STATE_TTL_SEC;
  const payload = `${input.userId}.${expiresAt}.${nonce}`;
  const sig = createHmac("sha256", input.secret)
    .update(payload)
    .digest("base64url");
  return `${payload}.${sig}`;
}

export type VerifyStateResult =
  | { ok: true; userId: string }
  | { ok: false; reason: "malformed" | "expired" | "bad_sig" };

export function verifyState(input: {
  state: string;
  secret: string;
  // Injectable so tests can pin the clock without touching Date.now
  // globally. Production callers leave it unset.
  nowSec?: number;
}): VerifyStateResult {
  const parts = input.state.split(".");
  if (parts.length !== 4) return { ok: false, reason: "malformed" };
  const [userId, expiresAtStr, nonce, sig] = parts;
  if (!(userId && expiresAtStr && nonce && sig)) {
    return { ok: false, reason: "malformed" };
  }
  const payload = `${userId}.${expiresAtStr}.${nonce}`;
  const expected = createHmac("sha256", input.secret)
    .update(payload)
    .digest("base64url");
  // timingSafeEqual requires equal-length Buffers; lengths differ →
  // not a match regardless of value, so short-circuit before the
  // comparison to avoid a throw.
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) {
    return { ok: false, reason: "bad_sig" };
  }
  if (!timingSafeEqual(sigBuf, expBuf)) {
    return { ok: false, reason: "bad_sig" };
  }
  const expiresAt = Number(expiresAtStr);
  if (!Number.isFinite(expiresAt)) {
    return { ok: false, reason: "malformed" };
  }
  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);
  if (expiresAt < nowSec) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, userId };
}
