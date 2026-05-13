import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db/client";
import {
  type NewWebhookEvent,
  type WebhookEvent,
  webhookEvents,
} from "@/lib/db/schema";

// Idempotency layer for inbound webhook events (Linear today; GitHub,
// Slack, etc. can reuse the same table). The unique index on
// `(source, external_id)` is what makes "process exactly once" safe
// — a second webhook with the same Linear `event.id` collides on
// insert and we noop.
//
// Lifecycle:
//   1. Webhook arrives → `claimWebhookEvent` tries to insert a row.
//      Returns `null` if the row already exists (duplicate delivery).
//      Returns the row otherwise.
//   2. Caller does its processing.
//   3. Caller calls `markWebhookEventProcessed` with the resulting
//      Run id (when a Run was created) or no id (when the event was
//      acknowledged but didn't produce a Run — e.g. a non-assignment
//      event we filtered out).
//
// The `processed_at` column is the durable record of "we finished
// handling this." `received_at` defaults to `now()`. A row where
// `processed_at IS NULL` indicates either an in-flight handler or a
// handler that crashed mid-processing; the operator UI can surface
// these for triage.

export type ClaimWebhookEventInput = {
  source: "linear" | "github" | "slack";
  externalId: string;
};

export async function claimWebhookEvent(
  input: ClaimWebhookEventInput,
): Promise<WebhookEvent | null> {
  // ON CONFLICT DO NOTHING means a duplicate delivery returns an empty
  // array. We surface that as `null` so callers don't have to inspect
  // the row themselves. Drizzle's `.returning()` returns `[]` rather
  // than a single null on conflict, hence the array check.
  const row: NewWebhookEvent = {
    id: nanoid(),
    source: input.source,
    externalId: input.externalId,
  };
  const inserted = await db
    .insert(webhookEvents)
    .values(row)
    .onConflictDoNothing({
      target: [webhookEvents.source, webhookEvents.externalId],
    })
    .returning();
  return inserted[0] ?? null;
}

export type MarkWebhookEventProcessedInput = {
  id: string;
  runId?: string | null;
};

export async function markWebhookEventProcessed(
  input: MarkWebhookEventProcessedInput,
): Promise<void> {
  await db
    .update(webhookEvents)
    .set({
      processedAt: new Date(),
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
    })
    .where(eq(webhookEvents.id, input.id));
}

export async function getWebhookEventByExternalId(input: {
  source: "linear" | "github" | "slack";
  externalId: string;
}): Promise<WebhookEvent | null> {
  const rows = await db
    .select()
    .from(webhookEvents)
    .where(
      and(
        eq(webhookEvents.source, input.source),
        eq(webhookEvents.externalId, input.externalId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}
