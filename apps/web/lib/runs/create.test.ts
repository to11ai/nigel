import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "@/lib/db/client";
import { agentRuns, users } from "@/lib/db/schema";
import { Run } from "./create";

const TEST_USER_ID = "test-user-run-create";

beforeEach(async () => {
  await db.delete(agentRuns);
  await db
    .insert(users)
    .values({
      id: TEST_USER_ID,
      username: "test-run-create",
      email: "test-run-create@example.com",
    })
    .onConflictDoNothing();
});

describe("Run.create", () => {
  test("creates a top-level chat Run", async () => {
    const run = await Run.create({
      triggerSource: "chat",
      humanOwnerId: TEST_USER_ID,
      budgetUsdCapMicros: 10_000_000,
    });

    expect(run.parentRunId).toBeNull();
    expect(run.rootRunId).toBe(run.id);
    expect(run.depth).toBe(0);
    expect(run.status).toBe("pending");
  });

  test("creates a chained child Run with depth=1", async () => {
    const parent = await Run.create({
      triggerSource: "chat",
      humanOwnerId: TEST_USER_ID,
      budgetUsdCapMicros: 10_000_000,
    });

    const child = await Run.create({
      triggerSource: "chained",
      humanOwnerId: TEST_USER_ID,
      parentRunId: parent.id,
      budgetUsdCapMicros: 1_000_000,
    });

    expect(child.parentRunId).toBe(parent.id);
    expect(child.rootRunId).toBe(parent.id);
    expect(child.depth).toBe(1);
  });

  test("rejects creation past MAX_DEPTH", async () => {
    let parent = await Run.create({
      triggerSource: "chat",
      humanOwnerId: TEST_USER_ID,
      budgetUsdCapMicros: 10_000_000,
    });
    let parentId: string = parent.id;

    // Create depth 1..5 (5 levels of children).
    for (let i = 0; i < 5; i++) {
      const next = await Run.create({
        triggerSource: "chained",
        humanOwnerId: TEST_USER_ID,
        parentRunId: parentId,
        budgetUsdCapMicros: 1_000_000,
      });
      parentId = next.id;
      expect(next.depth).toBe(i + 1);
    }

    // Depth 6 must be rejected.
    await expect(
      Run.create({
        triggerSource: "chained",
        humanOwnerId: TEST_USER_ID,
        parentRunId: parentId,
        budgetUsdCapMicros: 1_000_000,
      }),
    ).rejects.toThrow(/depth/i);
  });

  test("rejects child with non-existent parent", async () => {
    await expect(
      Run.create({
        triggerSource: "chained",
        humanOwnerId: TEST_USER_ID,
        parentRunId: "does-not-exist",
        budgetUsdCapMicros: 1_000_000,
      }),
    ).rejects.toThrow(/parent.*not found/i);
  });

  test("requires parentRunId for chained trigger source", async () => {
    await expect(
      Run.create({
        triggerSource: "chained",
        humanOwnerId: TEST_USER_ID,
        budgetUsdCapMicros: 1_000_000,
      }),
    ).rejects.toThrow(/parent.*required/i);
  });
});
