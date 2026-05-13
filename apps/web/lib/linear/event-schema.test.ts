import { describe, expect, test } from "bun:test";
import {
  deriveExternalId,
  extractAssignmentToBot,
  linearWebhookEnvelopeSchema,
} from "./event-schema";

const BOT = "user-bot";

function makeAssignmentEnvelope(input: {
  newAssigneeId: string | null;
  type?: string;
  action?: string;
  actorId?: string;
  teamId?: string;
}): unknown {
  return {
    id: "evt_123",
    type: input.type ?? "Issue",
    action: input.action ?? "assignee_changed",
    actor: { id: input.actorId ?? "user-mattc" },
    data: {
      id: "iss_abc",
      identifier: "PLAT-1",
      title: "Fix the thing",
      teamId: input.teamId ?? "team-platform",
      assigneeId: input.newAssigneeId,
      creator: { id: "user-creator" },
    },
  };
}

describe("linearWebhookEnvelopeSchema", () => {
  test("parses a minimal envelope", () => {
    const parsed = linearWebhookEnvelopeSchema.parse({
      id: "evt_1",
      type: "Issue",
      action: "update",
      data: {},
    });
    expect(parsed.type).toBe("Issue");
    expect(parsed.id).toBe("evt_1");
  });

  test("strips unknown fields without complaining", () => {
    const parsed = linearWebhookEnvelopeSchema.parse({
      id: "evt_1",
      type: "Issue",
      data: {},
      // future Linear field we don't model
      newlyAddedField: { nested: true },
    });
    expect(parsed.type).toBe("Issue");
  });

  test("rejects payloads without a type", () => {
    expect(() =>
      linearWebhookEnvelopeSchema.parse({ id: "evt_1", data: {} }),
    ).toThrow();
  });
});

describe("deriveExternalId", () => {
  test("prefers deliveryId, then webhookId, then id", () => {
    expect(
      deriveExternalId({
        type: "Issue",
        deliveryId: "d1",
        webhookId: "w1",
        id: "i1",
        data: {},
      }),
    ).toBe("d1");
    expect(
      deriveExternalId({ type: "Issue", webhookId: "w1", id: "i1", data: {} }),
    ).toBe("w1");
    expect(deriveExternalId({ type: "Issue", id: "i1", data: {} })).toBe("i1");
  });

  test("returns null when no id field is set", () => {
    expect(deriveExternalId({ type: "Issue", data: {} })).toBeNull();
  });
});

describe("extractAssignmentToBot", () => {
  test("matches a `Issue.assignee_changed` with new assignee = bot", () => {
    const envelope = linearWebhookEnvelopeSchema.parse(
      makeAssignmentEnvelope({ newAssigneeId: BOT }),
    );
    const out = extractAssignmentToBot({ envelope, botUserId: BOT });
    expect(out).not.toBeNull();
    expect(out?.issue.id).toBe("iss_abc");
    expect(out?.actorId).toBe("user-mattc");
  });

  test("matches `Issue.update` with assigneeId at top level (alt envelope shape)", () => {
    const envelope = linearWebhookEnvelopeSchema.parse({
      id: "evt_1",
      type: "Issue",
      action: "update",
      actor: { id: "user-mattc" },
      assigneeId: BOT,
      data: {
        id: "iss_xyz",
        identifier: "PLAT-2",
        title: "Alt shape",
        teamId: "team-platform",
      },
    });
    const out = extractAssignmentToBot({ envelope, botUserId: BOT });
    expect(out).not.toBeNull();
    expect(out?.issue.id).toBe("iss_xyz");
  });

  test("returns null when new assignee is someone else", () => {
    const envelope = linearWebhookEnvelopeSchema.parse(
      makeAssignmentEnvelope({ newAssigneeId: "user-other" }),
    );
    expect(extractAssignmentToBot({ envelope, botUserId: BOT })).toBeNull();
  });

  test("returns null when new assignee is null (un-assignment)", () => {
    const envelope = linearWebhookEnvelopeSchema.parse(
      makeAssignmentEnvelope({ newAssigneeId: null }),
    );
    expect(extractAssignmentToBot({ envelope, botUserId: BOT })).toBeNull();
  });

  test("returns null for non-Issue event types", () => {
    const envelope = linearWebhookEnvelopeSchema.parse({
      id: "evt_1",
      type: "Comment",
      action: "create",
      data: {},
    });
    expect(extractAssignmentToBot({ envelope, botUserId: BOT })).toBeNull();
  });

  test("returns null for Issue events with unrelated actions", () => {
    const envelope = linearWebhookEnvelopeSchema.parse(
      makeAssignmentEnvelope({
        newAssigneeId: BOT,
        action: "remove",
      }),
    );
    expect(extractAssignmentToBot({ envelope, botUserId: BOT })).toBeNull();
  });
});
