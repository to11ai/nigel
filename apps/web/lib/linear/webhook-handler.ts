import { startWebhookSpan } from "@/lib/observability/webhook-span";
import { Run } from "@/lib/runs/create";
import { commentOnIssue, fetchIssue, reassignIssue } from "./client";
import {
  type CommandHandlerDeps,
  type CommandHandlerOutcome,
  handleLinearCommandComment,
} from "./command-handler";
import {
  deriveExternalId,
  extractAppUserNotificationDelegation,
  extractAssignmentToBot,
  extractCommandComment,
  type LinearIssue,
  type LinearWebhookEnvelope,
  linearWebhookEnvelopeSchema,
  parseLinearIssue,
} from "./event-schema";
import { resolveHumanOwnerId } from "./owner-resolver";
import { resolveRepo } from "./repo-resolver";
import {
  buildTaskText,
  defaultStartLinearTriggeredWorkflow,
} from "./run-trigger";
import { verifyLinearSignature } from "./signature";
import {
  claimWebhookEvent,
  markWebhookEventProcessed,
} from "./webhook-events-repository";
import {
  type ResolvedLinearWorkspace,
  resolveLinearWorkspace,
} from "./workspace-repository";

// Phase 6 L2: webhook orchestration.
//
// Returns an `outcome` describing what happened so the route handler
// can serialize it to status + body, and tests can assert without
// inspecting HTTP details. Every outcome is a 200 to Linear; even
// failure paths ack so Linear doesn't retry against the same
// already-recorded event.
//
// The execution wiring (kicking off the planner workflow against the
// created Run) is intentionally deferred to a follow-up sub-phase.
// L2 only intakes the event and creates the Run row in `pending`.
// A separate executor will pick up `pending` linear-triggered runs
// and start the workflow. This keeps the webhook handler small,
// testable in isolation, and free of workflow-runtime coupling.

export type WebhookHandlerOutcome =
  | { kind: "signature_mismatch" }
  | { kind: "no_workspace_configured" }
  | { kind: "invalid_payload"; reason: string }
  | { kind: "duplicate"; externalId: string }
  | { kind: "ignored"; reason: string }
  | {
      kind: "unresolved_repo";
      issueId: string;
      teamId: string;
    }
  | {
      kind: "unresolved_owner";
      issueId: string;
      actorId: string | null;
      creatorId: string | null;
    }
  | {
      kind: "run_created";
      runId: string;
      issueId: string;
      repoRef: string;
      humanOwnerId: string;
    }
  // Phase 6 L4: command-comment outcomes. The wrapped
  // `CommandHandlerOutcome` carries the detail; the webhook handler
  // only knows that the comment flow ran (or didn't apply).
  | { kind: "command"; outcome: CommandHandlerOutcome };

export type WebhookHandlerInput = {
  rawBody: string;
  signatureHeader: string | null;
  // Linear's per-delivery UUID, sent in the `Linear-Delivery`
  // header. This is the authoritative idempotency key — body
  // fields are fallbacks for older payload shapes. The route
  // reads the header and passes it through; tests inject directly.
  deliveryHeader: string | null;
  // Per-Run default budget. The spec calls this
  // `org.default_budget_usd`; until the budget admin UI ships we
  // accept it as a parameter so tests can pin a value and the route
  // can read from env.
  defaultBudgetUsdMicros: number;
  // Test-injection seam. Production defaults route through
  // `resolveLinearWorkspace`; tests inject a synthetic workspace
  // without touching the DB-encryption path.
  deps?: {
    resolveWorkspace?: () => Promise<ResolvedLinearWorkspace | null>;
    // The webhook handler kicks off the planner workflow via this
    // callback. Production wires `start(runLinearTriggeredWorkflow,
    // ...)`; tests pass a spy so the assertion is "we tried to
    // start it" without touching the Workflow SDK at all. Shared by
    // the assignment path and the L4 `/run` comment-command path.
    startWorkflow?: CommandHandlerDeps["startWorkflow"];
    // L4 `/run` injection seam. The command handler round-trips to
    // Linear's GraphQL API to pull the issue body; tests stub this
    // so CI doesn't need network access. Forwarded into the
    // command-handler's deps below.
    fetchIssue?: CommandHandlerDeps["fetchIssue"];
  };
};

