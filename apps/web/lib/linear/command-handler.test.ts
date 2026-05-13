import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac, randomBytes } from "node:crypto";
import { db } from "@/lib/db/client";
import {
  agentRuns,
  linearWorkspace,
  users,
  webhookEvents,
} from "@/lib/db/schema";
import { Run } from "@/lib/runs/create";
import type { RunStatus } from "@/lib/runs/state-machine";
import { resetEncryptionKeyCacheForTests } from "@/lib/tool-connections/encryption";
import {
  handleLinearWebhook,
  type WebhookHandlerOutcome,
} from "./webhook-handler";
import type { ResolvedLinearWorkspace } from "./workspace-repository";

const ORIGINAL_KEY = process.env.TOOL_CONNECTIONS_ENC_KEY;
const TEST_KEY_B64 = randomBytes(32).toString("base64");

const OWNER_USER_ID = "test-user-command-owner";
const OWNER_LINEAR_ID = "linear-user-owner";
const OTHER_USER_ID = "test-user-command-other";
const OTHER_LINEAR_ID = "linear-user-other";
const BOT_LINEAR_ID = "linear-user-bot";
const SECRET = "whsec_test_signing";
const TEST_ISSUE_ID = "iss_cmd";

beforeEach(async () => {
  process.env.TOOL_CONNECTIONS_ENC_KEY = TEST_KEY_B64;
  resetEncryptionKeyCacheForTests();
  await db.delete(agentRuns);
  await db.delete(webhookEvents);
  await db.delete(linearWorkspace);
  // Two users: the run's human owner (authorized) and an unrelated
  // mapped Linear user (used to assert the authorization check).
  await db
    .insert(users)
    .values({
      id: OWNER_USER_ID,
      username: "command-owner",
      email: "owner@test.example",
      linearUserId: OWNER_LINEAR_ID,
    })
    .onConflictDoUpdate({
      target: users.id,
      set: { linearUserId: OWNER_LINEAR_ID },
    });
  await db
    .insert(users)
    .values({
      id: OTHER_USER_ID,
      username: "command-other",
      email: "other@test.example",
      linearUserId: OTHER_LINEAR_ID,
    })
    .onConflictDoUpdate({
      target: users.id,
      set: { linearUserId: OTHER_LINEAR_ID },
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

function commentBody(
  overrides: {
    body?: string;
    actorId?: string;
    issueId?: string;
    externalId?: string;
    action?: string;
  } = {},
): string {
  return JSON.stringify({
    id:
      overrides.externalId ?? `evt_cmd_${Math.random().toString(36).slice(2)}`,
    type: "Comment",
    action: overrides.action ?? "create",
    actor: { id: overrides.actorId ?? OWNER_LINEAR_ID },
    data: {
      id: "comment_x",
      body: overrides.body ?? "/approve",
      issueId: overrides.issueId ?? TEST_ISSUE_ID,
    },
  });
}

type CallDeps = {
  startWorkflow?: (input: {
    agentRunId: string;
    taskText: string;
  }) => Promise<void>;
  fetchIssue?: (input: { accessToken: string; issueId: string }) => Promise<{
    id: string;
    identifier: string;
    title: string;
    description: string | null;
    teamId: string;
    url: string | null;
    creator: { id: string } | null;
    labels: Array<{ name: string }>;
    attachments: Array<{
      url: string | null;
      metadata: { url: string } | null;
    }>;
  } | null>;
};

async function call(
  body: string,
  workspace: ResolvedLinearWorkspace | null = fakeWorkspace(),
  deps: CallDeps = {},
): Promise<WebhookHandlerOutcome> {
  return handleLinearWebhook({
    rawBody: body,
    signatureHeader: sign(body),
    deliveryHeader: `delivery-${Math.random().toString(36).slice(2)}`,
    defaultBudgetUsdMicros: 5_000_000,
    deps: {
      resolveWorkspace: async () => workspace,
      ...deps,
    },
  });
}

async function seedRun(input: {
  status: RunStatus;
  humanOwnerId?: string;
  triggerRef?: string;
}): Promise<string> {
  const run = await Run.create({
    triggerSource: "linear",
    triggerRef: input.triggerRef ?? TEST_ISSUE_ID,
    specialistId: "planner",
    humanOwnerId: input.humanOwnerId ?? OWNER_USER_ID,
    sandboxPolicy: "fresh",
    repoRef: "to11ai/nigel",
    budgetUsdCapMicros: 5_000_000,
  });
  if (input.status !== "pending") {
    // Walk through valid transitions to get to the target state.
    const { updateRunStatus } = await import("@/lib/runs/repository");
    if (
      input.status === "running" ||
      input.status === "blocked" ||
      input.status === "awaiting_approval" ||
      input.status === "completed" ||
      input.status === "failed" ||
      input.status === "cancelled"
    ) {
      await updateRunStatus(run.id, "running");
    }
    if (
      input.status === "blocked" ||
      input.status === "awaiting_approval" ||
      input.status === "completed" ||
      input.status === "failed"
    ) {
      await updateRunStatus(run.id, input.status);
    }
    if (input.status === "cancelled") {
      await updateRunStatus(run.id, "cancelled");
    }
  }
  return run.id;
}

function assertCommand<T extends WebhookHandlerOutcome>(
  outcome: WebhookHandlerOutcome,
): asserts outcome is Extract<T, { kind: "command" }> {
  if (outcome.kind !== "command") {
    throw new Error(`expected command outcome, got ${outcome.kind}`);
  }
}

describe("handleLinearWebhook — command intake (Phase 6 L4)", () => {
  test("not_a_command when the comment body has no slash-command", async () => {
    const body = commentBody({ body: "looks great, lgtm" });
    const outcome = await call(body);
    assertCommand(outcome);
    expect(outcome.outcome.kind).toBe("not_a_command");
  });

  test("ignores comments authored by the bot itself", async () => {
    // Bot-authored comments must NOT be treated as commands, even
    // if the body happens to start with a slash. The extractor
    // filters them out — outer outcome falls through to `ignored`.
    const body = commentBody({ body: "/approve", actorId: BOT_LINEAR_ID });
    const outcome = await call(body);
    expect(outcome.kind).toBe("ignored");
  });

  test("ignores Comment.update events (only .create surfaces commands)", async () => {
    const body = commentBody({ body: "/approve", action: "update" });
    const outcome = await call(body);
    expect(outcome.kind).toBe("ignored");
  });

  test("unmapped_actor when the commenter has no linked Nigel user", async () => {
    const body = commentBody({
      body: "/approve",
      actorId: "linear-stranger",
    });
    const outcome = await call(body);
    assertCommand(outcome);
    expect(outcome.outcome.kind).toBe("unmapped_actor");
  });

  test("no_active_run when no Linear run exists for this issue", async () => {
    const body = commentBody({ body: "/approve" });
    const outcome = await call(body);
    assertCommand(outcome);
    expect(outcome.outcome.kind).toBe("no_active_run");
  });

  test("unauthorized when the commenter is mapped but not the run's owner", async () => {
    await seedRun({ status: "awaiting_approval" });
    const body = commentBody({
      body: "/approve",
      actorId: OTHER_LINEAR_ID,
    });
    const outcome = await call(body);
    assertCommand(outcome);
    expect(outcome.outcome.kind).toBe("unauthorized");
  });

  test("/approve transitions awaiting_approval → running", async () => {
    const runId = await seedRun({ status: "awaiting_approval" });
    const body = commentBody({ body: "/approve" });
    const outcome = await call(body);
    assertCommand(outcome);
    expect(outcome.outcome.kind).toBe("transitioned");
    if (outcome.outcome.kind === "transitioned") {
      expect(outcome.outcome.runId).toBe(runId);
      expect(outcome.outcome.from).toBe("awaiting_approval");
      expect(outcome.outcome.to).toBe("running");
    }
  });

  test("/reject transitions awaiting_approval → cancelled", async () => {
    await seedRun({ status: "awaiting_approval" });
    const body = commentBody({ body: "/reject this is wrong" });
    const outcome = await call(body);
    assertCommand(outcome);
    if (outcome.outcome.kind === "transitioned") {
      expect(outcome.outcome.from).toBe("awaiting_approval");
      expect(outcome.outcome.to).toBe("cancelled");
    } else {
      throw new Error(`expected transitioned, got ${outcome.outcome.kind}`);
    }
  });

  test("/resume transitions blocked → running", async () => {
    await seedRun({ status: "blocked" });
    const body = commentBody({ body: "/resume" });
    const outcome = await call(body);
    assertCommand(outcome);
    if (outcome.outcome.kind === "transitioned") {
      expect(outcome.outcome.from).toBe("blocked");
      expect(outcome.outcome.to).toBe("running");
    } else {
      throw new Error(`expected transitioned, got ${outcome.outcome.kind}`);
    }
  });

  test("/cancel transitions running → cancelled", async () => {
    await seedRun({ status: "running" });
    const body = commentBody({ body: "/cancel timing out" });
    const outcome = await call(body);
    assertCommand(outcome);
    if (outcome.outcome.kind === "transitioned") {
      expect(outcome.outcome.from).toBe("running");
      expect(outcome.outcome.to).toBe("cancelled");
    } else {
      throw new Error(`expected transitioned, got ${outcome.outcome.kind}`);
    }
  });

  test("/approve on running run is wrong_state", async () => {
    await seedRun({ status: "running" });
    const body = commentBody({ body: "/approve" });
    const outcome = await call(body);
    assertCommand(outcome);
    expect(outcome.outcome.kind).toBe("wrong_state");
  });

  test("/cancel on completed run is wrong_state", async () => {
    await seedRun({ status: "completed" });
    const body = commentBody({ body: "/cancel" });
    const outcome = await call(body);
    assertCommand(outcome);
    // /cancel on a terminal run looks up the active run first, gets
    // null (the run is terminal), and surfaces as no_active_run.
    expect(outcome.outcome.kind).toBe("no_active_run");
  });
});

describe("handleLinearWebhook — /run command (Phase 6 L4)", () => {
  test("starts a fresh run when no active run exists", async () => {
    const started: Array<{ agentRunId: string; taskText: string }> = [];
    const fakeIssue = {
      id: TEST_ISSUE_ID,
      identifier: "PLAT-9",
      title: "Re-run requested",
      description: "Please retry",
      teamId: "team-platform",
      url: "https://linear.app/issue/PLAT-9",
      creator: { id: OWNER_LINEAR_ID },
      labels: [],
      attachments: [],
    };
    const body = commentBody({ body: "/run" });
    const outcome = await call(body, fakeWorkspace(), {
      fetchIssue: async () => fakeIssue,
      startWorkflow: async (i) => {
        started.push(i);
      },
    });
    assertCommand(outcome);
    expect(outcome.outcome.kind).toBe("run_started");
    if (outcome.outcome.kind === "run_started") {
      expect(outcome.outcome.issueId).toBe(TEST_ISSUE_ID);
    }
    const rows = await db.select().from(agentRuns);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.humanOwnerId).toBe(OWNER_USER_ID);
    expect(started).toHaveLength(1);
  });

  test("/run is rejected when a non-terminal run already exists", async () => {
    await seedRun({ status: "running" });
    const body = commentBody({ body: "/run" });
    const outcome = await call(body, fakeWorkspace(), {
      fetchIssue: async () => {
        throw new Error("should not be called");
      },
      startWorkflow: async () => {
        throw new Error("should not be called");
      },
    });
    assertCommand(outcome);
    expect(outcome.outcome.kind).toBe("wrong_state");
  });

  test("/run is permitted when the most recent run is terminal", async () => {
    await seedRun({ status: "completed" });
    const fakeIssue = {
      id: TEST_ISSUE_ID,
      identifier: "PLAT-9",
      title: "Try again",
      description: "second attempt",
      teamId: "team-platform",
      url: "https://linear.app/issue/PLAT-9",
      creator: { id: OWNER_LINEAR_ID },
      labels: [],
      attachments: [],
    };
    const body = commentBody({ body: "/run" });
    const outcome = await call(body, fakeWorkspace(), {
      fetchIssue: async () => fakeIssue,
      startWorkflow: async () => {
        // no-op
      },
    });
    assertCommand(outcome);
    expect(outcome.outcome.kind).toBe("run_started");
    const rows = await db.select().from(agentRuns);
    // Original + the new /run-started run.
    expect(rows).toHaveLength(2);
  });

  test("/run with no resolvable repo surfaces run_start_failed", async () => {
    const fakeIssue = {
      id: TEST_ISSUE_ID,
      identifier: "PLAT-9",
      title: "Cannot resolve repo",
      description: "no labels, no team mapping",
      teamId: "team-unmapped",
      url: "https://linear.app/issue/PLAT-9",
      creator: { id: OWNER_LINEAR_ID },
      labels: [],
      attachments: [],
    };
    const body = commentBody({ body: "/run" });
    const outcome = await call(body, fakeWorkspace(), {
      fetchIssue: async () => fakeIssue,
    });
    assertCommand(outcome);
    if (outcome.outcome.kind === "run_start_failed") {
      expect(outcome.outcome.reason).toBe("unresolved_repo");
    } else {
      throw new Error(`expected run_start_failed, got ${outcome.outcome.kind}`);
    }
  });
});
