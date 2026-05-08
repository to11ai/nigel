import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "@/lib/db/client";
import { agentRuns, specialists, users } from "@/lib/db/schema";
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
