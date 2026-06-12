// Phase 6 L2b: workflow that executes a Linear-triggered Run.
//
// Lifecycle:
//   1. webhook handler creates an `agent_runs` row with status='pending',
//      triggerSource='linear', specialistId='planner', and starts this
//      workflow with the run id + the task text (issue title + body).
//   2. this workflow transitions the run to 'running', provisions a
//      fresh sandbox (cloned to the run's repoRef), executes the
//      planner via `executeSpecialistViaLLM`, and transitions to
//      'completed' or 'failed'.
//   3. sandbox teardown happens in `finally` regardless of outcome.
//
// Each side-effecting helper is a `"use step"` so the Workflow SDK
// can checkpoint between them and resume across a kill -9. The
// imports inside the steps are dynamic — same pattern the chat
// workflow uses — to keep the workflow module's top-level surface
// small so the SDK's serialization works.

import type { Pipeline } from "@/lib/repo-config";
import type { SandboxState } from "@nigel/sandbox";

export type LinearTriggerWorkflowInput = {
  agentRunId: string;
  // The task description handed to the planner. Built by the
  // webhook handler from the issue title + description (and
  // potentially other ticket context).
  taskText: string;
  // Branch to clone. Omitted by the webhook handler today —
  // `provisionFreshSandboxForRun` then resolves the repo's
  // default_branch via `repos.get`, which correctly handles
  // repos whose default is `master`, `develop`, etc. Future
  // extensions (label-based branch hints, comment commands)
  // would supply this directly.
  branch?: string;
};

// Outcome discriminator for `markRunRunning`. The workflow needs
// to distinguish three cases:
//   - `transitioned`: was `pending`, now `running`. Proceed.
//   - `already_running`: re-entry from a Workflow SDK step replay
//     after a kill -9. Proceed; the planner work needs to run.
//   - `not_runnable`: the run is in a state that should NOT
//     trigger execution. This covers terminals (`completed`,
//     `failed`, `cancelled`) plus human-waited states (`blocked`,
//     `awaiting_approval`) where the workflow proceeding would
//     produce duplicate work — a blocked run might already have
//     been picked up by a different process responding to the
//     unblock signal. Abort regardless of the exact status.
type MarkRunOutcome = "transitioned" | "already_running" | "not_runnable";

const markRunRunning = async (agentRunId: string): Promise<MarkRunOutcome> => {
  "use step";
  const { getRun, updateRunStatus } = await import("@/lib/runs/repository");
  const current = await getRun(agentRunId);
  if (!current) {
    throw new Error(`agent_run not found: ${agentRunId}`);
  }
  if (current.status === "running") return "already_running";
  if (
    current.status === "completed" ||
    current.status === "failed" ||
    current.status === "cancelled" ||
    current.status === "blocked" ||
    current.status === "awaiting_approval"
  ) {
    return "not_runnable";
  }
  await updateRunStatus(agentRunId, "running");
  return "transitioned";
};

const markRunTerminal = async (
  agentRunId: string,
  next: "completed" | "failed",
): Promise<void> => {
  "use step";
  const { updateRunStatus } = await import("@/lib/runs/repository");
  try {
    await updateRunStatus(agentRunId, next);
  } catch (err) {
    // Status machine rejects the transition (already terminal in a
    // prior step run, etc.). Don't fail the workflow over a
    // bookkeeping error; log so ops sees it.
    console.error("[linear-trigger] run status update failed", {
      agentRunId,
      next,
      err,
    });
  }
};

