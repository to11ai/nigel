import { z } from "zod";

// Phase 6 L2: Linear webhook payload schema.
//
// We parse only the minimal subset we need to make trigger
// decisions. Linear's webhook payload is large and adds fields
// over time; Zod's default behavior is to strip unknown fields, so
// we accept anything Linear hands us and only fail when the
// fields we *do* read have wrong shapes.
//
// Reference: https://developers.linear.app/docs/graphql/webhooks
//
// We model `IssueAssigneeChanged` explicitly because it's the
// trigger this PR cares about. The broader `LinearWebhookEvent`
// union accepts any other event type and lets the handler decide
// to ignore it without parsing. Future phases will add Comment +
// command schemas here.

const linearActorSchema = z
  .object({
    id: z.string().min(1),
  })
  .passthrough();

const linearLabelSchema = z
  .object({
    name: z.string(),
  })
  .passthrough();

// The `assignee_changed` payload contains the issue body and the
// `oldAssignee` / `newAssignee` references plus an `actor` for the
// user who made the change. We keep the schema permissive: a
// missing `oldAssignee` is normal (when the issue had no assignee
// before), and `newAssignee` can also be null (when un-assigning).
const linearIssueSchema = z
  .object({
    id: z.string().min(1),
    identifier: z.string().min(1),
    title: z.string(),
    description: z.string().nullable().optional(),
    teamId: z.string().min(1),
    url: z.string().url().optional(),
    creator: linearActorSchema.nullable().optional(),
    labels: z.array(linearLabelSchema).optional(),
    // GitHub link surfaced by Linear's native integration. The
    // attachment schema varies by Linear version; we look for a
    // `metadata.url` pattern of `https://github.com/<owner>/<repo>`.
    attachments: z
      .array(
        z
          .object({
            url: z.string().optional(),
            metadata: z
              .object({ url: z.string().optional() })
              .passthrough()
              .optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

// The webhook delivery itself. `type` discriminates; `action`
// further qualifies. We model just what L2 reads.
export const linearWebhookEnvelopeSchema = z
  .object({
    // Top-level event identifier — used for dedup against the
    // `webhook_events` table. Linear documents this as `webhookId`
    // historically; current deliveries use `id` at the envelope
    // root. We accept either and pick the first non-empty.
    id: z.string().min(1).optional(),
    webhookId: z.string().min(1).optional(),
    deliveryId: z.string().min(1).optional(),
    type: z.string().min(1),
    action: z.string().min(1).optional(),
    organizationId: z.string().min(1).optional(),
    actor: linearActorSchema.optional(),
    // The event payload. For issue events this is the issue itself;
    // for comment events it's the comment with the issue nested.
    // We accept either shape and let the handler extract what it
    // needs.
    data: z.unknown(),
    // Some envelope shapes include `assigneeId` / `oldAssigneeId`
    // at the top level for `Issue.assignee_changed` rather than
    // nested in `data`. Capture both forms.
    assigneeId: z.string().nullable().optional(),
    oldAssigneeId: z.string().nullable().optional(),
  })
  .passthrough();

export type LinearWebhookEnvelope = z.infer<typeof linearWebhookEnvelopeSchema>;
export type LinearIssue = z.infer<typeof linearIssueSchema>;
export type LinearActor = z.infer<typeof linearActorSchema>;

export function parseLinearIssue(raw: unknown): LinearIssue | null {
  const result = linearIssueSchema.safeParse(raw);
  return result.success ? result.data : null;
}

// Pull the canonical external event ID for idempotency. Falls back
// across the three field names Linear has used in their docs and
// current deliveries.
export function deriveExternalId(env: LinearWebhookEnvelope): string | null {
  if (env.deliveryId) return env.deliveryId;
  if (env.webhookId) return env.webhookId;
  if (env.id) return env.id;
  return null;
}

// Is this an `Issue.assignee_changed` event where the new assignee
// is the bot? Returns the issue + the actor when it matches.
// Returns `null` for any other event so the route can quietly
// acknowledge and move on without further work.
//
// Restricted to `assignee_changed` — NOT generic `Issue.update`.
// The `data` payload of a generic update always contains the full
// issue object including the current `assigneeId`; any title /
// description edit on an already-bot-assigned issue would falsely
// match and spawn a fresh `pending` Run. Only the dedicated
// `assignee_changed` action carries the "the assignment itself
// just changed" semantic the spec relies on.
//
// We do still tolerate the assigneeId being supplied either at the
// envelope top level or nested in `data`. For `assignee_changed`
// both refer to the new assignee, so there's no ambiguity.
export function extractAssignmentToBot(input: {
  envelope: LinearWebhookEnvelope;
  botUserId: string;
}): { issue: LinearIssue; actorId: string | null } | null {
  const env = input.envelope;
  if (env.type !== "Issue") return null;
  if (env.action !== "assignee_changed") return null;
  // Use an explicit-`undefined` check rather than `??`: when the
  // envelope's top-level `assigneeId` is explicitly `null`, that
  // means "the new assignee is nobody (un-assignment)" and we must
  // NOT fall through to `data.assigneeId` — which could otherwise
  // surface a stale value and produce a false match.
  const newAssigneeId =
    env.assigneeId !== undefined
      ? env.assigneeId
      : isObject(env.data)
        ? (env.data.assigneeId as string | null | undefined)
        : undefined;
  if (newAssigneeId !== input.botUserId) return null;
  const issue = parseLinearIssue(env.data);
  if (!issue) return null;
  return { issue, actorId: env.actor?.id ?? null };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object";
}
