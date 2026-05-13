import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { verifyLinearSignature } from "./signature";

const SECRET = "whsec_test";

function sign(body: string, secret: string = SECRET): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

describe("verifyLinearSignature", () => {
  test("returns true on matching signature", () => {
    const body = '{"type":"Issue","action":"update"}';
    expect(
      verifyLinearSignature({
        rawBody: body,
        signatureHeader: sign(body),
        webhookSecret: SECRET,
      }),
    ).toBe(true);
  });

  test("returns false when signature is missing", () => {
    expect(
      verifyLinearSignature({
        rawBody: "{}",
        signatureHeader: null,
        webhookSecret: SECRET,
      }),
    ).toBe(false);
  });

  test("returns false when signature is wrong", () => {
    expect(
      verifyLinearSignature({
        rawBody: '{"type":"Issue"}',
        signatureHeader: sign('{"type":"Issue"}', "wrong-secret"),
        webhookSecret: SECRET,
      }),
    ).toBe(false);
  });

  test("returns false when body was tampered with", () => {
    const original = '{"type":"Issue","action":"update"}';
    const signedFor = sign(original);
    const tampered = '{"type":"Issue","action":"create"}';
    expect(
      verifyLinearSignature({
        rawBody: tampered,
        signatureHeader: signedFor,
        webhookSecret: SECRET,
      }),
    ).toBe(false);
  });

  test("strips a `sha256=` prefix if present", () => {
    const body = '{"type":"Issue"}';
    const sig = `sha256=${sign(body)}`;
    expect(
      verifyLinearSignature({
        rawBody: body,
        signatureHeader: sig,
        webhookSecret: SECRET,
      }),
    ).toBe(true);
  });

  test("returns false for length mismatch without throwing", () => {
    // Truncated signature would crash timingSafeEqual on unequal
    // buffers; the explicit length pre-check should short-circuit.
    expect(
      verifyLinearSignature({
        rawBody: "{}",
        signatureHeader: "short",
        webhookSecret: SECRET,
      }),
    ).toBe(false);
  });
});
