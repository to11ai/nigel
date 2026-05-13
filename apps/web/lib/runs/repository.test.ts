import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "@/lib/db/client";
import { agentRuns, users } from "@/lib/db/schema";
import { nanoid } from "nanoid";
import {
  addCostMicros,
  getRun,
  insertRun,
  listChildren,
  listRootRunsForUser,
  updateRunStatus,
} from "./repository";

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

  // Filter coverage for the /runs index. Each test seeds a small
  // root-run set and asserts the filter narrows correctly.
  describe("listRootRunsForUser filters", () => {
    async function seedRoot(input: {
      specialistId?: string;
      triggerSource?: "chat" | "linear" | "chained" | "cron";
      status?: "pending" | "running" | "completed" | "failed";
      costMicros?: number;
    }): Promise<string> {
      const id = nanoid();
      await insertRun({
        id,
        parentRunId: null,
        rootRunId: id,
        depth: 0,
        triggerSource: input.triggerSource ?? "chat",
        humanOwnerId: TEST_USER_ID,
        sandboxPolicy: "inherit",
        budgetUsdCapMicros: 10_000_000,
        ...(input.specialistId !== undefined
          ? { specialistId: input.specialistId }
          : {}),
      });
      if (input.status && input.status !== "pending") {
        // The default insert leaves status='pending'. Walk forward
        // through valid transitions to reach the requested terminal.
        await updateRunStatus(id, "running");
        if (input.status !== "running") {
          await updateRunStatus(id, input.status);
        }
      }
      if (input.costMicros && input.costMicros > 0) {
        await addCostMicros(id, input.costMicros);
      }
      return id;
    }

    test("filters by specialistId", async () => {
      const a = await seedRoot({ specialistId: "planner" });
      await seedRoot({ specialistId: "coder" });
      const out = await listRootRunsForUser({
        userId: TEST_USER_ID,
        specialistId: "planner",
      });
      expect(out.map((r) => r.id)).toEqual([a]);
    });

    test("filters by status", async () => {
      const a = await seedRoot({ status: "running" });
      await seedRoot({ status: "pending" });
      const out = await listRootRunsForUser({
        userId: TEST_USER_ID,
        status: "running",
      });
      expect(out.map((r) => r.id)).toEqual([a]);
    });

    test("filters by triggerSource", async () => {
      const a = await seedRoot({ triggerSource: "linear" });
      await seedRoot({ triggerSource: "chat" });
      const out = await listRootRunsForUser({
        userId: TEST_USER_ID,
        triggerSource: "linear",
      });
      expect(out.map((r) => r.id)).toEqual([a]);
    });

    test("filters by minCostMicros (inclusive)", async () => {
      const cheap = await seedRoot({ costMicros: 100 });
      const expensive = await seedRoot({ costMicros: 5_000_000 });
      const out = await listRootRunsForUser({
        userId: TEST_USER_ID,
        minCostMicros: 1_000_000,
      });
      expect(out.map((r) => r.id)).toContain(expensive);
      expect(out.map((r) => r.id)).not.toContain(cheap);
    });

    test("minCostMicros<=0 is a no-op (matches all)", async () => {
      const a = await seedRoot({ costMicros: 0 });
      const b = await seedRoot({ costMicros: 100 });
      const out = await listRootRunsForUser({
        userId: TEST_USER_ID,
        minCostMicros: 0,
      });
      const ids = out.map((r) => r.id);
      expect(ids).toContain(a);
      expect(ids).toContain(b);
    });

    test("combines filters with AND", async () => {
      const match = await seedRoot({
        specialistId: "planner",
        status: "running",
      });
      await seedRoot({ specialistId: "planner", status: "pending" });
      await seedRoot({ specialistId: "coder", status: "running" });
      const out = await listRootRunsForUser({
        userId: TEST_USER_ID,
        specialistId: "planner",
        status: "running",
      });
      expect(out.map((r) => r.id)).toEqual([match]);
    });
  });
});
