import type {
  Pipeline,
  PipelinePhase,
  PipelinePhaseStep,
} from "@/lib/repo-config";
import type { SandboxPolicy } from "./types";

// Deterministic executor for a declarative `.nigel.yaml` pipeline. Replaces
// the hardcoded single-planner entry (`linear-trigger.ts`) with a code-driven
// phase loop: each phase dispatches one or more specialists as isolated child
// Runs, gates are enforced here (a required gate that fails halts the pipeline
// — `publish` is structurally unreachable if `validate` failed), and `when`
// predicates branch the flow. The dispatch + sandbox + budget mechanics are
// reused from `dispatchSpecialist`; this module only owns sequencing + gates.

const USD_TO_MICROS = 1_000_000;

export type PhaseDispatchArgs = {
  specialistName: string;
  task: string;
  sandboxPolicyOverride?: SandboxPolicy;
  localStackProfile?: string;
  budgetUsdMicros?: number;
};

// A phase passes iff `ok` is true. The real adapter derives `ok` from the
// child Run reaching `completed` (vs `failed`/`blocked`); a thrown dispatch
// error must be mapped to `{ ok: false }` by the adapter, not propagated.
export type PhaseDispatchResult = {
  ok: boolean;
  output: string;
  runId: string;
};

export type PhaseDispatch = (
  args: PhaseDispatchArgs,
) => Promise<PhaseDispatchResult>;

// Caller-seeded facts that `when` predicates read (e.g. whether the diff
// touches frontend globs, the bug/feature classification). A phase's `sets`
// writes its output here for later phases.
export type PipelineSignals = Record<string, string | boolean>;

export type PredicateEval = (when: string, signals: PipelineSignals) => boolean;

export type PipelineRunnerDeps = {
  dispatch: PhaseDispatch;
  // Invoked once when a required gate fails, before the runner returns
  // `blocked`. Maps to `transitionRunStatus(rootRunId, status, reason)`.
  onBlocked: (input: {
    phaseId: string;
    status: "blocked" | "awaiting_approval";
    reason: string;
  }) => Promise<void>;
  evalPredicate?: PredicateEval;
};

export type PipelineRunResult = {
  status: "completed" | "blocked";
  completedPhases: string[];
  skippedPhases: string[];
  blockedPhase?: { id: string; reason: string };
};

// Built-in predicates. Unknown predicates fail closed (phase skipped) so a
// typo can never silently run a gated phase it shouldn't.
export function defaultEvalPredicate(
  when: string,
  signals: PipelineSignals,
): boolean {
  if (when === "always") {
    return true;
  }
  if (when === "touches_frontend") {
    return signals.touchesFrontend === true;
  }
  if (when.startsWith("classification:")) {
    return signals.classification === when.slice("classification:".length);
  }
  return false;
}

// Expand a phase into the steps to dispatch: a `parallel` block runs its
// steps concurrently; otherwise the single inline specialist.
function resolveSteps(phase: PipelinePhase): PipelinePhaseStep[] {
  if (phase.parallel) {
    return phase.parallel;
  }
  // The XOR refine in the schema guarantees `specialist` is set here.
  return [
    {
      specialist: phase.specialist as string,
      sandbox_policy: phase.sandbox_policy,
      local_stack_profile: phase.local_stack_profile,
      budget_usd: phase.budget_usd,
    },
  ];
}

function toDispatchArgs(
  step: PipelinePhaseStep,
  phase: PipelinePhase,
  task: string,
): PhaseDispatchArgs {
  return {
    specialistName: step.specialist,
    task,
    // `independent` forces an isolated, context-free sandbox regardless of
    // the declared policy — the in-code independence guarantee.
    sandboxPolicyOverride: phase.independent
      ? "fresh_clean"
      : step.sandbox_policy,
    localStackProfile: step.local_stack_profile,
    budgetUsdMicros:
      step.budget_usd === undefined
        ? undefined
        : Math.round(step.budget_usd * USD_TO_MICROS),
  };
}

export async function runPipeline(input: {
  pipeline: Pipeline;
  task: string;
  signals?: PipelineSignals;
  deps: PipelineRunnerDeps;
}): Promise<PipelineRunResult> {
  const { pipeline, task, deps } = input;
  const evalPredicate = deps.evalPredicate ?? defaultEvalPredicate;
  const signals: PipelineSignals = { ...input.signals };
  const completedPhases: string[] = [];
  const skippedPhases: string[] = [];

  for (const phase of pipeline.phases) {
    if (phase.when && !evalPredicate(phase.when, signals)) {
      skippedPhases.push(phase.id);
      continue;
    }

    const steps = resolveSteps(phase);
    // A phase with no explicit gate is treated as required/stop — the safe
    // default for a process where skipping a phase must be deliberate.
    const onFail = phase.gate?.on_fail ?? "stop";
    const required = phase.gate?.required ?? true;
    const maxRepairs = onFail === "repair" ? (phase.gate?.max_repairs ?? 1) : 0;

    let results: PhaseDispatchResult[] = [];
    let passed = false;
    for (let attempt = 0; attempt <= maxRepairs; attempt++) {
      results = await Promise.all(
        steps.map((step) => deps.dispatch(toDispatchArgs(step, phase, task))),
      );
      if (results.every((r) => r.ok)) {
        passed = true;
        break;
      }
      // Repair: dispatch the fixer, then re-run the phase. The fixer's own
      // failure doesn't short-circuit — the re-run is the source of truth.
      if (attempt < maxRepairs && phase.gate?.repair_with) {
        await deps.dispatch({
          specialistName: phase.gate.repair_with,
          task: `Repair the failures from phase "${phase.id}" so it can pass, then stop.`,
        });
      }
    }

    if (!passed) {
      if (onFail === "continue" || !required) {
        // Non-blocking failure: record nothing special, move on.
        completedPhases.push(phase.id);
        continue;
      }
      const reason = `phase "${phase.id}" failed its required gate`;
      await deps.onBlocked({ phaseId: phase.id, status: "blocked", reason });
      return {
        status: "blocked",
        completedPhases,
        skippedPhases,
        blockedPhase: { id: phase.id, reason },
      };
    }

    completedPhases.push(phase.id);
    if (phase.sets) {
      signals[phase.sets] = results[0]?.output ?? "";
    }
  }

  return { status: "completed", completedPhases, skippedPhases };
}
