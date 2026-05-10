import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { agentRuns, specialists, users } from "@/lib/db/schema";
import { BudgetExhaustedError } from "./budget";
import { Run } from "./create";
import {
  dispatchSpecialist,
  dispatchSpecialistsParallel,
  SpecialistDispatchError,
} from "./dispatch";
import { addCostMicros, getRun, updateRunStatus } from "./repository";

const TEST_USER_ID = "test-user-dispatch";

beforeEach(async () => {
  await db.delete(agentRuns);
  await db.delete(specialists);
  await db
    .insert(users)
    .values({
      id: TEST_USER_ID,
      username: "test-dispatch",
      email: "test-dispatch@example.com",
    })
    .onConflictDoNothing();
});

describe("dispatchSpecialist", () => {
  test("scripted echo runs end-to-end", async () => {
    const parent = await Run.create({
      triggerSource: "chat",
      humanOwnerId: TEST_USER_ID,
      budgetUsdCapMicros: 1_000_000,
    });
    await updateRunStatus(parent.id, "running");

    const { childRun, output } = await dispatchSpecialist({
      parentRunId: parent.id,
      specialistName: "echo",
      task: "hello world",
    });

    expect(output).toBe("echo: hello world");
    expect(childRun.parentRunId).toBe(parent.id);
    expect(childRun.rootRunId).toBe(parent.id);
    expect(childRun.depth).toBe(1);
    expect(childRun.specialistId).toBe("echo");
    const refreshed = await getRun(childRun.id);
    expect(refreshed?.status).toBe("completed");
  });

  test("rejects unknown specialist", async () => {
    const parent = await Run.create({
      triggerSource: "chat",
      humanOwnerId: TEST_USER_ID,
      budgetUsdCapMicros: 1_000_000,
    });
    await expect(
      dispatchSpecialist({
        parentRunId: parent.id,
        specialistName: "no-such-specialist",
        task: "x",
      }),
    ).rejects.toThrow(SpecialistDispatchError);
  });

  test("rejects when parent budget exhausted", async () => {
    const parent = await Run.create({
      triggerSource: "chat",
      humanOwnerId: TEST_USER_ID,
      budgetUsdCapMicros: 1_000_000,
    });
    await updateRunStatus(parent.id, "running");
    await addCostMicros(parent.id, 1_000_000);

    await expect(
      dispatchSpecialist({
        parentRunId: parent.id,
        specialistName: "echo",
        task: "x",
      }),
    ).rejects.toThrow(/budget exhausted/i);
  });

  test("rejects when depth would exceed MAX_DEPTH", async () => {
    const parent = await Run.create({
      triggerSource: "chat",
      humanOwnerId: TEST_USER_ID,
      budgetUsdCapMicros: 1_000_000,
    });
    let parentId = parent.id;
    for (let i = 0; i < 5; i++) {
      const child = await Run.create({
        triggerSource: "chained",
        humanOwnerId: TEST_USER_ID,
        parentRunId: parentId,
        budgetUsdCapMicros: 100_000,
      });
      parentId = child.id;
    }

    await expect(
      dispatchSpecialist({
        parentRunId: parentId,
        specialistName: "echo",
        task: "x",
      }),
    ).rejects.toThrow(/depth/i);
  });

  test("returns a string-typed output", async () => {
    const parent = await Run.create({
      triggerSource: "chat",
      humanOwnerId: TEST_USER_ID,
      budgetUsdCapMicros: 1_000_000,
    });
    const result = await dispatchSpecialist({
      parentRunId: parent.id,
      specialistName: "echo",
      task: "test",
    });
    expect(typeof result.output).toBe("string");
  });
});

