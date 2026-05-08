import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

type TestSessionRecord = {
  id: string;
  userId: string;
  status: "running" | "archived";
  title: string;
  repoOwner: string | null;
  repoName: string | null;
  branch: string | null;
  cloneUrl: string | null;
  prNumber: number | null;
  isNewBranch: boolean;
  sandboxState: { type: "vercel"; sandboxName?: string; expiresAt?: number };
  globalSkillRefs: [];
  lifecycleVersion: number;
};

let sessionReads: TestSessionRecord[] = [];
const updateCalls: Array<{
  sessionId: string;
  patch: Record<string, unknown>;
}> = [];
const stopSandbox = mock(async () => {});

function makeSessionRecord(
  overrides: Partial<TestSessionRecord> = {},
): TestSessionRecord {
  return {
    id: "session-1",
    userId: "user-1",
    status: "running",
    title: "Oslo",
    repoOwner: null,
    repoName: null,
    branch: null,
    cloneUrl: null,
    prNumber: null,
    isNewBranch: false,
    sandboxState: { type: "vercel" },
    globalSkillRefs: [],
    lifecycleVersion: 0,
    ...overrides,
  };
}

mock.module("@/lib/db/sessions", () => ({
  countSessionsByUserId: async () => 0,
  createSessionWithInitialChat: async () => undefined,
  getArchivedSessionCountByUserId: async () => 0,
  getChatsBySessionId: async () => [],
  getSessionById: async () => {
    const session = sessionReads.shift() ?? sessionReads.at(-1) ?? null;
    return session
      ? { ...session, sandboxState: { ...session.sandboxState } }
      : null;
  },
  getSessionsWithUnreadByUserId: async () => [],
  getUsedSessionTitles: async () => new Set<string>(),
  setSessionSandboxProvisioningRunId: async () => true,
  updateSession: async (sessionId: string, patch: Record<string, unknown>) => {
    updateCalls.push({ sessionId, patch });
    return {
      ...makeSessionRecord(),
      ...patch,
    };
  },
  updateProvisioningSession: async (
    sessionId: string,
    patch: Record<string, unknown>,
  ) => {
    updateCalls.push({ sessionId, patch });
    return {
      ...makeSessionRecord(),
      ...patch,
    };
  },
}));

mock.module("@open-agents/sandbox", () => ({
  connectSandbox: async () => ({
    workingDirectory: "/workspace",
    stop: stopSandbox,
    getState: () => ({
      type: "vercel",
      sandboxName: "session_session-1",
      expiresAt: Date.now() + 60_000,
    }),
  }),
}));

mock.module("@/lib/github/users", () => ({
  getGitHubUserProfile: async () => null,
}));

mock.module("@/lib/github/access", () => ({
  getRepoAccessErrorMessage: () => "repo access failed",
  verifyRepoAccess: async () => ({ ok: true }),
}));

mock.module("@/lib/github/app", () => ({
  mintInstallationToken: async () => undefined,
  revokeInstallationToken: async () => undefined,
}));

mock.module("@/lib/sandbox/lifecycle-kick", () => ({
  kickSandboxLifecycleWorkflow: () => {},
}));

mock.module("@/lib/skills/global-skill-installer", () => ({
  installGlobalSkills: async () => {},
}));

const modulePromise = import("./provision-session-sandbox");

describe("provisionSessionSandbox", () => {
  beforeEach(() => {
    sessionReads = [];
    updateCalls.length = 0;
    stopSandbox.mockClear();
  });

  test("stops the sandbox and avoids active state writes if the session is archived while provisioning", async () => {
    const { provisionSessionSandbox } = await modulePromise;
    sessionReads = [
      makeSessionRecord(),
      makeSessionRecord({ status: "archived" }),
    ];

    await expect(
      provisionSessionSandbox({ userId: "user-1", sessionId: "session-1" }),
    ).rejects.toThrow("Session is archived");

    expect(stopSandbox).toHaveBeenCalledTimes(1);
    expect(updateCalls).toHaveLength(0);
  });
});
