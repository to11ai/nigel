import type { SandboxState } from "@nigel/sandbox";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { agentRuns } from "@/lib/db/schema";
import { getSpecialist } from "@/lib/specialists";
import { BudgetExhaustedError, checkRootBudget } from "./budget";
import { Run } from "./create";
import {
  defaultLocalStackLifecycle,
  type LocalStackLifecycle,
  type LocalStackTeardown,
} from "./local-stack-lifecycle";
import { getRun, updateRunStatus } from "./repository";
import {
  type ProvisionedSandbox,
  type ProvisionInput,
  provisionSandboxForRun as defaultProvisionSandboxForRun,
  teardownSandboxForRun as defaultTeardownSandboxForRun,
} from "./sandbox-coordinator";
import {
  type ExecuteSpecialistInput,
  type ExecuteSpecialistResult,
  executeSpecialistViaLLM as defaultExecuteSpecialistViaLLM,
} from "./specialist-execution";
import type { AgentRun, SandboxPolicy } from "./types";

export class SpecialistDispatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpecialistDispatchError";
  }
}

// Typed error thrown by `reserveChildSlotsAndBudget` when the atomic
// pre-flight refuses to authorize a dispatch. Distinguished by `code`
// so call sites (and tests) can branch on the failure reason without
// regex-matching on message text. Caller MUST treat any of these as a
// "no slots were reserved, no children were spawned" outcome — the
// reservation transaction rolls back before throwing.
export class ReservationError extends Error {
  readonly code:
    | "max_children_exceeded"
    | "budget_exhausted_at_reservation"
    | "specialist_not_found"
    | "parent_run_not_found";

  constructor(
    code:
      | "max_children_exceeded"
      | "budget_exhausted_at_reservation"
      | "specialist_not_found"
      | "parent_run_not_found",
    message: string,
  ) {
    super(message);
    this.name = "ReservationError";
    this.code = code;
  }
}

// One per requested slot. The caller threads each token through to its
// corresponding `dispatchSpecialist` call so the child run row gets
// tagged with the right per-slot budget. Returned in the same order as
// the input `requestedBudgetsMicros`.
//
// `reservationId` is a synthetic identifier (nanoid via `Run.create`
// when the child is inserted; the token's own id is generated here for
// logging/correlation). Today the release path keys off the child's
// `budgetUsdCapMicros` rather than this id — the id is purely for
// observability and future expansion (e.g. surfacing the reservation
// in a debug UI before the child row exists).
export type ReservationToken = {
  reservationId: string;
  budgetUsdMicros: number;
};

export type DispatchSpecialistInput = {
  parentRunId: string;
  specialistName: string;
  task: string;
  sandboxPolicyOverride?: SandboxPolicy;
  budgetUsdMicros?: number;
  // Optional in the type, required at runtime for LLM specialists. The
  // agent_runs table stores only a sandbox id, not the full SandboxState
  // needed to reconnect — so the dispatch caller (chat path / Linear
  // webhook / etc.) supplies the parent session's SandboxState. If
  // omitted for an LLM specialist, `provisionSandboxForRun` throws
  // `SandboxCoordinatorError`. Scripted specialists ignore this field.
  inheritSandboxState?: SandboxState;
  // Explicit root pointer used by the parallel path. Single-dispatch
  // callers may omit it — `dispatchSpecialist` falls back to reading
  // the parent's `rootRunId`. Provided as an optimization (and as an
  // invariant check: callers that already know the root pass it in).
  rootRunId?: string;
  // Internal-only flag. Set by the parallel-dispatch path when it has
  // already reserved an N-slot batch and is delegating per-slot
  // execution to `dispatchSpecialist`. Bypasses the single-dispatch
  // reservation so we don't double-reserve. Never set from outside the
  // dispatch module.
  skipReservation?: boolean;
  // Internal-only. Paired with `skipReservation`. Carries the per-slot
  // reservation amount and id resolved by the parallel path. Used to
  // set the child's `budgetUsdCapMicros` correctly (the parallel path
  // resolved any missing budget against the preset default at
  // reservation time, so the per-child cap must match what was
  // reserved). Never set from outside the dispatch module.
  reservation?: ReservationToken;
  // Test-only injection seam (same pattern as ExecuteSpecialistInput.deps).
  deps?: {
    provisionSandboxForRun?: (
      input: ProvisionInput,
    ) => Promise<ProvisionedSandbox>;
    teardownSandboxForRun?: (handle: ProvisionedSandbox) => Promise<void>;
    executeSpecialistViaLLM?: (
      input: ExecuteSpecialistInput,
    ) => Promise<ExecuteSpecialistResult>;
    localStackLifecycle?: LocalStackLifecycle;
    // When set, `Run.create` is replaced with this function. Test-only
    // seam used to simulate a pre-spawn failure (sandbox provision
    // throws, validation throws) so the parallel path's
    // `releasePreSpawnReservation` branch can be exercised
    // deterministically. Returns the would-be child run for the happy
    // path; throw to simulate the failure mode.
    createChildRun?: typeof Run.create;
  };
};