// KNOWN LIMITATION (Phase 9 hardening): this step bundles provision +
// execute + teardown. If the worker process dies mid-execute, the
// `finally` doesn't fire and the sandbox leaks. On Workflow SDK
// resume, the step replays from the start and provisions a fresh
// sandbox while the previous one stays alive.
//
// Mitigation: the Vercel sandbox SDK has a 5-minute default
// activity timeout, so an orphaned sandbox auto-stops within ~5
// minutes — bounded blast radius, not a permanent leak. The
// proper fix is to split into separate `"use step"` functions
// (provision returns a serializable sandbox name → execute
// reconnects by name → teardown) so a resumed workflow can pick
// up the existing sandbox. That refactor requires `ProvisionedSandbox`
// to return a serializable handle shape and is deferred to the
// Phase 9 failure-mode drills.
// Returns the terminal status the run should land in: "completed" when the
// work finished, "blocked" when a declarative-pipeline gate halted it (the
// run was already transitioned to `blocked` here; the caller must NOT then
// mark it `completed`).
const executeRunStep = async (input: {
  agentRunId: string;
  taskText: string;
  branch?: string;
}): Promise<"completed" | "blocked"> => {
  "use step";
  const { getRun } = await import("@/lib/runs/repository");
  const { provisionFreshSandboxForRun, teardownSandboxForRun } =
    await import("@/lib/runs/sandbox-coordinator");
  const { getSpecialist } = await import("@/lib/specialists");
  const { executeSpecialistViaLLM } =
    await import("@/lib/runs/specialist-execution");

  const run = await getRun(input.agentRunId);
  if (!run) {
    throw new Error(`agent_run not found: ${input.agentRunId}`);
  }
  if (!run.repoRef) {
    throw new Error(`agent_run ${input.agentRunId} has no repoRef`);
  }
  if (!run.humanOwnerId) {
    throw new Error(`agent_run ${input.agentRunId} has no humanOwnerId`);
  }

  // Phase-marker thought before sandbox provisioning: a fresh
  // Vercel Sandbox + repo clone routinely takes 10-30s and emits
  // nothing visible. Without a marker the Linear session panel
  // shows the `Picked up by Nigel` comment, then a long silence
  // before the first specialist step lands — the user can't tell
  // whether work is happening or the run wedged. Fire-and-forget;
  // a Linear API hiccup must not abort the workflow.
  await postProvisioningMarker({
    linearAgentSessionId: run.linearAgentSessionId,
    repoRef: run.repoRef,
    branch: input.branch,
  });

  const sandbox = await provisionFreshSandboxForRun({
    repoRef: run.repoRef,
    // Omit branch → `provisionFreshSandboxForRun` resolves the
    // repo's default_branch via `repos.get`. Only forward when
    // the caller explicitly supplied one.
    ...(input.branch !== undefined ? { branch: input.branch } : {}),
    humanOwnerId: run.humanOwnerId,
  });
  try {
    const { loadRepoConfigFromSandbox } =
      await import("@/lib/runs/repo-config-from-sandbox");
    // No `.catch` fallback: an absent `.nigel.yaml` yields an inferred
    // config (no pipeline → planner path below), while a *malformed* one
    // throws — and that must fail the run loudly rather than silently
    // running the legacy planner against a repo that declared a pipeline.
    const config = await loadRepoConfigFromSandbox({
      repoFullName: run.repoRef,
      workingDirectory: sandbox.workingDirectory,
      exec: (command, cwd, timeoutMs, options) =>
        sandbox.sandbox.exec(command, cwd, timeoutMs, options),
    });

    // Declarative pipeline: execute phases deterministically with gates.
    if (config.pipeline) {
      return await runRepoPipeline({
        runId: run.id,
        sandboxState: sandbox.toAgentContext().state,
        pipeline: config.pipeline,
        task: input.taskText,
      });
    }

    // Default path (no `pipeline` in .nigel.yaml): the single planner agent,
    // exactly as before — preserves backward compatibility for every repo
    // that hasn't opted into a pipeline.
    const planner = await getSpecialist("planner");
    if (!planner) {
      throw new Error("planner specialist not found in registry");
    }
    await executeSpecialistViaLLM({
      run,
      sandbox: sandbox.toAgentContext(),
      specialist: planner,
      task: input.taskText,
    });
    return "completed";
  } finally {
    await teardownSandboxForRun(sandbox).catch((err) => {
      console.error("[linear-trigger] sandbox teardown failed", {
        agentRunId: input.agentRunId,
        err,
      });
    });
  }
};

