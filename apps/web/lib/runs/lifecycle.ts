import type { RunStatus } from "./state-machine";

// Phase 6 L3: status-transition handlers. The dispatcher is
// intentionally fire-and-forget — a failing handler must not roll
// back the status transition that triggered it.
//
// Currently registered: Linear-triggered runs reassign the
// originating issue back to the human owner and post a status
// comment per the spec's state-transition table:
//
//   pending → running           comment "Picked up by Nigel for
//                               @{human_owner}", bot stays
//                               assigned
//   running → blocked           reassign to human, comment with
//                               blocked_reason
//   running → awaiting_approval reassign to human, comment with
//                               approval-instructions placeholder
//   running → completed         reassign to human, comment "Done"
//   running → failed            reassign to human, comment with
//                               failure summary
//   running → cancelled         reassign to human, comment with
//                               cancellation note
//
// Additional handlers (Datadog metrics, Slack notifications) can
// be added here as they ship.

export async function onRunStatusChange(args: {
  runId: string;
  rootRunId: string;
  from: RunStatus;
  to: RunStatus;
}): Promise<void> {
  // Dynamic imports keep the Phase-1 transition path (used by
  // every run) free of the Linear / Github coupling that follows.
  // Only Linear-triggered runs reach the handler below.
  const { getRun } = await import("./repository");
  const run = await getRun(args.runId);
  if (!run) return;
  if (run.triggerSource !== "linear") return;
  if (!run.triggerRef) return; // no issue id → nothing to post against

  await handleLinearLifecycle({
    run,
    from: args.from,
    to: args.to,
  });
}

async function handleLinearLifecycle(input: {
  run: {
    id: string;
    humanOwnerId: string | null;
    triggerRef: string | null;
    blockedReason: string | null;
  };
  from: RunStatus;
  to: RunStatus;
}): Promise<void> {
  const action = describeLinearAction({
    from: input.from,
    to: input.to,
    blockedReason: input.run.blockedReason,
  });
  if (!action) return; // no Linear-side action for this transition

  const issueId = input.run.triggerRef;
  if (!issueId) return;

  // Dynamic imports: every other Linear / GitHub touch happens
  // through helpers in @/lib/linear, and pulling them at the top
  // of this file would drag the postgres + crypto modules into
  // every status-change call site.
  const { commentOnIssue, reassignIssue } = await import("@/lib/linear/client");
  const { resolveLinearWorkspace } =
    await import("@/lib/linear/workspace-repository");
  const workspace = await resolveLinearWorkspace();
  if (!workspace) {
    console.warn(
      "[lifecycle] linear-triggered run transitioned but workspace is unconfigured",
      { runId: input.run.id, to: input.to },
    );
    return;
  }

  // Resolve the human owner's Linear ID for reassignment. The
  // run's `humanOwnerId` is a Nigel users.id; we look up that
  // user's `linearUserId`. When missing (manually-edited owner,
  // unlinked account), reassign to null (un-assign) — same
  // outcome the failure-path comments fall back to. The bot
  // stops appearing as the active owner either way.
  let linearAssigneeId: string | null = null;
  if (input.run.humanOwnerId) {
    const { eq } = await import("drizzle-orm");
    const { db } = await import("@/lib/db/client");
    const { users } = await import("@/lib/db/schema");
    const rows = await db
      .select({ linearUserId: users.linearUserId })
      .from(users)
      .where(eq(users.id, input.run.humanOwnerId))
      .limit(1);
    linearAssigneeId = rows[0]?.linearUserId ?? null;
  }

  // Comment and reassign are independent best-effort calls. A failed
  // comment must NOT skip the reassign — for terminal transitions
  // (completed/failed/cancelled) that would leave the bot
  // permanently assigned to the ticket. Catch each separately.
  await commentOnIssue({
    accessToken: workspace.secrets.accessToken,
    issueId,
    body: action.body,
  }).catch((err) => {
    console.error("[lifecycle] linear comment failed", {
      runId: input.run.id,
      from: input.from,
      to: input.to,
      err,
    });
  });
  if (action.reassign) {
    await reassignIssue({
      accessToken: workspace.secrets.accessToken,
      issueId,
      assigneeId: linearAssigneeId,
    }).catch((err) => {
      console.error("[lifecycle] linear reassign failed", {
        runId: input.run.id,
        from: input.from,
        to: input.to,
        err,
      });
    });
  }
}

// Map a status transition to the Linear-side action. Returns null
// when no comment / reassignment applies (e.g. internal
// running→running re-entries, transitions that don't have a
// user-facing meaning on a Linear ticket).
function describeLinearAction(input: {
  from: RunStatus;
  to: RunStatus;
  blockedReason: string | null;
}): { body: string; reassign: boolean } | null {
  const { from, to } = input;
  if (from === "pending" && to === "running") {
    return {
      body: "Picked up by Nigel. Bot will stay assigned while work is in progress.",
      reassign: false,
    };
  }
  if (to === "blocked") {
    // Thread blockedReason into the comment so the human owner can
    // act without bouncing to the Nigel UI. updateRunStatus persists
    // the reason before this dispatcher fires, so the field on the
    // refetched run is authoritative.
    const reason = input.blockedReason?.trim();
    const body = reason
      ? `Nigel is blocked: ${reason}\n\nReassigning to the human owner. Comment to resume once unblocked.`
      : "Nigel is blocked. Reassigning to the human owner. Comment to resume once unblocked.";
    return { body, reassign: true };
  }
  if (to === "awaiting_approval") {
    return {
      body: "Nigel is awaiting approval. Reassigning to the human owner. Reply `/approve` or `/reject` once reviewed.",
      reassign: true,
    };
  }
  if (to === "completed") {
    return {
      body: "Nigel finished the task. Reassigning to the human owner for review.",
      reassign: true,
    };
  }
  if (to === "failed") {
    return {
      body: "Nigel failed the task. Reassigning to the human owner; see the Nigel run for details.",
      reassign: true,
    };
  }
  if (to === "cancelled") {
    return {
      body: "Nigel run was cancelled. Reassigning to the human owner.",
      reassign: true,
    };
  }
  return null;
}
