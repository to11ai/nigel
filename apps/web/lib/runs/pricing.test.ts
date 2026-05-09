import { describe, expect, test } from "bun:test";
import { tokensToMicros } from "./pricing";

describe("tokensToMicros", () => {
  test("computes sonnet 4.6 cost", () => {
    // 1000 prompt @ $3/M + 200 completion @ $15/M = 3000 + 3000 = 6000 micros
    expect(
      tokensToMicros("anthropic/claude-sonnet-4.6", {
        promptTokens: 1000,
        completionTokens: 200,
      }),
    ).toBe(6000);
  });

  test("computes haiku 4.5 cost", () => {
    // 1000 prompt @ $1/M + 1000 completion @ $5/M = 1000 + 5000 = 6000 micros
    expect(
      tokensToMicros("anthropic/claude-haiku-4.5", {
        promptTokens: 1000,
        completionTokens: 1000,
      }),
    ).toBe(6000);
  });

  test("returns 0 for unknown model id (no throw)", () => {
    expect(
      tokensToMicros("unknown/model", {
        promptTokens: 1000,
        completionTokens: 1000,
      }),
    ).toBe(0);
  });

  test("rounds to integer micros", () => {
    // 1 prompt @ $1/M = 1 micro; 1 completion @ $5/M = 5 micros = 6 total
    expect(
      tokensToMicros("anthropic/claude-haiku-4.5", {
        promptTokens: 1,
        completionTokens: 1,
      }),
    ).toBe(6);
  });

  test("zero usage yields 0", () => {
    expect(
      tokensToMicros("anthropic/claude-sonnet-4.6", {
        promptTokens: 0,
        completionTokens: 0,
      }),
    ).toBe(0);
  });
});
