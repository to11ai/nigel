import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { agentRuns } from "@/lib/db/schema";
import { onRunStatusChange } from "./lifecycle";
import { assertValidTransition, type RunStatus } from "./state-machine";
import type { AgentRun, SandboxPolicy, TriggerSource } from "./types";

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
  if (next === "blocked" && opts?.blockedReason) {
    patch.blockedReason = opts.blockedReason;
  }

  await db.update(agentRuns).set(patch).where(eq(agentRuns.id, id));

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