export async function handleLinearWebhook(
  input: WebhookHandlerInput,
): Promise<WebhookHandlerOutcome> {
  // The span wraps the whole intake so Datadog records latency +
  // outcome counts. Started here (before signature verification)
  // because signature failures are themselves a metric the
  // dashboard should show. envelopeType is resolved inside the
  // body (after JSON parse succeeds) via a captured `let` so the
  // finish call can stamp it.
  const span = startWebhookSpan({
    source: "linear",
    externalId: input.deliveryHeader,
  });
  // biome-ignore lint/style/useConst: assigned inside the try block after parsing
  let envelopeType: string | null = null;
  try {
    // Phase 7 L2: run inside the span's active context so every
    // downstream span (auto-instrumented http client fetches to
    // api.linear.app / api.github.com, manual run.status_change
    // spans emitted by updateRunStatus, future tool spans from
    // the command handler) nests under this intake span.
    const outcome = await span.runInContext(() =>
      runHandler(input, (type) => {
        envelopeType = type;
      }),
    );
    span.finish({
      outcomeKind: outcome.kind,
      runId: extractRunId(outcome),
      outcomeReason: extractOutcomeReason(outcome),
      envelopeType,
    });
    return outcome;
  } catch (err) {
    span.fail(err);
    throw err;
  }
}

function extractRunId(outcome: WebhookHandlerOutcome): string | null {
  if (outcome.kind === "run_created") return outcome.runId;
  if (outcome.kind === "command") {
    const inner = outcome.outcome;
    if (inner.kind === "transitioned" || inner.kind === "run_started") {
      return inner.runId;
    }
    if (inner.kind === "run_start_failed" && inner.runId) {
      return inner.runId;
    }
  }
  return null;
}

function extractOutcomeReason(outcome: WebhookHandlerOutcome): string | null {
  if (outcome.kind === "invalid_payload") return outcome.reason;
  if (outcome.kind === "ignored") return outcome.reason;
  if (outcome.kind === "command") return outcome.outcome.kind;
  return null;
}

