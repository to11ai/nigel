import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "@/lib/db/client";
import { agentRuns, users } from "@/lib/db/schema";
import { checkRootBudget } from "./budget";
import { Run } from "./create";
import { addCostMicros, getRun, updateRunStatus } from "./repository";

const TEST_USER_ID = "test-user-budget";

beforeEach(async () => {
  await db.delete(agentRuns);
  await db
    .insert(users)
    .values({
      id: TEST_USER_ID,
      username: "test-budget",
      email: "test-budget@example.com",
    })
    .onConflictDoNothing();
});

describe("checkRootBudget", () => {
  test("passes when cost is below cap", async () => {
    const root = await Run.create({
      triggerSource: "chat",
      humanOwnerId: TEST_USER_ID,
      budgetUsdCapMicros: 1_000_000,
    });
    await addCostMicros(root.id, 500_000);
    await expect(checkRootBudget(root.id)).resolves.toBeUndefined();
  });

  test("transitions root to blocked when cost ≥ cap", async () => {
    const root = await Run.create({
      triggerSource: "chat",
      humanOwnerId: TEST_USER_ID,
      budgetUsdCapMicros: 1_000_000,
    });
    await updateRunStatus(root.id, "running");

    await addCostMicros(root.id, 1_000_000);
    await expect(checkRootBudget(root.id)).rejects.toThrow(/budget exhausted/i);

    const blocked = await getRun(root.id);
    expect(blocked?.status).toBe("blocked");
    expect(blocked?.blockedReason).toMatch(/budget exhausted/i);
  });

  test("zero-cap budget passes (treated as unbounded)", async () => {
    const root = await Run.create({
      triggerSource: "chat",
      humanOwnerId: TEST_USER_ID,
      budgetUsdCapMicros: 0,
    });
    await addCostMicros(root.id, 1_000_000_000);
    await expect(checkRootBudget(root.id)).resolves.toBeUndefined();
  });

  test("idempotent on a root that's already blocked", async () => {
    const root = await Run.create({
      triggerSource: "chat",
      humanOwnerId: TEST_USER_ID,
      budgetUsdCapMicros: 1_000_000,
    });
    await updateRunStatus(root.id, "running");
    await addCostMicros(root.id, 1_000_000);

    await expect(checkRootBudget(root.id)).rejects.toThrow(/budget exhausted/i);
    await expect(checkRootBudget(root.id)).rejects.toThrow(/budget exhausted/i);

    const blocked = await getRun(root.id);
    expect(blocked?.status).toBe("blocked");
  });
});
