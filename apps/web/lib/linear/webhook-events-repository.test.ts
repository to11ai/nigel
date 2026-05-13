import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { webhookEvents } from "@/lib/db/schema";
import {
  claimWebhookEvent,
  getWebhookEventByExternalId,
  markWebhookEventProcessed,
} from "./webhook-events-repository";

beforeEach(async () => {
  await db.delete(webhookEvents);
});

describe("claimWebhookEvent", () => {
  test("inserts a row and returns it on first claim", async () => {
    const claimed = await claimWebhookEvent({
      source: "linear",
      externalId: "evt_abc",
    });
    expect(claimed).not.toBeNull();
    expect(claimed?.externalId).toBe("evt_abc");
    expect(claimed?.processedAt).toBeNull();
  });

  test("returns null on duplicate (source, externalId)", async () => {
    const first = await claimWebhookEvent({
      source: "linear",
      externalId: "evt_abc",
    });
    const second = await claimWebhookEvent({
      source: "linear",
      externalId: "evt_abc",
    });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    // Exactly one row exists.
    const rows = await db.select().from(webhookEvents);
    expect(rows).toHaveLength(1);
  });

  test("same externalId across different sources is NOT a duplicate", async () => {
    const a = await claimWebhookEvent({
      source: "linear",
      externalId: "shared-id",
    });
    const b = await claimWebhookEvent({
      source: "github",
      externalId: "shared-id",
    });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a?.id).not.toBe(b?.id);
  });
});

describe("markWebhookEventProcessed", () => {
  test("sets processed_at and optionally run_id", async () => {
    const claimed = await claimWebhookEvent({
      source: "linear",
      externalId: "evt_abc",
    });
    if (!claimed) throw new Error("claim returned null");
    await markWebhookEventProcessed({ id: claimed.id });
    const after = await db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.id, claimed.id))
      .limit(1);
    expect(after[0]?.processedAt).not.toBeNull();
    // Without runId supplied, the column stays null.
    expect(after[0]?.runId).toBeNull();
  });
});

describe("getWebhookEventByExternalId", () => {
  test("returns the row when claimed", async () => {
    await claimWebhookEvent({ source: "linear", externalId: "evt_abc" });
    const row = await getWebhookEventByExternalId({
      source: "linear",
      externalId: "evt_abc",
    });
    expect(row?.externalId).toBe("evt_abc");
  });

  test("returns null for an unknown external_id", async () => {
    const row = await getWebhookEventByExternalId({
      source: "linear",
      externalId: "nope",
    });
    expect(row).toBeNull();
  });
});