describe("dispatchSpecialistsParallel", () => {
  test("dispatches multiple specialists in parallel", async () => {
    const parent = await Run.create({
      triggerSource: "chat",
      humanOwnerId: TEST_USER_ID,
      budgetUsdCapMicros: 10_000_000,
    });
    await updateRunStatus(parent.id, "running");

    const results = await dispatchSpecialistsParallel([
      { parentRunId: parent.id, specialistName: "echo", task: "first" },
      { parentRunId: parent.id, specialistName: "echo", task: "second" },
      { parentRunId: parent.id, specialistName: "echo", task: "third" },
    ]);

    expect(results.map((r) => r.output)).toEqual([
      "echo: first",
      "echo: second",
      "echo: third",
    ]);
    const children = results.map((r) => r.childRun.id);
    expect(new Set(children).size).toBe(3);
  });

  test("propagates first failure (Promise.all semantics)", async () => {
    const parent = await Run.create({
      triggerSource: "chat",
      humanOwnerId: TEST_USER_ID,
      budgetUsdCapMicros: 10_000_000,
    });
    await expect(
      dispatchSpecialistsParallel([
        { parentRunId: parent.id, specialistName: "echo", task: "ok" },
        { parentRunId: parent.id, specialistName: "missing", task: "fail" },
      ]),
    ).rejects.toThrow(SpecialistDispatchError);
  });
});

// LLM-driven specialist dispatch (Phase 4b). The DI seam on
// DispatchSpecialistInput.deps lets us drive the orchestration without
// touching the Vercel AI Gateway or Vercel Sandbox.
describe("dispatchSpecialist — LLM specialists", () => {
  const stubbedSandbox = () => ({
    sandbox: {} as never,
    workingDirectory: "/work",
    ownedByThisRun: false,
    toAgentContext: () => ({
      state: { type: "vercel" as const } as never,
      workingDirectory: "/work",
    }),
    stop: async () => undefined,
  });

  test("dispatches coder end-to-end via injected execution", async () => {
    const parent = await Run.create({
      triggerSource: "chat",
      humanOwnerId: TEST_USER_ID,
      budgetUsdCapMicros: 5_000_000,
    });
    await updateRunStatus(parent.id, "running");

    let provisionCount = 0;
    let teardownCount = 0;
    const result = await dispatchSpecialist({
      parentRunId: parent.id,
      specialistName: "coder",
      task: "rename function foo to bar",
      deps: {
        provisionSandboxForRun: async () => {
          provisionCount++;
          return stubbedSandbox();
        },
        teardownSandboxForRun: async () => {
          teardownCount++;
        },
        executeSpecialistViaLLM: async () => ({
          output: "renamed foo to bar in 3 files",
        }),
      },
    });

    expect(result.output).toBe("renamed foo to bar in 3 files");
    expect(provisionCount).toBe(1);
    expect(teardownCount).toBe(1);
    const child = await getRun(result.childRun.id);
    expect(child?.status).toBe("completed");
  });

  test("transitions child to failed and runs teardown when LLM throws", async () => {
    const parent = await Run.create({
      triggerSource: "chat",
      humanOwnerId: TEST_USER_ID,
      budgetUsdCapMicros: 5_000_000,
    });
    await updateRunStatus(parent.id, "running");

    let teardownCount = 0;
    const promise = dispatchSpecialist({
      parentRunId: parent.id,
      specialistName: "coder",
      task: "x",
      deps: {
        provisionSandboxForRun: async () => stubbedSandbox(),
        teardownSandboxForRun: async () => {
          teardownCount++;
        },
        executeSpecialistViaLLM: async () => {
          throw new Error("boom");
        },
      },
    });
    await expect(promise).rejects.toThrow("boom");
    expect(teardownCount).toBe(1);

    // Find the child via parent linkage since the dispatch threw before
    // returning the child run.
    const allChildren = await db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.parentRunId, parent.id));
    expect(allChildren).toHaveLength(1);
    expect(allChildren[0].status).toBe("failed");
  });

  test("transitions child to blocked when LLM throws BudgetExhaustedError", async () => {
    const parent = await Run.create({
      triggerSource: "chat",
      humanOwnerId: TEST_USER_ID,
      budgetUsdCapMicros: 5_000_000,
    });
    await updateRunStatus(parent.id, "running");

    const promise = dispatchSpecialist({
      parentRunId: parent.id,
      specialistName: "coder",
      task: "x",
      deps: {
        provisionSandboxForRun: async () => stubbedSandbox(),
        teardownSandboxForRun: async () => undefined,
        executeSpecialistViaLLM: async () => {
          throw new BudgetExhaustedError("run_root");
        },
      },
    });
    await expect(promise).rejects.toThrow(BudgetExhaustedError);

    const allChildren = await db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.parentRunId, parent.id));
    expect(allChildren).toHaveLength(1);
    expect(allChildren[0].status).toBe("blocked");
    expect(allChildren[0].blockedReason).toBe("budget exhausted");
  });
});
