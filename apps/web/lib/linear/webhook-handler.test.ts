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
): Promise<WebhookHandlerOutcome> {
  return handleLinearWebhook({
    rawBody: body,
    signatureHeader: signature,
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
  test("duplicate delivery of the same event creates only one Run", async () => {
    const body = assignmentBody({ externalId: "dup-evt-1" });
    const sig = sign(body);
    const first = await call(body, sig);
    expect(first.kind).toBe("run_created");

    const second = await call(body, sig);
    expect(second.kind).toBe("duplicate");

    const rows = await db.select().from(agentRuns);
    expect(rows).toHaveLength(1);
  });
});
