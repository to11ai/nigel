import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { agentRuns } from "@/lib/db/schema";

export class BudgetExhaustedError extends Error {
  constructor(rootRunId: string) {
    super(`budget exhausted on root run ${rootRunId}`);
    this.name = "BudgetExhaustedError";
  }
}

// Throws if the root Run's accumulated cost has reached or exceeded its cap.
// As a side effect, transitions the root to `blocked` (with reason "budget
// exhausted") on first hit. budgetUsdCapMicros=0 is treated as unbounded.
//
// Wrapped in a transaction with a Postgres advisory lock keyed on the root
// run id so two concurrent callers cannot both observe `cost < cap` and
// both proceed past the check. The second caller blocks until the first
// commits, then reads the (possibly updated) root cost.
export async function checkRootBudget(rootRunId: string): Promise<void> {
  let shouldThrow = false;
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`nigel:budget:${rootRunId}`}))`,
    );

    const rows = await tx
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.id, rootRunId))
      .limit(1);
    const root = rows[0];
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
      await tx
        .update(agentRuns)
        .set({
          status: "blocked",
          blockedReason: "budget exhausted",
        })
        .where(eq(agentRuns.id, root.id));
    }
    shouldThrow = true;
  });

  if (shouldThrow) {
    throw new BudgetExhaustedError(rootRunId);
  }
}
