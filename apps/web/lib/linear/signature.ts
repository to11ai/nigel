import { createHmac, timingSafeEqual } from "node:crypto";

// Phase 6 L2: Linear webhook HMAC verification.
//
// Linear signs every webhook delivery with the workspace's webhook
// signing secret. The header is `Linear-Signature`; the body is the
// raw request payload. The signature is `HMAC-SHA256(secret, body)`
// hex-encoded.
//
// Constant-time comparison is mandatory — a timing-side-channel
// here would let an attacker brute-force valid signatures byte by
// byte. `timingSafeEqual` requires equal-length buffers, hence the
// length pre-check before the call.
//
// We intentionally do NOT pull the raw body from a parsed JSON
// object. The route reads `await req.text()` first, verifies, and
// only then parses. Re-serializing parsed JSON would change byte
// ordering / whitespace and break the signature for any payload
// Linear didn't emit byte-identically.

export function verifyLinearSignature(input: {
  rawBody: string;
  signatureHeader: string | null;
  webhookSecret: string;
}): boolean {
  if (!input.signatureHeader) return false;
  const expected = createHmac("sha256", input.webhookSecret)
    .update(input.rawBody, "utf8")
    .digest("hex");
  // Linear sends the signature as a plain hex string. Some other
  // vendors prefix with `sha256=`; defensively strip if present so
  // a future header-format change doesn't silently fail.
  const supplied = input.signatureHeader.startsWith("sha256=")
    ? input.signatureHeader.slice("sha256=".length)
    : input.signatureHeader;
  if (supplied.length !== expected.length) return false;
  return timingSafeEqual(
    Buffer.from(expected, "utf8"),
    Buffer.from(supplied, "utf8"),
  );
}
