import { describe, expect, test } from "bun:test";
import { computeCostMicros, PRICING } from "./cost";

describe("PRICING table", () => {
  test("contains the three current Anthropic models", () => {
    expect(PRICING).toHaveProperty("anthropic/claude-opus-4-7");
    expect(PRICING).toHaveProperty("anthropic/claude-sonnet-4-6");
    expect(PRICING).toHaveProperty("anthropic/claude-haiku-4-5");
  });
});

describe("computeCostMicros", () => {
  test("haiku 1000 input + 500 output = 2800 micros", () => {
    // haiku: 0.80 in / 4.00 out per 1M tokens
    // input: 1000 * 0.80 = 800 micros
    // output: 500 * 4.00 = 2000 micros
    // total: 2800 micros
    expect(
      computeCostMicros("anthropic/claude-haiku-4-5", {
        inputTokens: 1000,
        outputTokens: 500,
      }),
    ).toBe(2800);
  });

  test("cache reads use cache_read price", () => {
    // haiku: cache_read 0.08 per 1M tokens
    // 10000 cache reads * 0.08 = 800 micros
    expect(
      computeCostMicros("anthropic/claude-haiku-4-5", {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 10000,
      }),
    ).toBe(800);
  });

  test("unknown model throws", () => {
    expect(() =>
      computeCostMicros("anthropic/claude-imaginary", {
        inputTokens: 1,
        outputTokens: 1,
      }),
    ).toThrow(/unknown model/);
  });

  test("zero tokens returns zero", () => {
    expect(
      computeCostMicros("anthropic/claude-haiku-4-5", {
        inputTokens: 0,
        outputTokens: 0,
      }),
    ).toBe(0);
  });
});
