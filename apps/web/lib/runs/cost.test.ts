import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "@/lib/db/client";
import { agentRuns, users } from "@/lib/db/schema";
import { computeCostMicros, PRICING } from "./cost";
import { Run } from "./create";
import { addCostMicros, getRun } from "./repository";

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

const TEST_USER_ID = "test-user-cost-rollup";

describe("cost rollup trigger", () => {
  beforeEach(async () => {
    await db.delete(agentRuns);
    await db
      .insert(users)
      .values({
        id: TEST_USER_ID,
        username: "test-cost-rollup",
        email: "test-cost-rollup@example.com",
      })
      .onConflictDoNothing();
  });

  test("child cost increments root cost", async () => {
    const root = await Run.create({
      triggerSource: "chat",
      humanOwnerId: TEST_USER_ID,
      budgetUsdCapMicros: 10_000_000,
    });
    const child = await Run.create({
      triggerSource: "chained",
      humanOwnerId: TEST_USER_ID,
      parentRunId: root.id,
      budgetUsdCapMicros: 1_000_000,
    });

    await addCostMicros(child.id, 250_000);

    const rootAfter = await getRun(root.id);
    expect(rootAfter?.costUsdActual).toBe(250_000);
  });

  test("multiple children sum on root", async () => {
    const root = await Run.create({
      triggerSource: "chat",
      humanOwnerId: TEST_USER_ID,
      budgetUsdCapMicros: 10_000_000,
    });
    const c1 = await Run.create({
      triggerSource: "chained",
      humanOwnerId: TEST_USER_ID,
      parentRunId: root.id,
      budgetUsdCapMicros: 1_000_000,
    });
    const c2 = await Run.create({
      triggerSource: "chained",
      humanOwnerId: TEST_USER_ID,
      parentRunId: root.id,
      budgetUsdCapMicros: 1_000_000,
    });

    await addCostMicros(c1.id, 100_000);
    await addCostMicros(c2.id, 200_000);

    const rootAfter = await getRun(root.id);
    expect(rootAfter?.costUsdActual).toBe(300_000);
  });

  test("grandchild cost reaches root via single hop (root_run_id is denormalized)", async () => {
    const root = await Run.create({
      triggerSource: "chat",
      humanOwnerId: TEST_USER_ID,
      budgetUsdCapMicros: 10_000_000,
    });
    const child = await Run.create({
      triggerSource: "chained",
      humanOwnerId: TEST_USER_ID,
      parentRunId: root.id,
      budgetUsdCapMicros: 1_000_000,
    });
    const grandchild = await Run.create({
      triggerSource: "chained",
      humanOwnerId: TEST_USER_ID,
      parentRunId: child.id,
      budgetUsdCapMicros: 1_000_000,
    });

    await addCostMicros(grandchild.id, 500_000);

    const rootAfter = await getRun(root.id);
    expect(rootAfter?.costUsdActual).toBe(500_000);
  });

  test("self-update on root row does not double-count", async () => {
    const root = await Run.create({
      triggerSource: "chat",
      humanOwnerId: TEST_USER_ID,
      budgetUsdCapMicros: 10_000_000,
    });

    await addCostMicros(root.id, 1_000_000);

    const rootAfter = await getRun(root.id);
    expect(rootAfter?.costUsdActual).toBe(1_000_000);
  });
});