export type DispatchSpecialistResult = {
  childRun: AgentRun;
  output: string;
};

// Per-slot return shape for `dispatchSpecialistsParallel`. Distinct
// from `DispatchSpecialistResult` (the single-dispatch result type)
// because the parallel path does NOT surface child run rows back to
// the LLM — the LLM only needs per-slot output/error to decide what
// to do next. Each result has either `output` (fulfilled, child run
// completed) or `error` (rejected, either pre-spawn or mid-execution).
export type DispatchSpecialistsParallelResult = {
  specialistName: string;
  output: string;
  error?: string;
};

// Atomic reservation of N child slots + sum-of-budgets on the parent /
// root rows in a single transaction. Either all `requestedSlots` slots
// are reserved (and the sum of `requestedBudgetsMicros` is reserved on
// the root) or none — the transaction rolls back on any check failure.
//
// Lock order: ROOT first, PARENT second. ALL transactions that touch
// these rows MUST acquire locks in this order. Mixing the order
// between this primitive and any future writer is a deadlock waiting
// to happen.
//
// Returns one `ReservationToken` per slot. The token's
// `budgetUsdMicros` matches the corresponding input entry (input order
// is preserved). The caller threads each token through to the
// per-child dispatch so the child row records the same budget that
// was reserved.
export async function reserveChildSlotsAndBudget(input: {
  parentRunId: string;
  rootRunId: string;
  requestedBudgetsMicros: number[];
  requestedSlots: number;
}): Promise<ReservationToken[]> {
  if (input.requestedSlots !== input.requestedBudgetsMicros.length) {
    throw new Error(
      `[dispatch] reserveChildSlotsAndBudget: requestedSlots=${input.requestedSlots} but requestedBudgetsMicros has ${input.requestedBudgetsMicros.length} entries`,
    );
  }
  if (input.requestedSlots <= 0) {
    return [];
  }
  const sumBudgets = input.requestedBudgetsMicros.reduce(
    (acc, b) => acc + b,
    0,
  );

  return await db.transaction(async (tx) => {
    // Lock the ROOT row first to serialize budget-reservation reads
    // against concurrent dispatchers. `FOR UPDATE` blocks any other
    // transaction trying to read-or-write this row until we commit.
    const rootRows = await tx
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.id, input.rootRunId))
      .for("update")
      .limit(1);
    const root = rootRows[0];
    if (!root) {
      throw new ReservationError(
        "parent_run_not_found",
        `root run not found: ${input.rootRunId}`,
      );
    }

    // Lock the PARENT row only when distinct from root (skipping the
    // re-lock avoids a no-op DB round-trip; Postgres would no-op it
    // anyway since the same transaction already holds the row lock).
    let parent: AgentRun;
    if (input.parentRunId === input.rootRunId) {
      parent = root;
    } else {
      const parentRows = await tx
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.id, input.parentRunId))
        .for("update")
        .limit(1);
      if (!parentRows[0]) {
        throw new ReservationError(
          "parent_run_not_found",
          `parent run not found: ${input.parentRunId}`,
        );
      }
      parent = parentRows[0];
    }

    // Resolve the parent's max_children. Top-level rows with no
    // specialist are unbounded (the legacy chat / Linear root has no
    // preset to consult). DB-resolved specialists go through
    // `getSpecialist`, which falls back to the preset for fields not
    // overridden by a DB row.
    let parentMaxChildren = Number.POSITIVE_INFINITY;
    if (parent.specialistId) {
      const parentSpecialist = await getSpecialist(parent.specialistId);
      if (!parentSpecialist) {
        // Stay consistent with the existing dispatchSpecialist behavior
        // when the parent's specialist row disappears — refuse, don't
        // silently allow unlimited children.
        throw new ReservationError(
          "specialist_not_found",
          `parent specialist '${parent.specialistId}' not found in registry`,
        );
      }
      // The preset convention is that `maxChildren = 0` means "this
      // specialist cannot dispatch any children" (e.g. `coder`). Treat
      // 0 as a hard zero, not as "unbounded".
      parentMaxChildren = parentSpecialist.maxChildren;
    }

    if (parent.childCount + input.requestedSlots > parentMaxChildren) {
      throw new ReservationError(
        "max_children_exceeded",
        `parent run '${parent.id}' would exceed max_children=${parentMaxChildren} (current child_count=${parent.childCount}, requested ${input.requestedSlots})`,
      );
    }

    // Budget gate. `budgetUsdCapMicros = 0` means unbounded on the
    // root (legacy chat sessions are sometimes created with 0).
    if (root.budgetUsdCapMicros > 0) {
      const remaining =
        root.budgetUsdCapMicros -
        root.costUsdActualMicros -
        root.costUsdReservedMicros;
      if (remaining < sumBudgets) {
        throw new ReservationError(
          "budget_exhausted_at_reservation",
          `root run '${root.id}' has remaining=${remaining} but reservation requests ${sumBudgets}`,
        );
      }
    }

    // Both checks pass: stamp the reservation atomically. Two updates
    // (one root, one parent) in the same transaction; Postgres holds
    // both row locks until commit so no other reader sees the
    // intermediate state.
    if (sumBudgets > 0) {
      await tx
        .update(agentRuns)
        .set({
          costUsdReservedMicros: sql`${agentRuns.costUsdReservedMicros} + ${sumBudgets}`,
        })
        .where(eq(agentRuns.id, input.rootRunId));
    }
    await tx
      .update(agentRuns)
      .set({
        childCount: sql`${agentRuns.childCount} + ${input.requestedSlots}`,
      })
      .where(eq(agentRuns.id, input.parentRunId));

    // Tokens are local to this process — they are NOT persisted on
    // child rows. The release path keys off `budgetUsdCapMicros` on the
    // child run row (which is set to `budgetUsdMicros` here). Tokens
    // are still useful for logs / correlation, so we generate one.
    return input.requestedBudgetsMicros.map((budgetUsdMicros) => ({
      reservationId: randomReservationId(),
      budgetUsdMicros,
    }));
  });
}

