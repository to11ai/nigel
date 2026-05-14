import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac, randomBytes } from "node:crypto";
import { db } from "@/lib/db/client";
import {
  agentRuns,
  linearWorkspace,
  users,
  webhookEvents,
} from "@/lib/db/schema";
import { resetEncryptionKeyCacheForTests } from "@/lib/tool-connections/encryption";
import {
  handleLinearWebhook,
  type WebhookHandlerOutcome,
} from "./webhook-handler";
import type { ResolvedLinearWorkspace } from "./workspace-repository";

const ORIGINAL_KEY = process.env.TOOL_CONNECTIONS_ENC_KEY;
const TEST_KEY_B64 = randomBytes(32).toString("base64");

const TEST_USER_ID = "test-user-linear-webhook";
const TEST_LINEAR_ID = "linear-user-mattc";
const BOT_LINEAR_ID = "linear-user-bot";
const SECRET = "whsec_test_signing";

beforeEach(async () => {
  process.env.TOOL_CONNECTIONS_ENC_KEY = TEST_KEY_B64;
  resetEncryptionKeyCacheForTests();
  await db.delete(agentRuns);
  await db.delete(webhookEvents);
  await db.delete(linearWorkspace);
  await db
    .insert(users)
    .values({
      id: TEST_USER_ID,
      username: "linear-webhook-test",
      email: "linear@test.example",
      linearUserId: TEST_LINEAR_ID,
    })
    .onConflictDoUpdate({
      target: users.id,
      set: { linearUserId: TEST_LINEAR_ID },
    });
});

afterEach(() => {
  if (ORIGINAL_KEY === undefined) {
    delete process.env.TOOL_CONNECTIONS_ENC_KEY;
  } else {
    process.env.TOOL_CONNECTIONS_ENC_KEY = ORIGINAL_KEY;
  }
  resetEncryptionKeyCacheForTests();
});

