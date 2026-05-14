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
    // AppUserNotification puts these at the TOP level, not under
    // `data` (confirmed against linear/linear-agent-demo's
    // AgentNotificationWebhook type: { type, appUserId, notification,
    // webhookId }). Declared here so the matcher can read them
    // type-safely.
    appUserId: z.string().min(1).optional(),
    notification: z
      .object({
        type: z.string().min(1),
        issueId: z.string().min(1).optional(),
        issue: z
          .object({
            id: z.string().min(1),
            title: z.string().optional(),
            description: z.string().nullable().optional(),
          })
          .passthrough()
          .optional(),
        actor: linearActorSchema.optional(),
      })
      .passthrough()
      .optional(),
    // AgentSessionEvent: top-level `agentSession` carries the
    // session id and a `prompt` (initial user-typed text) plus an
    // `issue` ref. Linear delivers this when a user spawns a
    // session via the agent UI (assignee picker → app → optional
    // prompt). Keep permissive: passthrough so future fields don't
    // fail parse, and treat every nested field as optional except
    // the ones the matcher reads.
    agentSession: z
      .object({
        id: z.string().min(1),
        issue: z
          .object({
            id: z.string().min(1),
            title: z.string().optional(),
            description: z.string().nullable().optional(),
          })
          .passthrough()
          .optional(),
        creator: linearActorSchema.optional(),
        // The first user-typed prompt that opened the session. The
        // shape on the wire isn't 100% pinned across Linear API
        // revisions, so we accept either a plain string or an object
        // with a body field and let the extractor pick what's there.
        comment: z
          .union([z.string(), z.object({ body: z.string() }).passthrough()])
          .optional(),
        prompt: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type LinearWebhookEnvelope = z.infer<typeof linearWebhookEnvelopeSchema>;
export type LinearIssue = z.infer<typeof linearIssueSchema>;
export type LinearActor = z.infer<typeof linearActorSchema>;

export function parseLinearIssue(raw: unknown): LinearIssue | null {
  const result = linearIssueSchema.safeParse(raw);
  return result.success ? result.data : null;
}

// Pull the canonical external event ID for idempotency. Linear's
// authoritative per-delivery UUID is in the `Linear-Delivery` HTTP
// header — pass that in as `deliveryHeader` and it wins. The body
// fields are last-resort fallbacks for unusual Linear versions
// that omit the header.
//
// We do NOT fall back to `webhookId`: in current Linear payloads
// that field is the webhook SUBSCRIPTION UUID, constant across
// every event delivered to a given endpoint. Using it as the dedup
// key would treat the second event as a duplicate forever.
export function deriveExternalId(input: {
  envelope: LinearWebhookEnvelope;
  deliveryHeader: string | null;
}): string | null {
  if (input.deliveryHeader && input.deliveryHeader.length > 0) {
    return input.deliveryHeader;
  }
  if (input.envelope.deliveryId) return input.envelope.deliveryId;
  if (input.envelope.id) return input.envelope.id;
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

// AppUserNotification: delegation events.
//
// Linear migrated app-assignment from `Issue.assignee_changed`
// (which used `assigneeId`) to `AppUserNotification` (which fires
// `notification.type === "issueAssignedToYou"`). The user no longer
// becomes the "assignee" — they become the "delegate". Per Linear's
// agent docs and the linear-agent-demo sample, the on-the-wire
// event for delegation is:
//
//   {
//     type: "AppUserNotification",
//     appUserId: "<app's actor uuid>",  // TOP-LEVEL, not in data
//     notification: {                   // TOP-LEVEL, not in data
//       type: "issueAssignedToYou",
//       issueId: "...",
//       issue: { id, title, description },
//       actor: { id: <human who delegated> },  // optional
//     },
//     webhookId: "...",
//   }
//
// Important: AppUserNotification does NOT use the `data` wrapper
// that issue / comment events use. We read `env.appUserId` and
// `env.notification` directly (both declared on the envelope schema
// above so access is type-safe).
//
// Required for this to fire: the OAuth token must have been issued
// with the `app:assignable` scope AND the workspace's Linear app
// must subscribe to "Inbox notifications" webhook events.

export type ExtractedDelegation = {
  // Linear's AppUserNotification.issueAssignedToYou payload includes
  // only { id, title, description } per their NotificationIssue type
  // — the fields the repo resolver / planner prompt need (teamId,
  // attachments, labels) AREN'T present. The handler must call
  // fetchIssue to enrich. Returning just the id keeps this extractor
  // honest about what Linear actually delivers.
  issueId: string;
  actorId: string | null;
};

export function extractAppUserNotificationDelegation(input: {
  envelope: LinearWebhookEnvelope;
  botUserId: string;
}): ExtractedDelegation | null {
  const env = input.envelope;
  if (env.type !== "AppUserNotification") return null;

  // appUserId lives at the envelope TOP LEVEL, not in env.data
  // (confirmed against linear-agent-demo's AgentNotificationWebhook
  // type). Verify it matches our bot so a stray notification for a
  // different app installed in the same workspace doesn't trigger
  // our runs.
  if (env.appUserId !== input.botUserId) return null;

  // notification is also top-level.
  const notification = env.notification;
  if (!notification) return null;
  if (notification.type !== "issueAssignedToYou") return null;

  // Prefer the explicit issueId; fall back to the nested issue.id
  // for payload variants that omit it.
  const issueId = notification.issueId ?? notification.issue?.id ?? null;
  if (!issueId) return null;

  // The actor on a delegation is the human who set the app as the
  // delegate. Prefer envelope.actor; fall back to notification.actor
  // for shapes that nest it.
  const envelopeActor = env.actor?.id ?? null;
  const notificationActor = notification.actor?.id ?? null;
  return {
    issueId,
    actorId: envelopeActor ?? notificationActor,
  };
}

// Phase 6 L4: command-comment intake.
//
// Linear delivers a `Comment.create` event when anyone comments on
// an issue. We're interested in two conditions:
//   1. The comment's actor is NOT the bot (bot's own status comments
//      from the lifecycle path must not loop back as commands).
//   2. The body begins with a Nigel slash-command (see
//      `parseLinearCommand` for the syntax).
//
// `Comment.update` is intentionally NOT matched — editing a comment
// to add a slash-command after the fact would be surprising and
// allow re-triggering past commands by toggling an edit. Users have
// to post a fresh comment.

const linearCommentSchema = z
  .object({
    id: z.string().min(1),
    body: z.string(),
    issueId: z.string().min(1),
  })
  .passthrough();

export type LinearComment = z.infer<typeof linearCommentSchema>;

// AgentSessionEvent: Linear's first-class agent-session bootstrap.
//
// Fires when a user spawns a session against the app (assignee
// picker → app → optional prompt) OR when Linear's session UI is
// otherwise opened on an issue. Carries a session id we persist on
// the run so subsequent AgentActivity events route back to the
// same Linear-side UI surface.
//
// We do not require an `appUserId` match here the way
// AppUserNotification does, because the AgentSessionEvent envelope
// (per Linear's docs as of April 2026) doesn't include one — the
// session itself is the routing key, and Linear only delivers the
// event to the app the session was opened against.
//
// `prompt` is the user-typed initial message. We accept either a
// top-level `prompt` field OR a nested `comment.body` (current
// shape on Linear's wire). Both are optional — a session created
// without a prompt is normal (the user assigned the app and
// didn't type anything before hitting send).
export type ExtractedAgentSession = {
  agentSessionId: string;
  issueId: string;
  actorId: string | null;
  prompt: string | null;
};

export function extractAgentSessionCreated(input: {
  envelope: LinearWebhookEnvelope;
}): ExtractedAgentSession | null {
  const env = input.envelope;
  if (env.type !== "AgentSessionEvent") return null;
  if (env.action !== "created") return null;

  const session = env.agentSession;
  if (!session) return null;

  const issueId = session.issue?.id;
  if (!issueId) return null;

  // prompt may live at session.prompt or session.comment.body — try
  // both and pick the first non-empty.
  const promptFromTop = session.prompt;
  const promptFromComment =
    typeof session.comment === "string"
      ? session.comment
      : (session.comment?.body ?? null);
  const prompt = promptFromTop || promptFromComment || null;

  return {
    agentSessionId: session.id,
    issueId,
    actorId: session.creator?.id ?? env.actor?.id ?? null,
    prompt,
  };
}

export function extractCommandComment(input: {
  envelope: LinearWebhookEnvelope;
  botUserId: string;
}): { comment: LinearComment; actorId: string } | null {
  const env = input.envelope;
  if (env.type !== "Comment") return null;
  if (env.action !== "create") return null;
  const actorId = env.actor?.id ?? null;
  if (!actorId) return null; // un-attributed comments can't pass authority check
  if (actorId === input.botUserId) return null; // ignore the bot's own comments
  const parsed = linearCommentSchema.safeParse(env.data);
  if (!parsed.success) return null;
  return { comment: parsed.data, actorId };
}
