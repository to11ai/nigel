export type RunStatus =
  | "pending"
  | "running"
  | "blocked"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

export const terminalStates: ReadonlySet<RunStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

// Transition table — keys are sources, values are valid destinations.
// Identity transitions (X -> X) are intentionally excluded.
const TRANSITIONS: Record<RunStatus, ReadonlySet<RunStatus>> = {
  pending: new Set(["running", "cancelled", "failed"]),
  running: new Set([
    "blocked",
    "awaiting_approval",
    "completed",
    "failed",
    "cancelled",
  ]),
  blocked: new Set(["running", "cancelled", "failed"]),
  awaiting_approval: new Set(["running", "cancelled", "failed"]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

export function isValidTransition(from: RunStatus, to: RunStatus): boolean {
  return TRANSITIONS[from].has(to);
}

export function assertValidTransition(from: RunStatus, to: RunStatus): void {
  if (!isValidTransition(from, to)) {
    throw new Error(`invalid run status transition: ${from} -> ${to}`);
  }
}
