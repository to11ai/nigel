import { getRun, updateRunStatus } from "./repository";

export class BudgetExhaustedError extends Error {
  constructor(rootRunId: string) {
    super(`budget exhausted on root run ${rootRunId}`);
    this.name = "BudgetExhaustedError";
  }
}

// Throws if the root Run's accumulated cost has reached or exceeded its cap.
// As a side effect, transitions the root to `blocked` (with reason "budget
// exhausted") on first hit. budgetUsdCapMicros=0 is treated as unbounded.
export async function checkRootBudget(rootRunId: string): Promise<void> {
  const root = await getRun(rootRunId);
  if (!root) {
    throw new Error(`root run not found: ${rootRunId}`);
  }
  if (root.budgetUsdCapMicros === 0) {
    return;
  }
  if (root.costUsdActualMicros < root.budgetUsdCapMicros) {
    return;
  }

  if (root.status === "running") {
    await updateRunStatus(root.id, "blocked", {
      blockedReason: "budget exhausted",
    });
  }
  throw new BudgetExhaustedError(root.id);
}
