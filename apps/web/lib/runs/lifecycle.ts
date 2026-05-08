import type { RunStatus } from "./state-machine";

// Phase 1 placeholder. Concrete handlers (Linear reassignment, Datadog
// metrics, Slack notifications) are added in Phases 6+.
//
// The dispatcher is intentionally fire-and-forget — a failing handler
// must not roll back the status transition that triggered it.
export async function onRunStatusChange(_args: {
  runId: string;
  rootRunId: string;
  from: RunStatus;
  to: RunStatus;
}): Promise<void> {
  // No handlers registered in Phase 1.
}
