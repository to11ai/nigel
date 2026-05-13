import { Run } from "@/lib/runs/create";
import {
  deriveExternalId,
  extractAssignmentToBot,
  type LinearWebhookEnvelope,
  linearWebhookEnvelopeSchema,
} from "./event-schema";
import { resolveHumanOwnerId } from "./owner-resolver";
import { resolveRepo } from "./repo-resolver";
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
    };

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
    // start it" without touching the Workflow SDK at all.
    startWorkflow?: (input: {
      agentRunId: string;
      taskText: string;
    }) => Promise<void>;
  };
};

export async function handleLinearWebhook(
  input: WebhookHandlerInput,
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

  const match = extractAssignmentToBot({
    envelope,
    botUserId: workspace.botUserId,
  });
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

// Produce the prompt for the planner from the Linear issue. The
// planner expects a self-contained task instruction; we include the
// issue identifier (e.g. PLAT-123) for traceability and the issue
// title + description verbatim. The planner's own prompt instructs
// it to re-state the task in its own words before decomposing.
function buildTaskText(issue: {
  identifier: string;
  title: string;
  description?: string | null;
  url?: string;
}): string {
  const body =
    issue.description && issue.description.trim().length > 0
      ? issue.description.trim()
      : "(no description on the ticket)";
  const lines: string[] = [
    `Linear ticket: ${issue.identifier} — ${issue.title}`,
    ...(issue.url ? [`Source: ${issue.url}`] : []),
    "",
    body,
  ];
  return lines.join("\n");
}

// Production starter — dynamic-import to avoid pulling the
// Workflow SDK + the workflow module into the test path. The
// `deps.startWorkflow` injection seam means tests never hit this.
async function defaultStartLinearTriggeredWorkflow(input: {
  agentRunId: string;
  taskText: string;
}): Promise<void> {
  const { start } = await import("workflow/api");
  const { runLinearTriggeredWorkflow } =
    await import("@/app/workflows/linear-trigger");
  await start(runLinearTriggeredWorkflow, [input]);
}