// Decrements `root.cost_usd_reserved_micros` by the given amount.
// Called from `updateRunStatus` when a child transitions to a terminal
// state (`completed` | `failed` | `cancelled`). The PARENT's
// `child_count` is NOT decremented here — `max_children` is a lifetime
// quota per parent, not a concurrency cap.
//
// The `>=` guard is defense-in-depth, NOT the primary idempotency
// mechanism. The state machine's empty terminal-outgoing transitions
// guarantee `updateRunStatus(id, terminal)` runs at most once per
// child. The guard protects against a future code path that bypasses
// the state machine and calls this release directly.
export async function releaseTerminalReservation(input: {
  rootRunId: string;
  budgetUsdMicros: number;
}): Promise<void> {
  if (input.budgetUsdMicros <= 0) {
    return;
  }
  await db
    .update(agentRuns)
    .set({
      costUsdReservedMicros: sql`${agentRuns.costUsdReservedMicros} - ${input.budgetUsdMicros}`,
    })
    .where(
      sql`${agentRuns.id} = ${input.rootRunId} AND ${agentRuns.costUsdReservedMicros} >= ${input.budgetUsdMicros}`,
    );
}

// Releases BOTH the budget reservation on the root AND a single child
// slot on the parent. Called by the parallel-dispatch path for slots
// whose `dispatchSpecialist` invocation rejected BEFORE inserting a
// child run row (sandbox provision threw, validation threw, etc.) —
// the terminal-status release path will never fire for those slots
// because no child row exists.
//
// Lock order matches the reservation primitive: ROOT first, PARENT
// second (skipped when parent === root). Wrapped in a transaction so
// the two updates either both land or both roll back.
export async function releasePreSpawnReservation(input: {
  parentRunId: string;
  rootRunId: string;
  budgetUsdMicros: number;
}): Promise<void> {
  await db.transaction(async (tx) => {
    if (input.budgetUsdMicros > 0) {
      await tx
        .update(agentRuns)
        .set({
          costUsdReservedMicros: sql`${agentRuns.costUsdReservedMicros} - ${input.budgetUsdMicros}`,
        })
        .where(
          sql`${agentRuns.id} = ${input.rootRunId} AND ${agentRuns.costUsdReservedMicros} >= ${input.budgetUsdMicros}`,
        );
    }
    await tx
      .update(agentRuns)
      .set({
        childCount: sql`${agentRuns.childCount} - 1`,
      })
      .where(
        sql`${agentRuns.id} = ${input.parentRunId} AND ${agentRuns.childCount} >= 1`,
      );
  });
}

