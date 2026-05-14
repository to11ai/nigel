import { describe, expect, test } from "bun:test";
import {
  deriveExternalId,
  extractAgentSessionCreated,
  extractAppUserNotificationDelegation,
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
  test("prefers the Linear-Delivery header above body fields", () => {
    expect(
      deriveExternalId({
        envelope: {
          type: "Issue",
          deliveryId: "body-d",
          id: "body-i",
          data: {},
        },
        deliveryHeader: "header-uuid-from-linear",
      }),
    ).toBe("header-uuid-from-linear");
  });

  test("falls back to body.deliveryId when header is missing", () => {
    expect(
      deriveExternalId({
        envelope: {
          type: "Issue",
          deliveryId: "body-d",
          id: "body-i",
          data: {},
        },
        deliveryHeader: null,
      }),
    ).toBe("body-d");
  });

  test("falls back to body.id when neither header nor body.deliveryId set", () => {
    expect(
      deriveExternalId({
        envelope: { type: "Issue", id: "body-i", data: {} },
        deliveryHeader: null,
      }),
    ).toBe("body-i");
  });

  test("ignores body.webhookId entirely — it is the SUBSCRIPTION uuid not per-event", () => {
    // Anti-regression: a previous version used webhookId as a
    // dedup key, which is constant across all events from a given
    // webhook. Every event after the first would silently be
    // treated as a duplicate and dropped.
    expect(
      deriveExternalId({
        envelope: { type: "Issue", webhookId: "subscription-uuid", data: {} },
        deliveryHeader: null,
      }),
    ).toBeNull();
  });

  test("returns null when neither header nor any body id field is set", () => {
    expect(
      deriveExternalId({
        envelope: { type: "Issue", data: {} },
        deliveryHeader: null,
      }),
    ).toBeNull();
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

  test("matches assignee_changed with assigneeId at top level (alt envelope shape)", () => {
    const envelope = linearWebhookEnvelopeSchema.parse({
      id: "evt_1",
      type: "Issue",
      action: "assignee_changed",
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

  test("ignores generic Issue.update events even when data.assigneeId === bot", () => {
    // Critical anti-regression: title/description edits on a
    // bot-assigned issue must NOT trigger a fresh Run.
    const envelope = linearWebhookEnvelopeSchema.parse({
      id: "evt_1",
      type: "Issue",
      action: "update",
      actor: { id: "user-mattc" },
      data: {
        id: "iss_already_bot",
        identifier: "PLAT-3",
        title: "User edited the title; assignee unchanged",
        teamId: "team-platform",
        // Bot was already the assignee — this `data` shape persists
        // across any field edit. Without filtering on action,
        // we'd spawn a Run on every edit.
        assigneeId: BOT,
        creator: { id: "user-creator" },
      },
    });
    expect(extractAssignmentToBot({ envelope, botUserId: BOT })).toBeNull();
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

  test("explicit null at top level does NOT fall through to data.assigneeId", () => {
    // Critical: when Linear sends `assigneeId: null` at the
    // envelope level (un-assignment), we must NOT fall back to
    // reading data.assigneeId — which could surface a stale bot ID
    // and falsely match.
    const envelope = linearWebhookEnvelopeSchema.parse({
      id: "evt_unassign",
      type: "Issue",
      action: "assignee_changed",
      actor: { id: "user-mattc" },
      assigneeId: null, // explicit un-assignment at envelope level
      data: {
        id: "iss_stale_bot",
        identifier: "PLAT-4",
        title: "Was bot-assigned, just un-assigned",
        teamId: "team-platform",
        assigneeId: BOT, // stale field in the embedded issue
      },
    });
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

describe("extractAppUserNotificationDelegation", () => {
  // Real-shape payload mirroring linear/linear-agent-demo's
  // AgentNotificationWebhook type. appUserId + notification live at
  // the envelope TOP LEVEL, NOT under data. Regression fixture for
  // the bug Bugbot caught: the original implementation read these
  // off env.data which would always be undefined for delegations.
  function makeDelegationEnvelope(input: {
    appUserId?: string;
    notificationType?: string;
    issueId?: string;
    issueIdNested?: boolean;
    actorAtEnvelope?: boolean;
    actorAtNotification?: boolean;
    actorId?: string;
  }): unknown {
    const issueId = input.issueId ?? "iss_xyz";
    const env: Record<string, unknown> = {
      id: "evt_delegate_1",
      type: "AppUserNotification",
      appUserId: input.appUserId ?? BOT,
      notification: {
        type: input.notificationType ?? "issueAssignedToYou",
        ...(input.issueIdNested
          ? { issue: { id: issueId, title: "Triage me" } }
          : { issueId }),
        ...(input.actorAtNotification
          ? { actor: { id: input.actorId ?? "user-mattc" } }
          : {}),
      },
      webhookId: "wh_456",
    };
    if (input.actorAtEnvelope) {
      env.actor = { id: input.actorId ?? "user-mattc" };
    }
    return env;
  }

  test("matches a freshly-delegated issue with envelope-level actor", () => {
    const envelope = linearWebhookEnvelopeSchema.parse(
      makeDelegationEnvelope({ actorAtEnvelope: true }),
    );
    const result = extractAppUserNotificationDelegation({
      envelope,
      botUserId: BOT,
    });
    expect(result).toEqual({ issueId: "iss_xyz", actorId: "user-mattc" });
  });

  test("falls back to notification.actor when envelope.actor is absent", () => {
    const envelope = linearWebhookEnvelopeSchema.parse(
      makeDelegationEnvelope({ actorAtNotification: true }),
    );
    const result = extractAppUserNotificationDelegation({
      envelope,
      botUserId: BOT,
    });
    expect(result?.actorId).toBe("user-mattc");
  });

  test("falls back to notification.issue.id when issueId is omitted", () => {
    const envelope = linearWebhookEnvelopeSchema.parse(
      makeDelegationEnvelope({
        issueIdNested: true,
        actorAtEnvelope: true,
      }),
    );
    const result = extractAppUserNotificationDelegation({
      envelope,
      botUserId: BOT,
    });
    expect(result?.issueId).toBe("iss_xyz");
  });

  test("returns null when appUserId doesn't match the bot (other app installed)", () => {
    const envelope = linearWebhookEnvelopeSchema.parse(
      makeDelegationEnvelope({ appUserId: "different-app-uuid" }),
    );
    expect(
      extractAppUserNotificationDelegation({ envelope, botUserId: BOT }),
    ).toBeNull();
  });

  test("returns null for non-issueAssignedToYou notification types", () => {
    const envelope = linearWebhookEnvelopeSchema.parse(
      makeDelegationEnvelope({ notificationType: "issueNewComment" }),
    );
    expect(
      extractAppUserNotificationDelegation({ envelope, botUserId: BOT }),
    ).toBeNull();
  });

  test("returns null for non-AppUserNotification envelope types", () => {
    const envelope = linearWebhookEnvelopeSchema.parse({
      id: "evt_x",
      type: "Issue",
      action: "assignee_changed",
      data: {},
    });
    expect(
      extractAppUserNotificationDelegation({ envelope, botUserId: BOT }),
    ).toBeNull();
  });

  // Regression: the original implementation read env.data.appUserId
  // instead of env.appUserId. An AppUserNotification payload without
  // a `data` wrapper would silently return null. This test pins the
  // real-shape access path.
  test("does NOT rely on env.data — appUserId/notification at top level only", () => {
    const rawWithNoData: unknown = {
      id: "evt_no_data",
      type: "AppUserNotification",
      appUserId: BOT,
      notification: {
        type: "issueAssignedToYou",
        issueId: "iss_pinned",
      },
      actor: { id: "user-mattc" },
      webhookId: "wh_no_data",
    };
    const envelope = linearWebhookEnvelopeSchema.parse(rawWithNoData);
    const result = extractAppUserNotificationDelegation({
      envelope,
      botUserId: BOT,
    });
    expect(result).toEqual({ issueId: "iss_pinned", actorId: "user-mattc" });
  });
});

describe("extractAgentSessionCreated", () => {
  // Real-shape AgentSessionEvent envelope: type at envelope top
  // level, agentSession block carries id + issue + creator. The
  // prompt field shape isn't pinned across Linear API versions —
  // we accept either a top-level `prompt` string or a nested
  // `comment.body` object/string.
  function makeSessionEnvelope(input: {
    action?: string;
    sessionId?: string;
    issueId?: string;
    creatorId?: string;
    prompt?: string;
    commentBody?: string;
    commentAsString?: boolean;
  }): unknown {
    const session: Record<string, unknown> = {
      id: input.sessionId ?? "agent-session-xyz",
      issue: { id: input.issueId ?? "iss_xyz", title: "Triage me" },
    };
    if (input.creatorId) session.creator = { id: input.creatorId };
    if (input.prompt) session.prompt = input.prompt;
    if (input.commentBody) {
      session.comment = input.commentAsString
        ? input.commentBody
        : { body: input.commentBody };
    }
    return {
      id: "evt_session_1",
      type: "AgentSessionEvent",
      action: input.action ?? "created",
      agentSession: session,
    };
  }

  test("matches a freshly-created session with creator id", () => {
    const envelope = linearWebhookEnvelopeSchema.parse(
      makeSessionEnvelope({ creatorId: "user-mattc" }),
    );
    expect(extractAgentSessionCreated({ envelope })).toEqual({
      agentSessionId: "agent-session-xyz",
      issueId: "iss_xyz",
      actorId: "user-mattc",
      prompt: null,
    });
  });

  test("extracts a prompt from session.prompt", () => {
    const envelope = linearWebhookEnvelopeSchema.parse(
      makeSessionEnvelope({ prompt: "fix this bug please" }),
    );
    expect(extractAgentSessionCreated({ envelope })?.prompt).toBe(
      "fix this bug please",
    );
  });

  test("extracts a prompt from session.comment.body when prompt is absent", () => {
    const envelope = linearWebhookEnvelopeSchema.parse(
      makeSessionEnvelope({ commentBody: "look at the auth path" }),
    );
    expect(extractAgentSessionCreated({ envelope })?.prompt).toBe(
      "look at the auth path",
    );
  });

  test("accepts session.comment as a plain string", () => {
    const envelope = linearWebhookEnvelopeSchema.parse(
      makeSessionEnvelope({
        commentBody: "stringy prompt",
        commentAsString: true,
      }),
    );
    expect(extractAgentSessionCreated({ envelope })?.prompt).toBe(
      "stringy prompt",
    );
  });

  test("returns null for actions other than 'created'", () => {
    const envelope = linearWebhookEnvelopeSchema.parse(
      makeSessionEnvelope({ action: "updated" }),
    );
    expect(extractAgentSessionCreated({ envelope })).toBeNull();
  });

  test("returns null for non-AgentSessionEvent envelope types", () => {
    const envelope = linearWebhookEnvelopeSchema.parse({
      id: "evt_x",
      type: "Issue",
      action: "create",
      data: { id: "iss_1", teamId: "team-1", title: "x", identifier: "X-1" },
    });
    expect(extractAgentSessionCreated({ envelope })).toBeNull();
  });

  test("returns null when agentSession.issue.id is missing", () => {
    const envelope = linearWebhookEnvelopeSchema.parse({
      id: "evt_session_2",
      type: "AgentSessionEvent",
      action: "created",
      agentSession: { id: "session-x" },
    });
    expect(extractAgentSessionCreated({ envelope })).toBeNull();
  });

  test("falls back to envelope.actor when session.creator is absent", () => {
    const raw: unknown = {
      id: "evt_session_3",
      type: "AgentSessionEvent",
      action: "created",
      actor: { id: "user-envelope-actor" },
      agentSession: {
        id: "session-y",
        issue: { id: "iss_y" },
      },
    };
    const envelope = linearWebhookEnvelopeSchema.parse(raw);
    expect(extractAgentSessionCreated({ envelope })?.actorId).toBe(
      "user-envelope-actor",
    );
  });
});