// All tests inject a synthetic `resolveWorkspace` rather than touch
// the real encryption + DB round-trip; the workspace-repository
// tests already cover that path. Here we focus on the handler's
// branching against various event shapes + resolver outcomes.
function fakeWorkspace(
  overrides: Partial<ResolvedLinearWorkspace> = {},
): ResolvedLinearWorkspace {
  return {
    id: "ws-row-id",
    workspaceId: "ws-prod",
    botUserId: BOT_LINEAR_ID,
    teamRepoMap: { "team-platform": "to11ai/nigel" },
    secrets: {
      webhookSecret: SECRET,
      accessToken: "lin_oauth_test",
    },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function sign(body: string, secret: string = SECRET): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

function assignmentBody(
  overrides: {
    newAssigneeId?: string | null;
    actorId?: string;
    attachmentUrl?: string;
    teamId?: string;
    externalId?: string;
  } = {},
): string {
  return JSON.stringify({
    id: overrides.externalId ?? "evt_1",
    type: "Issue",
    action: "assignee_changed",
    actor: { id: overrides.actorId ?? TEST_LINEAR_ID },
    data: {
      id: "iss_abc",
      identifier: "PLAT-1",
      title: "Fix it",
      teamId: overrides.teamId ?? "team-platform",
      assigneeId: overrides.newAssigneeId ?? BOT_LINEAR_ID,
      creator: { id: TEST_LINEAR_ID },
      ...(overrides.attachmentUrl
        ? {
            attachments: [{ url: overrides.attachmentUrl }],
          }
        : {}),
    },
  });
}

async function call(
  body: string,
  signature: string | null,
  workspace: ResolvedLinearWorkspace | null = fakeWorkspace(),
  deliveryHeader:
    | string
    | null = `delivery-${Math.random().toString(36).slice(2)}`,
): Promise<WebhookHandlerOutcome> {
  return handleLinearWebhook({
    rawBody: body,
    signatureHeader: signature,
    deliveryHeader,
    defaultBudgetUsdMicros: 5_000_000,
    deps: { resolveWorkspace: async () => workspace },
  });
}

describe("handleLinearWebhook — happy path", () => {
  test("creates a Run when assignment-to-bot resolves repo + owner", async () => {
    const body = assignmentBody();
    const outcome = await call(body, sign(body));
    expect(outcome.kind).toBe("run_created");
    if (outcome.kind !== "run_created") return;
    expect(outcome.repoRef).toBe("to11ai/nigel");
    expect(outcome.humanOwnerId).toBe(TEST_USER_ID);

    const rows = await db.select().from(agentRuns);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.triggerSource).toBe("linear");
    expect(rows[0]?.triggerRef).toBe("iss_abc");
    expect(rows[0]?.specialistId).toBe("planner");
  });
});

describe("handleLinearWebhook — failure paths", () => {
  test("signature_mismatch on a bad signature", async () => {
    const body = assignmentBody();
    const outcome = await call(body, "bogus-signature");
    expect(outcome.kind).toBe("signature_mismatch");
  });

  test("no_workspace_configured when no workspace row exists", async () => {
    const body = assignmentBody();
    const outcome = await call(body, sign(body), null);
    expect(outcome.kind).toBe("no_workspace_configured");
  });

  test("invalid_payload on non-JSON body", async () => {
    const body = "not json";
    const outcome = await call(body, sign(body));
    expect(outcome.kind).toBe("invalid_payload");
  });

  test("ignored when event is not an assignment to the bot", async () => {
    const body = assignmentBody({ newAssigneeId: "user-other" });
    const outcome = await call(body, sign(body));
    expect(outcome.kind).toBe("ignored");
  });

  test("unresolved_repo when neither attachment, team map, nor label resolve", async () => {
    const body = assignmentBody({ teamId: "team-unmapped" });
    const outcome = await call(body, sign(body));
    expect(outcome.kind).toBe("unresolved_repo");
  });

  test("unresolved_owner when neither actor nor creator maps to a Nigel user", async () => {
    // Build a payload where both actor and creator are Linear IDs
    // we never inserted into the users table.
    const body = JSON.stringify({
      id: "evt_unmapped",
      type: "Issue",
      action: "assignee_changed",
      actor: { id: "linear-unmapped-actor" },
      data: {
        id: "iss_abc",
        identifier: "PLAT-1",
        title: "Fix it",
        teamId: "team-platform",
        assigneeId: BOT_LINEAR_ID,
        creator: { id: "linear-unmapped-creator" },
      },
    });
    const outcome = await call(body, sign(body));
    expect(outcome.kind).toBe("unresolved_owner");
  });

  test("falls back to creator when actor is the bot itself", async () => {
    // Bot-created-issue scenario: actor === bot, creator === human.
    // The handler should resolve owner from the creator.
    const body = JSON.stringify({
      id: "evt_bot_self",
      type: "Issue",
      action: "assignee_changed",
      actor: { id: BOT_LINEAR_ID },
      data: {
        id: "iss_xyz",
        identifier: "PLAT-2",
        title: "Bot-created",
        teamId: "team-platform",
        assigneeId: BOT_LINEAR_ID,
        creator: { id: TEST_LINEAR_ID },
      },
    });
    const outcome = await call(body, sign(body));
    expect(outcome.kind).toBe("run_created");
    if (outcome.kind === "run_created") {
      expect(outcome.humanOwnerId).toBe(TEST_USER_ID);
    }
  });
});

describe("handleLinearWebhook — idempotency", () => {
  test("duplicate delivery of the same event (same Linear-Delivery header) creates only one Run", async () => {
    const body = assignmentBody();
    const sig = sign(body);
    const first = await call(body, sig, fakeWorkspace(), "delivery-uuid-1");
    expect(first.kind).toBe("run_created");

    const second = await call(body, sig, fakeWorkspace(), "delivery-uuid-1");
    expect(second.kind).toBe("duplicate");

    const rows = await db.select().from(agentRuns);
    expect(rows).toHaveLength(1);
  });

  test("two separate events from the same webhook (distinct Linear-Delivery headers) both create Runs", async () => {
    // Anti-regression for the `webhookId`-as-dedup bug: the body
    // field `webhookId` is the same across all deliveries from a
    // given webhook subscription. Using IT as the dedup key would
    // make this test fail with "only 1 Run".
    const body = assignmentBody({ externalId: "shared-webhookId" });
    const sig = sign(body);
    const a = await call(body, sig, fakeWorkspace(), "delivery-A");
    const b = await call(body, sig, fakeWorkspace(), "delivery-B");
    expect(a.kind).toBe("run_created");
    expect(b.kind).toBe("run_created");
    const rows = await db.select().from(agentRuns);
    expect(rows).toHaveLength(2);
  });
});

describe("handleLinearWebhook — AgentSessionEvent", () => {
  function sessionBody(overrides: {
    sessionId?: string;
    issueId?: string;
    creatorId?: string;
    externalId?: string;
    action?: string;
  }): string {
    return JSON.stringify({
      id: overrides.externalId ?? "evt_session_1",
      type: "AgentSessionEvent",
      action: overrides.action ?? "created",
      agentSession: {
        id: overrides.sessionId ?? "agent-session-xyz",
        issue: {
          id: overrides.issueId ?? "iss_abc",
          title: "Fix it",
          description: null,
        },
        creator: { id: overrides.creatorId ?? TEST_LINEAR_ID },
      },
    });
  }

  test("creates a Run with linear_agent_session_id stamped on first AgentSessionEvent for an issue", async () => {
    const fetchSpy = async () => ({
      id: "iss_abc",
      identifier: "PLAT-1",
      title: "Fix it",
      description: null,
      teamId: "team-platform",
      url: undefined,
      creator: { id: TEST_LINEAR_ID },
      labels: [],
      attachments: [],
    });
    const body = sessionBody({});
    const outcome = await handleLinearWebhook({
      rawBody: body,
      signatureHeader: sign(body),
      deliveryHeader: "delivery-session-1",
      defaultBudgetUsdMicros: 5_000_000,
      deps: {
        resolveWorkspace: async () => fakeWorkspace(),
        fetchIssue: fetchSpy,
      },
    });
    expect(outcome.kind).toBe("run_created");
    const rows = await db.select().from(agentRuns);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.linearAgentSessionId).toBe("agent-session-xyz");
    expect(rows[0]?.triggerRef).toBe("iss_abc");
  });

  test("attaches session id to existing run when AppUserNotification arrived first", async () => {
    // Simulate the prior intake: hand-insert an active Linear run
    // for the same issue with NO session id yet.
    await db.insert(agentRuns).values({
      id: "run_preexisting",
      rootRunId: "run_preexisting",
      parentRunId: null,
      depth: 0,
      triggerSource: "linear",
      triggerRef: "iss_abc",
      specialistId: "planner",
      sandboxPolicy: "fresh",
      humanOwnerId: TEST_USER_ID,
      repoRef: "to11ai/nigel",
      budgetUsdCapMicros: 5_000_000,
      costUsdActualMicros: 0,
      status: "running",
    });

    const body = sessionBody({});
    const outcome = await handleLinearWebhook({
      rawBody: body,
      signatureHeader: sign(body),
      deliveryHeader: "delivery-session-attach",
      defaultBudgetUsdMicros: 5_000_000,
      deps: { resolveWorkspace: async () => fakeWorkspace() },
    });
    expect(outcome.kind).toBe("agent_session_attached");
    if (outcome.kind === "agent_session_attached") {
      expect(outcome.runId).toBe("run_preexisting");
      expect(outcome.agentSessionId).toBe("agent-session-xyz");
    }
    const rows = await db.select().from(agentRuns);
    // No new run created — just stamped.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.linearAgentSessionId).toBe("agent-session-xyz");
  });

  test("AppUserNotification arriving AFTER session-created run is dropped (no second run)", async () => {
    // Step 1: session creates the run.
    const fetchSpy = async () => ({
      id: "iss_abc",
      identifier: "PLAT-1",
      title: "Fix it",
      description: null,
      teamId: "team-platform",
      url: undefined,
      creator: { id: TEST_LINEAR_ID },
      labels: [],
      attachments: [],
    });
    const bodySession = sessionBody({});
    const sessionOutcome = await handleLinearWebhook({
      rawBody: bodySession,
      signatureHeader: sign(bodySession),
      deliveryHeader: "delivery-session-first",
      defaultBudgetUsdMicros: 5_000_000,
      deps: {
        resolveWorkspace: async () => fakeWorkspace(),
        fetchIssue: fetchSpy,
      },
    });
    expect(sessionOutcome.kind).toBe("run_created");

    // Step 2: AppUserNotification for the same issue arrives second.
    const bodyDelegation = JSON.stringify({
      id: "evt_delegate_after",
      type: "AppUserNotification",
      appUserId: BOT_LINEAR_ID,
      notification: {
        type: "issueAssignedToYou",
        issueId: "iss_abc",
      },
      actor: { id: TEST_LINEAR_ID },
    });
    const delegationOutcome = await handleLinearWebhook({
      rawBody: bodyDelegation,
      signatureHeader: sign(bodyDelegation),
      deliveryHeader: "delivery-delegation-after",
      defaultBudgetUsdMicros: 5_000_000,
      deps: { resolveWorkspace: async () => fakeWorkspace() },
    });
    expect(delegationOutcome.kind).toBe("ignored");

    const rows = await db.select().from(agentRuns);
    expect(rows).toHaveLength(1);
  });
});