function randomReservationId(): string {
  // Lightweight non-crypto id is fine — this string is observability
  // only, never persisted, never used for auth.
  return `res_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

export async function dispatchSpecialist(
  input: DispatchSpecialistInput,
): Promise<DispatchSpecialistResult> {
  const parent = await getRun(input.parentRunId);
  if (!parent) {
    throw new SpecialistDispatchError(
      `parent run not found: ${input.parentRunId}`,
    );
  }

  const specialist = await getSpecialist(input.specialistName);
  if (!specialist) {
    throw new SpecialistDispatchError(
      `unknown specialist: ${input.specialistName}`,
    );
  }

  // Recurse permission + target-allowlist checks. These are stateless
  // pre-flight gates (no DB writes) so they happen before reservation —
  // a rejection here costs nothing on the parent/root.
  if (parent.specialistId) {
    const parentSpecialist = await getSpecialist(parent.specialistId);
    if (!parentSpecialist) {
      throw new SpecialistDispatchError(
        `parent specialist '${parent.specialistId}' not found in registry; recursion constraints cannot be enforced`,
      );
    }
    if (!parentSpecialist.mayRecurse) {
      throw new SpecialistDispatchError(
        `parent specialist '${parent.specialistId}' does not allow recursion`,
      );
    }
    // Target-specialist allowlist. When set, the parent can only
    // dispatch specialists named in the list. Necessary as a runtime
    // gate independent of the system prompt because the parent may
    // run with prompt-injected input (e.g. researcher's web_fetch
    // results); without this check, an injected prompt could
    // instruct the parent to dispatch a write-capable specialist.
    if (
      parentSpecialist.dispatchTargetAllowlist !== undefined &&
      !parentSpecialist.dispatchTargetAllowlist.includes(input.specialistName)
    ) {
      throw new SpecialistDispatchError(
        `parent specialist '${parent.specialistId}' cannot dispatch '${input.specialistName}' — only the following targets are permitted: ${parentSpecialist.dispatchTargetAllowlist.join(", ")}`,
      );
    }
  }

  // Legacy "budget already exhausted at the root" gate. The reservation
  // primitive checks "is there room to reserve this new request"; this
  // call covers the separate case where actual spend already meets/
  // exceeds the cap (no new reservation, but the dispatch should still
  // refuse). Skip when reservation is delegated to the parallel path —
  // it's already evaluated `cap - actual - reserved` against its
  // batched sum, and a 0-sum dispatch through the parallel path would
  // be a no-op here anyway.
  if (!input.skipReservation) {
    const rootRunIdForBudgetCheck = input.rootRunId ?? parent.rootRunId;
    await checkRootBudget(rootRunIdForBudgetCheck);
  }

  // Atomic reservation. The parallel path has already done a batched
  // reservation for this call; otherwise we reserve a single slot here.
  // The reservation primitive subsumes the old `parent.maxChildren`
  // check at this layer AND the old `checkRootBudget` call: it locks
  // the root + parent rows and refuses to authorize a dispatch that
  // would overflow either gate.
  const effectiveBudget =
    input.reservation?.budgetUsdMicros ??
    input.budgetUsdMicros ??
    specialist.budgetUsdDefaultMicros;
  const rootRunId = input.rootRunId ?? parent.rootRunId;
  let didReserveHere = false;
  if (!input.skipReservation) {
    try {
      await reserveChildSlotsAndBudget({
        parentRunId: parent.id,
        rootRunId,
        requestedBudgetsMicros: [effectiveBudget],
        requestedSlots: 1,
      });
      didReserveHere = true;
    } catch (err) {
      if (err instanceof ReservationError) {
        if (err.code === "budget_exhausted_at_reservation") {
          // Preserve the existing API: dispatch callers historically
          // see a BudgetExhaustedError when the root is over-cap.
          // Convert at this boundary.
          throw new BudgetExhaustedError(rootRunId);
        }
        if (err.code === "max_children_exceeded") {
          // Preserve the existing message shape for backward-compat
          // with callers that regex-match. Pull the cap out of the
          // ReservationError message; the parent specialist's
          // maxChildren is the only thing the test cares about.
          throw new SpecialistDispatchError(err.message);
        }
        throw new SpecialistDispatchError(err.message);
      }
      throw err;
    }
  }

  // From this point on, any failure BEFORE `Run.create` must release
  // both the budget and the parent-slot we just reserved (pre-spawn
  // path). After `Run.create` succeeds, releases happen via the
  // child's terminal-status transition (`updateRunStatus` decrements
  // the root reservation by `child.budgetUsdCapMicros`).
  const createChildRun = input.deps?.createChildRun ?? Run.create;
  let childRun: AgentRun;
  try {
    childRun = await createChildRun({
      triggerSource: "chained",
      humanOwnerId: parent.humanOwnerId,
      parentRunId: parent.id,
      specialistId: specialist.name,
      sandboxPolicy: input.sandboxPolicyOverride ?? specialist.sandboxPolicy,
      repoRef: parent.repoRef,
      chatId: parent.chatId,
      budgetUsdCapMicros: effectiveBudget,
    });
  } catch (err) {
    if (didReserveHere) {
      await releasePreSpawnReservation({
        parentRunId: parent.id,
        rootRunId,
        budgetUsdMicros: effectiveBudget,
      }).catch((releaseErr) => {
        // biome-ignore lint/suspicious/noConsole: leak diagnostics must surface
        console.error(
          "[dispatch] pre-spawn reservation release failed during Run.create rejection; reservation may leak",
          { parentRunId: parent.id, rootRunId, releaseErr },
        );
      });
    }
    throw err;
  }

  // Phase 2 only supports scripted execution end-to-end. LLM-driven
  // specialists (kind='preset' or 'custom' with a model+systemPrompt) are
  // wired in Phase 4.
  if (specialist.kind === "scripted" && specialist.script) {
    await updateRunStatus(childRun.id, "running");
    try {
      const output = await specialist.script(input.task);
      await updateRunStatus(childRun.id, "completed");
      const refreshed = (await getRun(childRun.id)) ?? childRun;
      return { childRun: refreshed, output };
    } catch (err) {
      await updateRunStatus(childRun.id, "failed").catch(() => undefined);
      throw err;
    }
  }

  // Phase 4b: LLM-driven specialists (kind = 'preset' | 'custom').
  if (!specialist.systemPrompt || !specialist.model) {
    await updateRunStatus(childRun.id, "failed").catch(() => undefined);
    throw new SpecialistDispatchError(
      `specialist '${specialist.name}' is incomplete (missing systemPrompt or model)`,
    );
  }

  const provisionSandboxForRun =
    input.deps?.provisionSandboxForRun ?? defaultProvisionSandboxForRun;
  const teardownSandboxForRun =
    input.deps?.teardownSandboxForRun ?? defaultTeardownSandboxForRun;
  const executeSpecialistViaLLM =
    input.deps?.executeSpecialistViaLLM ?? defaultExecuteSpecialistViaLLM;
  const localStackLifecycle =
    input.deps?.localStackLifecycle ?? defaultLocalStackLifecycle;

  let provisioned: ProvisionedSandbox | null = null;
  let runLocalStackTeardown: LocalStackTeardown | null = null;
  try {
    await updateRunStatus(childRun.id, "running");
    provisioned = await provisionSandboxForRun({
      inheritFrom: input.inheritSandboxState ?? null,
    });
    runLocalStackTeardown = await localStackLifecycle.prepare({
      specialist,
      provisioned,
      parentRepoRef: parent.repoRef,
    });
    const result = await executeSpecialistViaLLM({
      run: childRun,
      sandbox: provisioned.toAgentContext(),
      specialist,
      task: input.task,
    });
    await updateRunStatus(childRun.id, "completed");
    const refreshed = (await getRun(childRun.id)) ?? childRun;
    return { childRun: refreshed, output: result.output };
  } catch (err) {
    if (err instanceof BudgetExhaustedError) {
      await updateRunStatus(childRun.id, "blocked", {
        blockedReason: "budget exhausted",
      }).catch(() => undefined);
    } else {
      await updateRunStatus(childRun.id, "failed").catch(() => undefined);
    }
    throw err;
  } finally {
    if (runLocalStackTeardown) {
      // Always invoke. The default implementation is a no-op for
      // specialists that didn't need the stack; non-no-op teardowns
      // are responsible for swallowing their own errors so we don't
      // leak them past `finally`.
      await runLocalStackTeardown();
    }
    if (provisioned) {
      // Don't let teardown failure mask the original outcome (success or
      // the original throw). But do log — silent failure here can leak
      // sandboxes that hold quota and writable repo access.
      try {
        await teardownSandboxForRun(provisioned);
      } catch (teardownErr) {
        // biome-ignore lint/suspicious/noConsole: leak diagnostics must surface
        console.error(
          `[dispatch] sandbox teardown failed for run ${childRun.id}; sandbox may be leaked`,
          teardownErr,
        );
      }
    }
  }
}

// Parallel-dispatch entrypoint. Reserves the entire batch's child
// slots + sum-of-budgets in one atomic step (so a partial-success
// outcome on the reservation gate is impossible: either every slot is
// authorized or none), then fans out per-child execution with
// `Promise.allSettled` so one child rejection does NOT abort siblings.
//
// Return shape: `Array<{ specialistName, output, error? }>`. One entry
// per input in input order. Fulfilled children have `output`; rejected
// children have `error` (and `output === ""`).
export async function dispatchSpecialistsParallel(
  inputs: DispatchSpecialistInput[],
): Promise<DispatchSpecialistsParallelResult[]> {
  if (inputs.length === 0) {
    return [];
  }

  // All inputs in a batch must share the same parent (and therefore the
  // same root). The LLM tool wrapper enforces this at the schema level,
  // but we re-check here so a server-side caller can't smuggle a mixed
  // batch through.
  const parentRunId = inputs[0].parentRunId;
  for (const i of inputs) {
    if (i.parentRunId !== parentRunId) {
      throw new SpecialistDispatchError(
        `dispatchSpecialistsParallel: all inputs must share parentRunId (got '${i.parentRunId}' vs '${parentRunId}')`,
      );
    }
  }

  // Resolve the root run id once. The parent's row is the authoritative
  // source; if any input passed an explicit rootRunId it must match.
  const parent = await getRun(parentRunId);
  if (!parent) {
    throw new SpecialistDispatchError(`parent run not found: ${parentRunId}`);
  }
  const rootRunId = parent.rootRunId;

  // Resolve effective per-child budgets BEFORE reserving. If the LLM
  // omits `budgetUsdMicros`, fall back to the targeted specialist's
  // preset default — NOT 0. A `?? 0` here would silently reserve zero
  // while the child ran with its full preset budget, defeating the
  // entire reservation gate.
  //
  // An unknown specialist at this stage throws BEFORE the reservation
  // transaction starts, so a typo in a single dispatch in a parallel
  // batch does not consume parent slots or root budget.
  const resolvedBudgets = await Promise.all(
    inputs.map(async (i) => {
      if (i.budgetUsdMicros !== undefined) {
        return i.budgetUsdMicros;
      }
      const sp = await getSpecialist(i.specialistName);
      if (!sp) {
        throw new ReservationError(
          "specialist_not_found",
          `cannot reserve budget for unknown specialist: ${i.specialistName}`,
        );
      }
      return sp.budgetUsdDefaultMicros;
    }),
  );

  const reservations = await reserveChildSlotsAndBudget({
    parentRunId,
    rootRunId,
    requestedBudgetsMicros: resolvedBudgets,
    requestedSlots: inputs.length,
  });

  // Per-slot fan-out. `Promise.allSettled` (NOT `Promise.all`) is the
  // core "one child failure does not abort siblings" guarantee.
  const settled = await Promise.allSettled(
    inputs.map((i, idx) =>
      dispatchSpecialist({
        ...i,
        rootRunId,
        skipReservation: true,
        reservation: reservations[idx],
      }),
    ),
  );

  const results: DispatchSpecialistsParallelResult[] = [];
  for (let i = 0; i < settled.length; i++) {
    const s = settled[i];
    if (s.status === "fulfilled") {
      // Fulfilled: the child row was inserted and reached a terminal
      // status during `dispatchSpecialist`. The terminal-status path
      // in `updateRunStatus` already decremented the root's
      // `costUsdReservedMicros` by the child's budget. Do nothing
      // here; another release would double-release.
      results.push({
        specialistName: inputs[i].specialistName,
        output: s.value.output,
      });
    } else {
      // Rejected: `dispatchSpecialist` threw before the child row was
      // inserted. (Throws AFTER `Run.create` go through the terminal-
      // status path inside dispatchSpecialist itself, which releases
      // the reservation.) The pre-spawn release returns BOTH the
      // budget AND the parent-slot. Awaited (not fire-and-forget) so
      // a release-side DB failure surfaces in logs/spans.
      await releasePreSpawnReservation({
        parentRunId,
        rootRunId,
        budgetUsdMicros: reservations[i].budgetUsdMicros,
      }).catch((releaseErr) => {
        // biome-ignore lint/suspicious/noConsole: leak diagnostics must surface
        console.error(
          "[dispatch] pre-spawn reservation release failed; reservation may leak",
          { reservation: reservations[i], releaseErr },
        );
      });
      results.push({
        specialistName: inputs[i].specialistName,
        output: "",
        error:
          s.reason instanceof Error ? s.reason.message : String(s.reason),
      });
    }
  }
  return results;
}
