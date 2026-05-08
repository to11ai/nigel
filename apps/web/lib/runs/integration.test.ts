import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "@/lib/db/client";
import { agentRuns, users } from "@/lib/db/schema";
import { addCostMicros, getRun, Run, updateRunStatus } from "./index";

const TEST_USER_ID = "test-user-runs-integration";

beforeEach(async () => {
  await db.delete(agentRuns);
  await db
    .insert(users)
    .values({
      id: TEST_USER_ID,
      username: "test-runs-integration",
      email: "test-runs-integration@example.com",
    })
    .onConflictDoNothing();
});

describe("runs end-to-end", () => {
  test("happy path: create top-level + child + transitions + cost rollup", async () => {
    const root = await Run.create({
      triggerSource: "chat",
      humanOwnerId: TEST_USER_ID,
      budgetUsdCapMicros: 10_000_000,
    });
    expect(root.status).toBe("pending");

    await updateRunStatus(root.id, "running");
    expect((await getRun(root.id))?.status).toBe("running");

    const child = await Run.create({
      triggerSource: "chained",
      humanOwnerId: TEST_USER_ID,
      parentRunId: root.id,
      budgetUsdCapMicros: 1_000_000,
    });
    await updateRunStatus(child.id, "running");
    await addCostMicros(child.id, 750_000);
    await updateRunStatus(child.id, "completed");

    const childAfter = await getRun(child.id);
    expect(childAfter?.status).toBe("completed");
    expect(childAfter?.endedAt).toBeTruthy();

    await updateRunStatus(root.id, "completed");
    const rootAfter = await getRun(root.id);
    expect(rootAfter?.status).toBe("completed");
    expect(rootAfter?.costUsdActual).toBe(750_000);
  });

  test("blocked → resume cycle", async () => {
    const root = await Run.create({
      triggerSource: "chat",
      humanOwnerId: TEST_USER_ID,
      budgetUsdCapMicros: 10_000_000,
    });
    await updateRunStatus(root.id, "running");
    await updateRunStatus(root.id, "blocked", { blockedReason: "budget" });

    const blocked = await getRun(root.id);
    expect(blocked?.status).toBe("blocked");
    expect(blocked?.blockedReason).toBe("budget");

    await updateRunStatus(root.id, "running");
    expect((await getRun(root.id))?.status).toBe("running");
  });

  test("cancelled root does not auto-cancel children (Phase 1: no cascade)", async () => {
    // Cascade cancel is Phase 9 work; Phase 1 only enforces state machine
    // on individual runs. Document the absence with a test.
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
    await updateRunStatus(root.id, "running");
    await updateRunStatus(child.id, "running");
    await updateRunStatus(root.id, "cancelled");

    const childAfter = await getRun(child.id);
    expect(childAfter?.status).toBe("running");
  });
});
