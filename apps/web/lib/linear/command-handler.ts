import { Run } from "@/lib/runs/create";
import {
  getActiveRunByLinearIssue,
  getLatestRunByLinearIssue,
  updateRunStatus,
} from "@/lib/runs/repository";
import { type RunStatus, terminalStates } from "@/lib/runs/state-machine";
import { commentOnIssue, fetchIssue } from "./client";
import { type LinearCommand, parseLinearCommand } from "./command-parser";
import { parseLinearIssue } from "./event-schema";
import { lookupNigelUserByLinearId } from "./owner-resolver";
import { resolveRepo } from "./repo-resolver";
import {
  buildTaskText,
  defaultStartLinearTriggeredWorkflow,
} from "./run-trigger";
import type { ResolvedLinearWorkspace } from "./workspace-repository";

// Phase 6 L4: comment-command intake.
//
// Branches in the webhook handler delegate here when the event is a
// `Comment.create` from a non-bot actor. We:
//   1. Parse the command from the body. Non-commands → ignored.
//   2. Map the commenter's Linear ID to a Nigel user. Unmapped →
//      reject with explanatory comment.
//   3. Dispatch per command. State-transition commands look up the
//      active run and validate it's in a compatible state; `/run`
//      looks up the latest run and refuses if a non-terminal one
//      exists.
//
// All failure paths post a Linear comment so the user sees why the
// command was rejected. Comment posts are best-effort (.catch + log)
// — a Linear hiccup must not leave the route stuck since Linear will
// otherwise retry the delivery against the same already-claimed
// event id.

export type CommandHandlerOutcome =
  | { kind: "not_a_command" }
  | { kind: "unmapped_actor"; actorId: string }
  | { kind: "no_active_run"; command: LinearCommand; issueId: string }
  | {
      kind: "wrong_state";
      command: LinearCommand;
      currentStatus: RunStatus;
      runId: string;
    }
  | {
      kind: "unauthorized";
      command: LinearCommand;
      runId: string;
      commenterUserId: string;
      ownerUserId: string | null;
    }
  | {
      kind: "transitioned";
      command: LinearCommand;
      runId: string;
      from: RunStatus;
      to: RunStatus;
    }
  | {
      kind: "run_started";
      command: "run";
      runId: string;
      issueId: string;
    }
  | {
      kind: "run_start_failed";
      command: "run";
      issueId: string;
      // `unresolved_owner` isn't in the union here because the actor
      // lookup happens in handleLinearCommandComment BEFORE
      // handleRunCommand runs — an unmapped commenter returns as
      // `unmapped_actor` and never reaches the /run path.
      reason:
        | "unresolved_repo"
        | "issue_fetch_failed"
        | "issue_not_found"
        | "workflow_start_failed";
    };

export type CommandHandlerDeps = {
  startWorkflow?: (input: {
    agentRunId: string;
    taskText: string;
  }) => Promise<void>;
  // Test-injection seam. Production routes through `fetchIssue`
  // from ./client; tests pass a stub returning a synthetic issue
  // so the `/run` path can be exercised without hitting Linear.
  fetchIssue?: (input: {
    accessToken: string;
    issueId: string;
  }) => Promise<Awaited<ReturnType<typeof fetchIssue>>>;
};

export async function handleLinearCommandComment(input: {
  workspace: ResolvedLinearWorkspace;
  commentBody: string;
  issueId: string;
  actorId: string;
  defaultBudgetUsdMicros: number;
  deps?: CommandHandlerDeps;
}): Promise<CommandHandlerOutcome> {
  const parsed = parseLinearCommand(input.commentBody);
  if (!parsed) {
    return { kind: "not_a_command" };
  }

  const commenterUserId = await lookupNigelUserByLinearId(input.actorId);
  if (!commenterUserId) {
    await safeComment(input.workspace, input.issueId, unmappedActorBody());
    return { kind: "unmapped_actor", actorId: input.actorId };
  }

  if (parsed.command === "run") {
    return handleRunCommand({
      workspace: input.workspace,
      issueId: input.issueId,
      commenterUserId,
      defaultBudgetUsdMicros: input.defaultBudgetUsdMicros,
      deps: input.deps,
    });
  }

  const run = await getActiveRunByLinearIssue(input.issueId);
  if (!run) {
    await safeComment(
      input.workspace,
      input.issueId,
      noActiveRunBody(parsed.command),
    );
    return {
      kind: "no_active_run",
      command: parsed.command,
      issueId: input.issueId,
    };
  }

  if (run.humanOwnerId !== commenterUserId) {
    await safeComment(
      input.workspace,
      input.issueId,
      unauthorizedBody(parsed.command),
    );
    return {
      kind: "unauthorized",
      command: parsed.command,
      runId: run.id,
      commenterUserId,
      ownerUserId: run.humanOwnerId,
    };
  }

  const transition = transitionForCommand(parsed.command, run.status);
  if (!transition) {
    await safeComment(
      input.workspace,
      input.issueId,
      wrongStateBody(parsed.command, run.status),
    );
    return {
      kind: "wrong_state",
      command: parsed.command,
      currentStatus: run.status,
      runId: run.id,
    };
  }

  // updateRunStatus fires the lifecycle dispatcher which posts the
  // status comment + reassigns the ticket. We don't post a separate
  // ack here — the lifecycle comment is the user-visible record.
  // The optional reason is attached to `blocked → cancelled` etc.
  // via the `blockedReason` field which is only meaningful for
  // `to === "blocked"`. For `/reject` with a reason we can extend
  // the state machine later; for now the reason is logged.
  await updateRunStatus(run.id, transition);
  return {
    kind: "transitioned",
    command: parsed.command,
    runId: run.id,
    from: run.status,
    to: transition,
  };
}