// Adapter: run the repo's declarative pipeline by dispatching each phase as
// a child Run via `dispatchSpecialist` (the same primitive the planner's
// `dispatch_specialist` tool uses). A phase passes iff its child Run reaches
// `completed`; a thrown dispatch error maps to a failed phase, not a crash.
//
// v1 limitations (tracked for follow-up):
//  - `signals` is seeded empty, so `when` predicates that depend on the diff
//    (e.g. `touches_frontend`) evaluate false and those phases are skipped —
//    logged, not silent. Seeding from the post-implement diff is follow-up.
//  - per-phase `local_stack_profile` is not yet plumbed (dispatchSpecialist
//    has no such override); the profile falls back to resolver defaults.
//  - `on_terminal` (babysit / finalize) is not yet wired here.
async function runRepoPipeline(input: {
  runId: string;
  sandboxState: SandboxState;
  pipeline: Pipeline;
  task: string;
}): Promise<"completed" | "blocked"> {
  const { runPipeline } = await import("@/lib/runs/pipeline-runner");
  const { dispatchSpecialist } = await import("@/lib/runs/dispatch");
  const { shouldForwardInheritedSandbox } =
    await import("@/lib/runs/specialist-execution");
  const { updateRunStatus } = await import("@/lib/runs/repository");

  const result = await runPipeline({
    pipeline: input.pipeline,
    task: input.task,
    signals: {},
    deps: {
      dispatch: async (args) => {
        try {
          const dispatched = await dispatchSpecialist({
            parentRunId: input.runId,
            specialistName: args.specialistName,
            task: args.task,
            ...(args.budgetUsdMicros !== undefined
              ? { budgetUsdMicros: args.budgetUsdMicros }
              : {}),
            ...(args.sandboxPolicyOverride !== undefined
              ? { sandboxPolicyOverride: args.sandboxPolicyOverride }
              : {}),
            ...(shouldForwardInheritedSandbox(
              input.sandboxState,
              args.sandboxPolicyOverride,
            )
              ? { inheritSandboxState: input.sandboxState }
              : {}),
          });
          return {
            ok: dispatched.childRun.status === "completed",
            output: dispatched.output,
            runId: dispatched.childRun.id,
          };
        } catch (err) {
          return {
            ok: false,
            output: err instanceof Error ? err.message : String(err),
            runId: "",
          };
        }
      },
      onBlocked: async ({ status, reason }) => {
        console.warn("[linear-trigger] pipeline gate blocked the run", {
          agentRunId: input.runId,
          reason,
        });
        // Persist the gate reason (parity with other block paths) and let a
        // failed transition propagate: the workflow's catch then drives the
        // run to a terminal `failed` rather than leaving the row `running`.
        await updateRunStatus(input.runId, status, { blockedReason: reason });
      },
    },
  });

  if (result.skippedPhases.length > 0) {
    console.log("[linear-trigger] pipeline skipped phases", {
      agentRunId: input.runId,
      skipped: result.skippedPhases,
    });
  }
  return result.status;
}

export async function runLinearTriggeredWorkflow(
  input: LinearTriggerWorkflowInput,
): Promise<void> {
  "use workflow";

  const outcome = await markRunRunning(input.agentRunId);
  if (outcome === "not_runnable") {
    // Run is in a state that should NOT trigger execution: terminal
    // (completed/failed/cancelled) OR human-waited (blocked /
    // awaiting_approval). Exit without provisioning; the audit
    // trail is either already final or owned by a different
    // resumption path (e.g. /resume comment after unblock).
    console.log("[linear-trigger] run is not runnable; skipping", {
      agentRunId: input.agentRunId,
    });
    return;
  }

  try {
    const runOutcome = await executeRunStep({
      agentRunId: input.agentRunId,
      taskText: input.taskText,
      // Only forward branch when supplied; otherwise let
      // `provisionFreshSandboxForRun` resolve the repo's default.
      ...(input.branch !== undefined ? { branch: input.branch } : {}),
    });
    // A pipeline gate may have transitioned the run to `blocked` already;
    // only mark `completed` when the run actually finished. (`blocked` →
    // `completed` is an invalid transition anyway.)
    if (runOutcome === "completed") {
      await markRunTerminal(input.agentRunId, "completed");
    }
  } catch (err) {
    console.error("[linear-trigger] workflow failed", {
      agentRunId: input.agentRunId,
      err,
    });
    await markRunTerminal(input.agentRunId, "failed");
    // Re-throw so the Workflow SDK records the failure in its own
    // bookkeeping. The agent_run row is already marked failed; the
    // SDK's record is the source of truth for "should I retry the
    // workflow itself" (we don't auto-retry).
    throw err;
  }
}

// Post a "Provisioning sandbox" thought to the Linear AgentSession
// panel before the long provisioning fetch. Resolves the workspace
// access token lazily — runs without a `linearAgentSessionId`
// (chat / cron / pre-AgentSession-era Linear runs) skip the post
// entirely, no work done. Fire-and-forget: errors are logged and
// swallowed so the workflow proceeds even when Linear is sour.
async function postProvisioningMarker(input: {
  linearAgentSessionId: string | null;
  repoRef: string;
  branch: string | undefined;
}): Promise<void> {
  if (!input.linearAgentSessionId) return;
  try {
    const { resolveLinearWorkspace } =
      await import("@/lib/linear/workspace-repository");
    const { agentActivityCreate } = await import("@/lib/linear/client");
    const workspace = await resolveLinearWorkspace();
    if (!workspace) return;
    const branchSuffix = input.branch ? `@${input.branch}` : "";
    await agentActivityCreate({
      accessToken: workspace.secrets.accessToken,
      agentSessionId: input.linearAgentSessionId,
      content: {
        type: "thought",
        body: `Provisioning sandbox: \`${input.repoRef}${branchSuffix}\``,
      },
    });
  } catch (err) {
    console.error("[linear-trigger] provisioning marker post failed", err);
  }
}
