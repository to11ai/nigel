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

// Outcome discriminator for `markRunRunning`. The workflow has to
// tell two cases apart that both result in "don't transition again":
//   - `already_running`: re-entry from a Workflow SDK step replay
//     after a kill -9. Proceed; the planner work needs to run.
//   - `already_terminal`: the run was externally cancelled /
//     completed / failed (e.g. via /cancel comment in L4, or a
//     manual admin action). Abort immediately; provisioning a
//     sandbox and running the planner here would waste cloud
//     resources and produce confusing output against a run that's
//     already been closed out.
type MarkRunOutcome = "transitioned" | "already_running" | "already_terminal";

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
    current.status === "cancelled"
  ) {
    return "already_terminal";
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
const executePlannerStep = async (input: {
  agentRunId: string;
  taskText: string;
  branch?: string;
}): Promise<void> => {
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
  const planner = await getSpecialist("planner");
  if (!planner) {
    throw new Error("planner specialist not found in registry");
  }

  const sandbox = await provisionFreshSandboxForRun({
    repoRef: run.repoRef,
    // Omit branch → `provisionFreshSandboxForRun` resolves the
    // repo's default_branch via `repos.get`. Only forward when
    // the caller explicitly supplied one.
    ...(input.branch !== undefined ? { branch: input.branch } : {}),
    humanOwnerId: run.humanOwnerId,
  });
  try {
    await executeSpecialistViaLLM({
      run,
      sandbox: sandbox.toAgentContext(),
      specialist: planner,
      task: input.taskText,
    });
  } finally {
    await teardownSandboxForRun(sandbox).catch((err) => {
      console.error("[linear-trigger] sandbox teardown failed", {
        agentRunId: input.agentRunId,
        err,
      });
    });
  }
};

export async function runLinearTriggeredWorkflow(
  input: LinearTriggerWorkflowInput,
): Promise<void> {
  "use workflow";

  const outcome = await markRunRunning(input.agentRunId);
  if (outcome === "already_terminal") {
    // Run was externally cancelled or completed before the
    // workflow picked it up. Exit without provisioning a sandbox
    // or running the planner; the audit trail is already final.
    console.log("[linear-trigger] run is already terminal; skipping", {
      agentRunId: input.agentRunId,
    });
    return;
  }

  try {
    await executePlannerStep({
      agentRunId: input.agentRunId,
      taskText: input.taskText,
      // Only forward branch when supplied; otherwise let
      // `provisionFreshSandboxForRun` resolve the repo's default.
      ...(input.branch !== undefined ? { branch: input.branch } : {}),
    });
    await markRunTerminal(input.agentRunId, "completed");
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
