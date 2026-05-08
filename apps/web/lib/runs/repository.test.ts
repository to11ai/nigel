import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "@/lib/db/client";
import { agentRuns, users } from "@/lib/db/schema";
import { nanoid } from "nanoid";
import { getRun, insertRun, listChildren, updateRunStatus } from "./repository";

const TEST_USER_ID = "test-user-runs-repo";

beforeEach(async () => {
  await db.delete(agentRuns);
  await db
    .insert(users)
    .values({
      id: TEST_USER_ID,
      username: "test-runs-repo",
      email: "test-runs-repo@example.com",
    })
    .onConflictDoNothing();
});

describe("runs repository", () => {
  test("insertRun + getRun roundtrip", async () => {
    const id = nanoid();
    await insertRun({
      id,
      parentRunId: null,
      rootRunId: id,
      depth: 0,
      triggerSource: "chat",
      triggerRef: null,
      humanOwnerId: TEST_USER_ID,
      repoRef: null,
      sandboxPolicy: "inherit",
      budgetUsdCapMicros: 10_000_000,
    });

    const row = await getRun(id);
    expect(row?.id).toBe(id);
    expect(row?.rootRunId).toBe(id);
    expect(row?.status).toBe("pending");
    expect(row?.depth).toBe(0);
  });

  test("listChildren returns direct descendants only", async () => {
    const root = nanoid();
    const child1 = nanoid();
    const child2 = nanoid();
    const grandchild = nanoid();
    await insertRun({
      id: root,
      parentRunId: null,
      rootRunId: root,
      depth: 0,
      triggerSource: "chat",
      humanOwnerId: TEST_USER_ID,
      sandboxPolicy: "inherit",
      budgetUsdCapMicros: 0,
    });
    await insertRun({
      id: child1,
      parentRunId: root,
      rootRunId: root,
      depth: 1,
      triggerSource: "chained",
      humanOwnerId: TEST_USER_ID,
      sandboxPolicy: "inherit",
      budgetUsdCapMicros: 0,
    });
    await insertRun({
      id: child2,
      parentRunId: root,
      rootRunId: root,
      depth: 1,
      triggerSource: "chained",
      humanOwnerId: TEST_USER_ID,
      sandboxPolicy: "inherit",
      budgetUsdCapMicros: 0,
    });
    await insertRun({
      id: grandchild,
      parentRunId: child1,
      rootRunId: root,
      depth: 2,
      triggerSource: "chained",
      humanOwnerId: TEST_USER_ID,
      sandboxPolicy: "inherit",
      budgetUsdCapMicros: 0,
    });

    const children = await listChildren(root);
    const ids = children.map((r) => r.id).sort();
    expect(ids).toEqual([child1, child2].sort());
  });

  test("updateRunStatus enforces state machine", async () => {
    const id = nanoid();
    await insertRun({
      id,
      parentRunId: null,
      rootRunId: id,
      depth: 0,
      triggerSource: "chat",
      humanOwnerId: TEST_USER_ID,
      sandboxPolicy: "inherit",
      budgetUsdCapMicros: 0,
    });

    await updateRunStatus(id, "running");
    const r1 = await getRun(id);
    expect(r1?.status).toBe("running");

    await updateRunStatus(id, "completed");
    const r2 = await getRun(id);
    expect(r2?.status).toBe("completed");

    // Terminal -> running is rejected.
    await expect(updateRunStatus(id, "running")).rejects.toThrow(
      /invalid.*transition/,
    );
  });
});
