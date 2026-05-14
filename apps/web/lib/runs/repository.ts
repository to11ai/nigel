import {
  and,
  asc,
  desc,
  eq,
  gte,
  type InferSelectModel,
  isNull,
  lt,
  notInArray,
  sql,
} from "drizzle-orm";
import { db } from "@/lib/db/client";
import { agentRuns, runMessages, runToolCalls } from "@/lib/db/schema";
import { recordRunStatusChange } from "@/lib/observability/lifecycle-span";
import { onRunStatusChange } from "./lifecycle";
import {
  assertValidTransition,
  type RunStatus,
  terminalStates,
} from "./state-machine";
import type { AgentRun, SandboxPolicy, TriggerSource } from "./types";

export type RunMessage = InferSelectModel<typeof runMessages>;
export type RunToolCall = InferSelectModel<typeof runToolCalls>;

export type InsertRunInput = {
  id: string;
  parentRunId: string | null;
  rootRunId: string;
  depth: number;
  triggerSource: TriggerSource;
  triggerRef?: string | null;
  specialistId?: string | null;
  sandboxPolicy: SandboxPolicy;
  humanOwnerId: string | null;
  repoRef?: string | null;
  workflowRunId?: string | null;
  chatId?: string | null;
  budgetUsdCapMicros: number;
};

export async function insertRun(input: InsertRunInput): Promise<void> {
  await db.insert(agentRuns).values({
    id: input.id,
    parentRunId: input.parentRunId,
    rootRunId: input.rootRunId,
    depth: input.depth,
    triggerSource: input.triggerSource,
    triggerRef: input.triggerRef ?? null,
    specialistId: input.specialistId ?? null,
    sandboxPolicy: input.sandboxPolicy,
    humanOwnerId: input.humanOwnerId,
    repoRef: input.repoRef ?? null,
    workflowRunId: input.workflowRunId ?? null,
    chatId: input.chatId ?? null,
    budgetUsdCapMicros: input.budgetUsdCapMicros,
    costUsdActualMicros: 0,
    status: "pending",
  });
}

