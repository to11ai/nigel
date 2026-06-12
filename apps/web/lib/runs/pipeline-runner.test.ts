import { describe, expect, test } from "bun:test";
import type { Pipeline } from "@/lib/repo-config";
import {
  defaultEvalPredicate,
  type PhaseDispatch,
  type PhaseDispatchArgs,
  type PipelineRunnerDeps,
  runPipeline,
} from "./pipeline-runner";

type BlockedCall = { phaseId: string; status: string; reason: string };

// Mock dispatch: `ok(args) => boolean` decides pass/fail per call; every call
// is recorded for assertions.
function makeDeps(
  ok: (args: PhaseDispatchArgs, callIndex: number) => boolean = () => true,
): {
  deps: PipelineRunnerDeps;
  calls: PhaseDispatchArgs[];
  blocked: BlockedCall[];
} {
  const calls: PhaseDispatchArgs[] = [];
  const blocked: BlockedCall[] = [];
  const dispatch: PhaseDispatch = async (args) => {
    const index = calls.length;
    calls.push(args);
    return {
      ok: ok(args, index),
      output: `out:${args.specialistName}`,
      runId: `run-${index}`,
    };
  };
  return {
    deps: {
      dispatch,
      onBlocked: async (b) => {
        blocked.push(b);
      },
    },
    calls,
    blocked,
  };
}

const pipeline = (phases: Pipeline["phases"]): Pipeline => ({ phases });

describe("runPipeline", () => {
  test("runs phases in declared order when all gates pass", async () => {
    const { deps, calls } = makeDeps();
    const result = await runPipeline({
      task: "t",
      deps,
      pipeline: pipeline([
        { id: "implement", specialist: "coder", independent: false },
        {
          id: "validate",
          specialist: "adversarial-reviewer",
          independent: false,
        },
      ]),
    });
    expect(result.status).toBe("completed");
    expect(result.completedPhases).toEqual(["implement", "validate"]);
    expect(calls.map((c) => c.specialistName)).toEqual([
      "coder",
      "adversarial-reviewer",
    ]);
  });

  test("independent phase forces fresh_clean sandbox", async () => {
    const { deps, calls } = makeDeps();
    await runPipeline({
      task: "t",
      deps,
      pipeline: pipeline([
        {
          id: "validate",
          specialist: "adversarial-reviewer",
          sandbox_policy: "inherit",
          independent: true,
        },
      ]),
    });
    expect(calls[0]?.sandboxPolicyOverride).toBe("fresh_clean");
  });

  test("budget_usd is converted to micros", async () => {
    const { deps, calls } = makeDeps();
    await runPipeline({
      task: "t",
      deps,
      pipeline: pipeline([
        {
          id: "implement",
          specialist: "coder",
          budget_usd: 5,
          independent: false,
        },
      ]),
    });
    expect(calls[0]?.budgetUsdMicros).toBe(5_000_000);
  });

  test("parallel phase dispatches all steps", async () => {
    const { deps, calls } = makeDeps();
    await runPipeline({
      task: "t",
      deps,
      pipeline: pipeline([
        {
          id: "checks",
          independent: false,
          parallel: [
            { specialist: "linter", sandbox_policy: "fresh" },
            { specialist: "type-checker", sandbox_policy: "fresh" },
            {
              specialist: "e2e-tester",
              sandbox_policy: "fresh",
              local_stack_profile: "e2e",
            },
          ],
        },
      ]),
    });
    expect(calls.map((c) => c.specialistName).sort()).toEqual([
      "e2e-tester",
      "linter",
      "type-checker",
    ]);
    expect(
      calls.find((c) => c.specialistName === "e2e-tester")?.localStackProfile,
    ).toBe("e2e");
  });

  test("a required gate failure (default, no gate) blocks and stops the pipeline", async () => {
    const { deps, calls, blocked } = makeDeps(
      (args) => args.specialistName !== "adversarial-reviewer",
    );
    const result = await runPipeline({
      task: "t",
      deps,
      pipeline: pipeline([
        { id: "implement", specialist: "coder", independent: false },
        {
          id: "validate",
          specialist: "adversarial-reviewer",
          independent: false,
        },
        { id: "publish", specialist: "publish-proof", independent: false },
      ]),
    });
    expect(result.status).toBe("blocked");
    expect(result.blockedPhase?.id).toBe("validate");
    expect(blocked[0]?.status).toBe("blocked");
    // `publish` must be unreachable after a failed required gate.
    expect(calls.some((c) => c.specialistName === "publish-proof")).toBe(false);
  });

  test("on_fail: continue proceeds past a failure", async () => {
    const { deps, calls } = makeDeps(
      (args) => args.specialistName !== "reviewer",
    );
    const result = await runPipeline({
      task: "t",
      deps,
      pipeline: pipeline([
        {
          id: "review",
          specialist: "reviewer",
          independent: false,
          gate: { required: true, on_fail: "continue" },
        },
        { id: "publish", specialist: "publish-proof", independent: false },
      ]),
    });
    expect(result.status).toBe("completed");
    expect(calls.some((c) => c.specialistName === "publish-proof")).toBe(true);
  });

  test("on_fail: repair dispatches the fixer then re-runs, passing on retry", async () => {
    // checks fail on first attempt, pass after the repair re-run.
    let checksAttempts = 0;
    const { deps, calls } = makeDeps((args) => {
      if (args.specialistName === "linter") {
        checksAttempts++;
        return checksAttempts > 1; // fail attempt 1, pass attempt 2
      }
      return true;
    });
    const result = await runPipeline({
      task: "t",
      deps,
      pipeline: pipeline([
        {
          id: "checks",
          specialist: "linter",
          independent: false,
          gate: {
            required: true,
            on_fail: "repair",
            max_repairs: 2,
            repair_with: "coder",
          },
        },
      ]),
    });
    expect(result.status).toBe("completed");
    // linter ×2 (fail, pass) + coder repair ×1
    expect(calls.filter((c) => c.specialistName === "linter")).toHaveLength(2);
    expect(calls.filter((c) => c.specialistName === "coder")).toHaveLength(1);
    // the repair task names the failed step (not just the phase id)
    const repairCall = calls.find((c) => c.specialistName === "coder");
    expect(repairCall?.task).toContain("linter");
  });

  test("when predicate skips a phase; sets feeds later predicates", async () => {
    const { deps, calls } = makeDeps();
    const result = await runPipeline({
      task: "t",
      signals: { touchesFrontend: false },
      deps,
      pipeline: pipeline([
        {
          id: "ui-proof",
          specialist: "visual-prover",
          independent: false,
          when: "touches_frontend",
        },
        { id: "implement", specialist: "coder", independent: false },
      ]),
    });
    expect(result.skippedPhases).toEqual(["ui-proof"]);
    expect(calls.some((c) => c.specialistName === "visual-prover")).toBe(false);
  });
});

describe("defaultEvalPredicate", () => {
  test("always / touches_frontend / classification / unknown-fails-closed", () => {
    expect(defaultEvalPredicate("always", {})).toBe(true);
    expect(
      defaultEvalPredicate("touches_frontend", { touchesFrontend: true }),
    ).toBe(true);
    expect(
      defaultEvalPredicate("touches_frontend", { touchesFrontend: false }),
    ).toBe(false);
    expect(
      defaultEvalPredicate("classification:bug", { classification: "bug" }),
    ).toBe(true);
    expect(
      defaultEvalPredicate("classification:bug", { classification: "feature" }),
    ).toBe(false);
    expect(defaultEvalPredicate("totally-unknown", { x: true })).toBe(false);
  });
});