async function runHandler(
  input: WebhookHandlerInput,
  // Callback used by the entrypoint to stamp the envelope type onto
  // the intake span once JSON parsing succeeds. Pulled out as a
  // callback rather than threading the span object so runHandler
  // stays decoupled from the observability layer.
  setEnvelopeType: (type: string) => void,
): Promise<WebhookHandlerOutcome> {
  const workspaceFn = input.deps?.resolveWorkspace ?? resolveLinearWorkspace;
  const workspace = await workspaceFn();
  if (!workspace) {
    return { kind: "no_workspace_configured" };
  }

  if (
    !verifyLinearSignature({
      rawBody: input.rawBody,
      signatureHeader: input.signatureHeader,
      webhookSecret: workspace.secrets.webhookSecret,
    })
  ) {
    return { kind: "signature_mismatch" };
  }

  let envelope: LinearWebhookEnvelope;
  try {
    envelope = linearWebhookEnvelopeSchema.parse(JSON.parse(input.rawBody));
  } catch (err) {
    return {
      kind: "invalid_payload",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  setEnvelopeType(envelope.type);

  const externalId = deriveExternalId({
    envelope,
    deliveryHeader: input.deliveryHeader,
  });
  if (!externalId) {
    return {
      kind: "invalid_payload",
      reason: "no Linear-Delivery header and no event id in envelope",
    };
  }

  const claim = await claimWebhookEvent({
    source: "linear",
    externalId,
  });
  if (!claim) {
    return { kind: "duplicate", externalId };
  }

  // L4: comment-command events branch here. Comment.create from a
  // non-bot actor with a recognized slash-command body becomes a
  // command intake. Anything else falls through to the assignment
  // matcher.
  const commentMatch = extractCommandComment({
    envelope,
    botUserId: workspace.botUserId,
  });
  if (commentMatch) {
    const commandDeps: CommandHandlerDeps = {};
    if (input.deps?.startWorkflow) {
      commandDeps.startWorkflow = input.deps.startWorkflow;
    }
    if (input.deps?.fetchIssue) {
      commandDeps.fetchIssue = input.deps.fetchIssue;
    }
    const commandOutcome = await handleLinearCommandComment({
      workspace,
      commentBody: commentMatch.comment.body,
      issueId: commentMatch.comment.issueId,
      actorId: commentMatch.actorId,
      defaultBudgetUsdMicros: input.defaultBudgetUsdMicros,
      deps: commandDeps,
    });
    // Pick the run id from whichever outcome carries one. The
    // `run_start_failed.workflow_start_failed` branch has a runId
    // because Run.create persisted before startWorkflow threw — link
    // the event to it so the orphan is discoverable from the webhook
    // events table even if the best-effort updateRunStatus(failed)
    // also fails.
    const runId =
      commandOutcome.kind === "run_started" ||
      commandOutcome.kind === "transitioned"
        ? commandOutcome.runId
        : commandOutcome.kind === "run_start_failed"
          ? commandOutcome.runId
          : undefined;
    await markWebhookEventProcessed(
      runId === undefined ? { id: claim.id } : { id: claim.id, runId },
    );
    return { kind: "command", outcome: commandOutcome };
  }

  // AppUserNotification delegation events fire when an issue is
  // assigned to the app via Linear's new agent-delegation flow
  // (requires the `app:assignable` OAuth scope). The notification
  // payload only carries { issueId, actorId } — we fetch the full
  // issue ourselves to get teamId / attachments / labels for repo
  // resolution.
  const delegation = extractAppUserNotificationDelegation({
    envelope,
    botUserId: workspace.botUserId,
  });
  let match = extractAssignmentToBot({
    envelope,
    botUserId: workspace.botUserId,
  });
  // Track which intake path produced `match` so the failure paths
  // below can pick the right cleanup. Assignments need
  // `reassignIssue` (mutates `assigneeId`); delegations need NO
  // mutation since the bot is the `delegate`, not the `assignee` —
  // `reassignIssue` would silently no-op AND would also stamp the
  // actor as assignee, which they weren't before. The right
  // delegation-cleanup mutation (issueUpdate clearing delegate)
  // isn't wired yet; deferred to the agent-session follow-up. For
  // now delegation failures post a comment only and let the user
  // un-delegate manually.
  const matchKind: "assignment" | "delegation" =
    match || !delegation ? "assignment" : "delegation";
  if (delegation && !match) {
    const fetchFn = input.deps?.fetchIssue ?? fetchIssue;
    let rawIssue: Awaited<ReturnType<typeof fetchIssue>>;
    try {
      rawIssue = await fetchFn({
        accessToken: workspace.secrets.accessToken,
        issueId: delegation.issueId,
      });
    } catch (err) {
      await markWebhookEventProcessed({ id: claim.id });
      console.error("[linear-webhook] fetchIssue failed for delegation", {
        issueId: delegation.issueId,
        err,
      });
      return {
        kind: "invalid_payload",
        reason: `delegation issue fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (!rawIssue) {
      await markWebhookEventProcessed({ id: claim.id });
      return {
        kind: "invalid_payload",
        reason: `delegation issue not found: ${delegation.issueId}`,
      };
    }
    const enriched: LinearIssue | null = parseLinearIssue(rawIssue);
    if (!enriched) {
      await markWebhookEventProcessed({ id: claim.id });
      return {
        kind: "invalid_payload",
        reason: `delegation issue payload did not parse: ${delegation.issueId}`,
      };
    }
    match = { issue: enriched, actorId: delegation.actorId };
  }

  if (!match) {
    await markWebhookEventProcessed({ id: claim.id });
    return {
      kind: "ignored",
      reason: `not an assignment-to-bot event (type=${envelope.type} action=${envelope.action ?? "none"})`,
    };
  }

  const repoRef = resolveRepo({
    issue: match.issue,
    teamRepoMap: workspace.teamRepoMap,
  });
  if (!repoRef) {
    await markWebhookEventProcessed({ id: claim.id });
    // Surface the rejection back to the Linear actor with a comment.
    // For assignments we ALSO call reassignIssue so the bot stops
    // appearing as assignee; for delegations we skip the reassign
    // (it would set `assigneeId`, not clear `delegate`, and the
    // actor was never the assignee in the first place). Failures
    // here are best-effort — if the Linear API is unhealthy, the
    // outcome is still logged and the run simply isn't created.
    await postRepoUnresolvedComment({
      workspace,
      issueId: match.issue.id,
      teamId: match.issue.teamId,
      reassignTo: matchKind === "assignment" ? match.actorId : null,
      skipReassign: matchKind === "delegation",
    }).catch((err) => {
      console.error("[linear-webhook] failed to post unresolved_repo comment", {
        issueId: match.issue.id,
        err,
      });
    });
    return {
      kind: "unresolved_repo",
      issueId: match.issue.id,
      teamId: match.issue.teamId,
    };
  }

  const creatorId = match.issue.creator?.id ?? null;
  const humanOwnerId = await resolveHumanOwnerId({
    actorId: match.actorId,
    creatorId,
    botUserId: workspace.botUserId,
  });
  if (!humanOwnerId) {
    await markWebhookEventProcessed({ id: claim.id });
    await postOwnerUnresolvedComment({
      workspace,
      issueId: match.issue.id,
      actorId: match.actorId,
      reassignTo: matchKind === "assignment" ? match.actorId : null,
      skipReassign: matchKind === "delegation",
    }).catch((err) => {
      console.error(
        "[linear-webhook] failed to post unresolved_owner comment",
        {
          issueId: match.issue.id,
          err,
        },
      );
    });
    return {
      kind: "unresolved_owner",
      issueId: match.issue.id,
      actorId: match.actorId,
      creatorId,
    };
  }

  const run = await Run.create({
    triggerSource: "linear",
    triggerRef: match.issue.id,
    specialistId: "planner",
    humanOwnerId,
    // Top-level Linear runs need a fresh sandbox of their own —
    // L2b's `provisionFreshSandboxForRun` does the actual clone.
    // `inherit` was a placeholder before L2b shipped; now the
    // workflow uses fresh.
    sandboxPolicy: "fresh",
    repoRef,
    budgetUsdCapMicros: input.defaultBudgetUsdMicros,
  });

  await markWebhookEventProcessed({ id: claim.id, runId: run.id });

  // Kick off the planner workflow asynchronously. The Workflow SDK's
  // `start()` returns once the workflow is enqueued — it does NOT
  // block on completion. The webhook response will land on Linear's
  // doorstep within milliseconds; the actual planner run takes
  // minutes and runs out-of-band.
  const startWorkflow =
    input.deps?.startWorkflow ?? defaultStartLinearTriggeredWorkflow;
  try {
    await startWorkflow({
      agentRunId: run.id,
      taskText: buildTaskText(match.issue),
    });
  } catch (err) {
    // The Run row exists and is in `pending`. If workflow-start
    // failed, log loudly so ops can manually retry from the admin
    // UI later. We don't fail the outcome — the row is the audit
    // record, the workflow can be retried.
    console.error("[linear-webhook] workflow start failed", {
      runId: run.id,
      err,
    });
  }

  return {
    kind: "run_created",
    runId: run.id,
    issueId: match.issue.id,
    repoRef,
    humanOwnerId,
  };
}

// Comment + reassign for the `unresolved_repo` failure path. The
// reassignTo can be `null` (actor unknown) — Linear's API accepts
// `null` as "un-assign", which is correct: leaving the bot
// assigned would mean the issue's owner is a non-acting account.
async function postRepoUnresolvedComment(input: {
  workspace: ResolvedLinearWorkspace;
  issueId: string;
  teamId: string;
  reassignTo: string | null;
  // True for delegation events: the bot occupies `delegate`, not
  // `assignee`, so reassignIssue (which sets assigneeId) is a no-op
  // on the bot AND incorrectly stamps the would-be actor as
  // assignee. The proper delegate-clearing mutation isn't wired
  // yet — admin removes the delegate manually for now.
  skipReassign: boolean;
}): Promise<void> {
  const body = [
    "Nigel rejected this assignment: no repo is mapped for this team.",
    "",
    "To fix:",
    `- Add team \`${input.teamId}\` to the team→repo map in /admin/linear, OR`,
    "- Add a `repo:owner/name` label to this issue.",
    "",
    input.skipReassign
      ? "Please un-delegate Nigel manually — the bot doesn't auto-clear delegate yet."
      : "Reassigning back so the bot doesn't stay on the ticket.",
  ].join("\n");
  // Comment and reassign are independent best-effort calls. A failed
  // comment must NOT skip the reassign — otherwise the bot stays
  // assigned to a ticket Nigel just rejected. Same pattern as
  // lib/runs/lifecycle.ts handleLinearLifecycle.
  await commentOnIssue({
    accessToken: input.workspace.secrets.accessToken,
    issueId: input.issueId,
    body,
  }).catch((err) => {
    console.error("[linear-webhook] commentOnIssue failed (unresolved_repo)", {
      issueId: input.issueId,
      err,
    });
  });
  if (!input.skipReassign) {
    await reassignIssue({
      accessToken: input.workspace.secrets.accessToken,
      issueId: input.issueId,
      assigneeId: input.reassignTo,
    }).catch((err) => {
      console.error("[linear-webhook] reassignIssue failed (unresolved_repo)", {
        issueId: input.issueId,
        err,
      });
    });
  }
}

async function postOwnerUnresolvedComment(input: {
  workspace: ResolvedLinearWorkspace;
  issueId: string;
  actorId: string | null;
  reassignTo: string | null;
  // See postRepoUnresolvedComment.skipReassign.
  skipReassign: boolean;
}): Promise<void> {
  const body = [
    "Nigel rejected this assignment: the actor isn't linked to a Nigel user.",
    "",
    "To fix: sign in to Nigel and link your Linear account in /settings, then re-assign the issue to the bot.",
    "",
    input.skipReassign
      ? "Please un-delegate Nigel manually — the bot doesn't auto-clear delegate yet."
      : "Reassigning back so the bot doesn't stay on the ticket.",
  ].join("\n");
  // Independent best-effort: see comment in postRepoUnresolvedComment.
  await commentOnIssue({
    accessToken: input.workspace.secrets.accessToken,
    issueId: input.issueId,
    body,
  }).catch((err) => {
    console.error("[linear-webhook] commentOnIssue failed (unresolved_owner)", {
      issueId: input.issueId,
      err,
    });
  });
  if (!input.skipReassign) {
    await reassignIssue({
      accessToken: input.workspace.secrets.accessToken,
      issueId: input.issueId,
      assigneeId: input.reassignTo,
    }).catch((err) => {
      console.error(
        "[linear-webhook] reassignIssue failed (unresolved_owner)",
        {
          issueId: input.issueId,
          err,
        },
      );
    });
  }
}