async function handleRunCommand(input: {
  workspace: ResolvedLinearWorkspace;
  issueId: string;
  commenterUserId: string;
  defaultBudgetUsdMicros: number;
  deps?: CommandHandlerDeps;
}): Promise<CommandHandlerOutcome> {
  const existing = await getLatestRunByLinearIssue(input.issueId);
  if (existing && !isTerminal(existing.status)) {
    await safeComment(
      input.workspace,
      input.issueId,
      runExistsBody(existing.status),
    );
    return {
      kind: "wrong_state",
      command: "run",
      currentStatus: existing.status,
      runId: existing.id,
    };
  }

  // The Comment.create payload doesn't carry the issue body; we
  // round-trip to Linear for the fields the planner prompt + repo
  // resolver need. fetchIssue can throw — those are logged and the
  // failure surfaces back as a comment.
  let rawIssue: Awaited<ReturnType<typeof fetchIssue>>;
  const fetchFn = input.deps?.fetchIssue ?? fetchIssue;
  try {
    rawIssue = await fetchFn({
      accessToken: input.workspace.secrets.accessToken,
      issueId: input.issueId,
    });
  } catch (err) {
    console.error("[linear-command] fetchIssue failed for /run", {
      issueId: input.issueId,
      err,
    });
    await safeComment(
      input.workspace,
      input.issueId,
      runStartFailedBody("issue_fetch_failed"),
    );
    return {
      kind: "run_start_failed",
      command: "run",
      issueId: input.issueId,
      reason: "issue_fetch_failed",
    };
  }
  if (!rawIssue) {
    await safeComment(
      input.workspace,
      input.issueId,
      runStartFailedBody("issue_not_found"),
    );
    return {
      kind: "run_start_failed",
      command: "run",
      issueId: input.issueId,
      reason: "issue_not_found",
    };
  }

  const issue = parseLinearIssue(rawIssue);
  if (!issue) {
    await safeComment(
      input.workspace,
      input.issueId,
      runStartFailedBody("issue_not_found"),
    );
    return {
      kind: "run_start_failed",
      command: "run",
      issueId: input.issueId,
      reason: "issue_not_found",
    };
  }

  const repoRef = resolveRepo({
    issue,
    teamRepoMap: input.workspace.teamRepoMap,
  });
  if (!repoRef) {
    await safeComment(
      input.workspace,
      input.issueId,
      runStartFailedBody("unresolved_repo"),
    );
    return {
      kind: "run_start_failed",
      command: "run",
      issueId: input.issueId,
      reason: "unresolved_repo",
    };
  }

  const run = await Run.create({
    triggerSource: "linear",
    triggerRef: issue.id,
    specialistId: "planner",
    humanOwnerId: input.commenterUserId,
    sandboxPolicy: "fresh",
    repoRef,
    budgetUsdCapMicros: input.defaultBudgetUsdMicros,
  });

  const startWorkflow =
    input.deps?.startWorkflow ?? defaultStartLinearTriggeredWorkflow;
  try {
    await startWorkflow({
      agentRunId: run.id,
      taskText: buildTaskText(issue),
    });
  } catch (err) {
    // Workflow scheduler failed AFTER the Run row was inserted. The
    // row is now an orphaned `pending` — every subsequent `/run`
    // would hit it via getLatestRunByLinearIssue and be refused
    // with `wrong_state`, leaving the ticket stuck. Transition the
    // run to `failed` so the state machine reflects reality; the
    // lifecycle hook then reassigns the ticket to the human owner
    // alongside our explanatory comment below. The unassignment-
    // back-to-human is the recovery affordance — they can `/run`
    // again, or an admin can investigate the scheduler failure.
    console.error("[linear-command] workflow start failed", {
      runId: run.id,
      err,
    });
    await safeComment(
      input.workspace,
      input.issueId,
      runStartFailedBody("workflow_start_failed"),
    );
    await updateRunStatus(run.id, "failed").catch((statusErr) => {
      // Best-effort cleanup; if the status transition itself
      // fails the row stays pending but the explanatory comment
      // is already out so the user can still `/cancel` manually.
      console.error(
        "[linear-command] failed to mark run failed after workflow start error",
        {
          runId: run.id,
          err: statusErr,
        },
      );
    });
    return {
      kind: "run_start_failed",
      command: "run",
      issueId: input.issueId,
      reason: "workflow_start_failed",
    };
  }
  return {
    kind: "run_started",
    command: "run",
    runId: run.id,
    issueId: issue.id,
  };
}

