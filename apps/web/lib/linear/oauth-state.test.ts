import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { issueState, verifyState } from "./oauth-state";

const SECRET = "test-secret-do-not-use-in-prod";

describe("oauth-state", () => {
  test("issueState produces a 4-segment dot-separated token", () => {
    const token = issueState({ secret: SECRET, userId: "user_abc" });
    expect(token.split(".")).toHaveLength(4);
  });

  test("verifyState accepts a freshly-issued token", () => {
    const token = issueState({ secret: SECRET, userId: "user_abc" });
    const result = verifyState({ state: token, secret: SECRET });
    expect(result).toEqual({ ok: true, userId: "user_abc" });
  });

  test("verifyState rejects a malformed token (wrong segment count)", () => {
    expect(verifyState({ state: "not.a.token", secret: SECRET })).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(verifyState({ state: "a.b.c.d.e", secret: SECRET })).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  test("verifyState rejects tampered userId", () => {
    const token = issueState({ secret: SECRET, userId: "user_abc" });
    const parts = token.split(".");
    parts[0] = "user_evil";
    const tampered = parts.join(".");
    const result = verifyState({ state: tampered, secret: SECRET });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("bad_sig");
  });

  test("verifyState rejects with wrong secret", () => {
    const token = issueState({ secret: SECRET, userId: "user_abc" });
    const result = verifyState({ state: token, secret: "other-secret" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("bad_sig");
  });

  test("verifyState rejects expired tokens", () => {
    const token = issueState({ secret: SECRET, userId: "user_abc" });
    // Token's expiresAt is now+600s; fast-forward 700s.
    const future = Math.floor(Date.now() / 1000) + 700;
    const result = verifyState({
      state: token,
      secret: SECRET,
      nowSec: future,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("expired");
  });

  test("verifyState rejects non-numeric expiresAt", () => {
    // Hand-craft a token with a garbage expiresAt segment.
    const payload = "user_abc.NOT_A_NUMBER.abcd";
    const sig = createHmac("sha256", SECRET)
      .update(payload)
      .digest("base64url");
    const token = `${payload}.${sig}`;
    const result = verifyState({ state: token, secret: SECRET });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("malformed");
  });

  test("two issued tokens with same input produce different nonces", () => {
    const a = issueState({ secret: SECRET, userId: "user_abc" });
    const b = issueState({ secret: SECRET, userId: "user_abc" });
    expect(a).not.toBe(b);
  });
});
