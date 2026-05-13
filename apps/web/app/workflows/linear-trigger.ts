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
  // Branch to clone. Defaults to "main" when omitted.
  branch?: string;
};

const markRunRunning = async (agentRunId: string): Promise<void> => {
  "use step";
  const { getRun, updateRunStatus } = await import("@/lib/runs/repository");
  // Re-entry safety: a workflow resume after a kill -9 may re-fire
  // this step with the run already at `running`. The state machine
  // would reject the no-op transition, so check first.
  const current = await getRun(agentRunId);
  if (!current) {
    throw new Error(`agent_run not found: ${agentRunId}`);
  }
  if (
    current.status === "running" ||
    current.status === "completed" ||
    current.status === "failed" ||
    current.status === "cancelled"
  ) {
    return;
  }
  await updateRunStatus(agentRunId, "running");
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
  branch: string;
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
    branch: input.branch,
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

  await markRunRunning(input.agentRunId);

  try {
    await executePlannerStep({
      agentRunId: input.agentRunId,
      taskText: input.taskText,
      branch: input.branch ?? "main",
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