// State-machine mapping for the three "resume/approve/reject/cancel"
// commands. Returns null when the command isn't valid in the run's
// current status (e.g. `/approve` on a `running` run, `/resume` on
// a `completed` run).
function transitionForCommand(
  command: LinearCommand,
  current: RunStatus,
): RunStatus | null {
  if (command === "approve") {
    return current === "awaiting_approval" ? "running" : null;
  }
  if (command === "reject") {
    return current === "awaiting_approval" ? "cancelled" : null;
  }
  if (command === "resume") {
    return current === "blocked" ? "running" : null;
  }
  if (command === "cancel") {
    return isTerminal(current) ? null : "cancelled";
  }
  return null; // "run" never reaches here
}

function isTerminal(status: RunStatus): boolean {
  return terminalStates.has(status);
}

async function safeComment(
  workspace: ResolvedLinearWorkspace,
  issueId: string,
  body: string,
): Promise<void> {
  await commentOnIssue({
    accessToken: workspace.secrets.accessToken,
    issueId,
    body,
  }).catch((err) => {
    console.error("[linear-command] failure-path comment failed", {
      issueId,
      err,
    });
  });
}

function unmappedActorBody(): string {
  return [
    "Nigel ignored this command: the commenter isn't linked to a Nigel user.",
    "",
    "To fix: sign in to Nigel and link your Linear account in /settings, then re-issue the command.",
  ].join("\n");
}

function noActiveRunBody(command: LinearCommand): string {
  return [
    `Nigel ignored \`/${command}\`: no active run is associated with this ticket.`,
    "",
    "To start one, reassign the ticket to the bot or post `/run`.",
  ].join("\n");
}

function unauthorizedBody(command: LinearCommand): string {
  return [
    `Nigel ignored \`/${command}\`: only the run's human owner can issue this command.`,
    "",
    "If you should own this run, ask an admin to update the run's owner.",
  ].join("\n");
}

function wrongStateBody(command: LinearCommand, current: RunStatus): string {
  const expected =
    command === "approve" || command === "reject"
      ? "awaiting_approval"
      : command === "resume"
        ? "blocked"
        : "non-terminal";
  return [
    `Nigel ignored \`/${command}\`: the run is currently \`${current}\`, but this command requires \`${expected}\`.`,
  ].join("\n");
}

function runExistsBody(current: RunStatus): string {
  return [
    `Nigel ignored \`/run\`: a run is already in progress on this ticket (\`${current}\`).`,
    "",
    "Wait for it to finish, or `/cancel` it first.",
  ].join("\n");
}

function runStartFailedBody(
  reason:
    | "unresolved_repo"
    | "issue_fetch_failed"
    | "issue_not_found"
    | "workflow_start_failed",
): string {
  if (reason === "unresolved_repo") {
    return [
      "Nigel couldn't start a run: no repo is mapped for this ticket.",
      "",
      "Add a `repo:owner/name` label or configure the team→repo map in /admin/linear.",
    ].join("\n");
  }
  if (reason === "issue_fetch_failed") {
    return "Nigel couldn't start a run: the Linear API is unreachable. Try again in a moment.";
  }
  if (reason === "workflow_start_failed") {
    return [
      "Nigel created the run row but the workflow scheduler errored. Marking the run as failed.",
      "",
      "Post `/run` again to retry. If it keeps failing, check the Vercel Workflow logs and contact ops.",
    ].join("\n");
  }
  return "Nigel couldn't start a run: this Linear issue is no longer accessible.";
}