export async function getRun(id: string): Promise<AgentRun | null> {
  const rows = await db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function listChildren(parentId: string): Promise<AgentRun[]> {
  return db.select().from(agentRuns).where(eq(agentRuns.parentRunId, parentId));
}

// Activity-log queries for the run-detail view. Both order by
// createdAt ASC so the viewer can render the agent's behavior in
// the order it actually happened. Linear-triggered and chat-triggered
// runs alike are populated by `executeSpecialistViaLLM`'s
// onStepFinish hook (see lib/runs/run-persistence.ts).
//
// Limited to 2000 rows per query — the planner's MAX_STEPS=50 with
// many tool calls per step can produce hundreds of rows on a busy
// run, but two thousand is a safe ceiling for a single-page render.
// Pagination is a known follow-up if agent runs grow past this.
const ACTIVITY_PAGE_LIMIT = 2000;

export async function listRunMessages(runId: string): Promise<RunMessage[]> {
  return db
    .select()
    .from(runMessages)
    .where(eq(runMessages.runId, runId))
    .orderBy(asc(runMessages.createdAt))
    .limit(ACTIVITY_PAGE_LIMIT);
}

export async function listRunToolCalls(runId: string): Promise<RunToolCall[]> {
  return db
    .select()
    .from(runToolCalls)
    .where(eq(runToolCalls.runId, runId))
    .orderBy(asc(runToolCalls.createdAt))
    .limit(ACTIVITY_PAGE_LIMIT);
}

// Phase 6 L4: find the run associated with a Linear issue.
//
// Both queries scope to `triggerSource = 'linear'` so chat/api runs
// that coincidentally share a triggerRef value can't be picked up by
// a Linear comment command.
//
// `getActiveRunByLinearIssue` returns the most-recent non-terminal
// run — the one a `/approve`, `/reject`, `/resume`, or `/cancel`
// command should act on. Returns null when every run on that issue
// has reached a terminal state (completed | failed | cancelled).
//
// `getLatestRunByLinearIssue` returns the most recent run regardless
// of status — the `/run` command consults this to decide whether to
// permit starting a fresh run (only when no active run exists).
export async function getActiveRunByLinearIssue(
  issueId: string,
): Promise<AgentRun | null> {
  const rows = await db
    .select()
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.triggerSource, "linear"),
        eq(agentRuns.triggerRef, issueId),
        // Use the canonical terminal set so a new terminal state
        // added to state-machine.ts flows here automatically.
        notInArray(agentRuns.status, [...terminalStates]),
      ),
    )
    .orderBy(desc(agentRuns.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function getLatestRunByLinearIssue(
  issueId: string,
): Promise<AgentRun | null> {
  const rows = await db
    .select()
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.triggerSource, "linear"),
        eq(agentRuns.triggerRef, issueId),
      ),
    )
    .orderBy(desc(agentRuns.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function updateRunStatus(
  id: string,
  next: RunStatus,
  opts?: { blockedReason?: string },
): Promise<void> {
  const current = await getRun(id);
  if (!current) {
    throw new Error(`run not found: ${id}`);
  }
  assertValidTransition(current.status, next);

  const now = new Date();
  const patch: Partial<AgentRun> = {
    status: next,
  };
  if (next === "running" && !current.startedAt) {
    patch.startedAt = now;
  }
  if (next === "completed" || next === "failed" || next === "cancelled") {
    patch.endedAt = now;
  }
  if (next === "blocked") {
    patch.blockedReason = opts?.blockedReason ?? null;
  } else if (current.status === "blocked") {
    // Clear the stale reason when leaving blocked.
    patch.blockedReason = null;
  }

  await db.update(agentRuns).set(patch).where(eq(agentRuns.id, id));

  // Emit the telemetry span AFTER the DB write succeeds — recording
  // transitions that never persisted would skew the dashboards.
  // Duration is only meaningful on terminal transitions where
  // `endedAt` is set in this same patch; for non-terminal the start
  // was set on a previous transition (pending → running). Read the
  // best-effort duration from current.startedAt + patch.endedAt.
  //
  // Wrapped in try/catch so a telemetry failure (OTel SDK regression,
  // misbehaving test fake) never preempts the lifecycle dispatch
  // below. Same isolation principle the lifecycle hook itself uses.
  const startedAt = patch.startedAt ?? current.startedAt;
  const endedAt = patch.endedAt ?? null;
  const durationMs =
    startedAt && endedAt ? endedAt.getTime() - startedAt.getTime() : null;
  try {
    recordRunStatusChange({
      runId: id,
      rootRunId: current.rootRunId,
      parentRunId: current.parentRunId,
      depth: current.depth,
      triggerSource: current.triggerSource,
      specialistId: current.specialistId,
      from: current.status,
      to: next,
      durationMs,
      costUsdMicros: current.costUsdActualMicros,
      budgetUsdMicros: current.budgetUsdCapMicros,
    });
  } catch (err) {
    // biome-ignore lint/suspicious/noConsole: telemetry failures must surface
    console.error("recordRunStatusChange failed", { runId: id, err });
  }

  // Fire-and-forget; never let a handler failure roll back the transition.
  void onRunStatusChange({
    runId: id,
    rootRunId: current.rootRunId,
    from: current.status,
    to: next,
  }).catch((err) => {
    // biome-ignore lint/suspicious/noConsole: lifecycle hook errors must surface
    console.error("onRunStatusChange handler failed", { runId: id, err });
  });
}

export async function addCostMicros(
  id: string,
  deltaMicros: number,
): Promise<void> {
  if (deltaMicros === 0) {
    return;
  }
  // Atomic SQL increment — avoids the read-modify-write race that drops
  // updates under concurrent calls. The cost-rollup trigger computes its
  // delta from OLD vs NEW, which works correctly with this increment too.
  const result = await db
    .update(agentRuns)
    .set({
      costUsdActualMicros: sql`${agentRuns.costUsdActualMicros} + ${deltaMicros}`,
    })
    .where(eq(agentRuns.id, id))
    .returning({ id: agentRuns.id });
  if (result.length === 0) {
    throw new Error(`run not found: ${id}`);
  }
}

export type ListRootRunsForUserInput = {
  userId: string;
  // Cursor-style pagination on createdAt: rows strictly older than the
  // supplied timestamp. Combined with the implicit DESC order this gives
  // stable paging that survives new inserts at the head.
  before?: Date;
  // Hard upper bound on rows returned per call. Defaults to 50 — large
  // enough to fill a screen, small enough that an admin browsing months
  // of runs doesn't accidentally pull thousands of rows.
  limit?: number;
  // Optional filters. All filters AND together. Each one is a row-
  // exclusion predicate, not a fuzzy search — empty / undefined means
  // "no constraint from this filter". The UI surfaces these via URL
  // search params so a filtered view is shareable / bookmarkable.
  specialistId?: string;
  status?: RunStatus;
  triggerSource?: TriggerSource;
  // Lower bound on cost in micros (>=). The UI exposes a USD value
  // and converts; the repository takes micros to match the column
  // and avoid double-rounding.
  minCostMicros?: number;
};

// Lists root runs (parentRunId IS NULL) owned by the given user, most
// recent first. Root runs are the entry points of agent activity —
// every dispatched child is reachable from one of these via the
// rootRunId column.
export async function listRootRunsForUser(
  input: ListRootRunsForUserInput,
): Promise<AgentRun[]> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const conditions = [
    isNull(agentRuns.parentRunId),
    eq(agentRuns.humanOwnerId, input.userId),
  ];
  if (input.before) {
    conditions.push(lt(agentRuns.createdAt, input.before));
  }
  if (input.specialistId) {
    conditions.push(eq(agentRuns.specialistId, input.specialistId));
  }
  if (input.status) {
    conditions.push(eq(agentRuns.status, input.status));
  }
  if (input.triggerSource) {
    conditions.push(eq(agentRuns.triggerSource, input.triggerSource));
  }
  if (
    input.minCostMicros !== undefined &&
    Number.isFinite(input.minCostMicros) &&
    input.minCostMicros > 0
  ) {
    conditions.push(gte(agentRuns.costUsdActualMicros, input.minCostMicros));
  }
  return db
    .select()
    .from(agentRuns)
    .where(and(...conditions))
    .orderBy(desc(agentRuns.createdAt))
    .limit(limit);
}

// Returns every run (root + descendants) sharing the given rootRunId,
// scoped to the calling user. The caller assembles the tree from
// parent_run_id links; we don't return a nested structure here because
// the detail page renders a flat depth-indented list and benefits from
// a single round-trip.
export async function listRunTreeForUser(input: {
  rootRunId: string;
  userId: string;
}): Promise<AgentRun[]> {
  return db
    .select()
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.rootRunId, input.rootRunId),
        eq(agentRuns.humanOwnerId, input.userId),
      ),
    )
    .orderBy(agentRuns.createdAt);
}
