import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { UIMessageChunk } from "ai";

mock.module("server-only", () => ({}));

const writtenChunks: UIMessageChunk[] = [];
const updateCalls: Array<{
  sessionId: string;
  patch: Record<string, unknown>;
}> = [];
const lifecycleKickCalls: Array<{ sessionId: string; reason: string }> = [];
let returnValueAwaited = false;
let runExists = true;
let runReturnValueError: Error | null = null;

type TestLifecycleState = "provisioning" | "active" | "hibernated" | "archived";
type TestSessionRecord = {
  id: string;
  userId: string;
  title: string;
  status: "running" | "archived";
  lifecycleState: TestLifecycleState;
  sandboxProvisioningRunId: string | null;
  lifecycleVersion: number;
  sandboxState: {
    type: "vercel";
    sandboxName: string;
    expiresAt?: number;
  };
  repoOwner: string | null;
  repoName: string | null;
};

const sandbox = {
  workingDirectory: "/vercel/sandbox",
  currentBranch: "main",
  environmentDetails: "test sandbox",
};

let sessionRecord: TestSessionRecord = {
  id: "session-1",
  userId: "user-1",
  title: "Test session",
  status: "running" as const,
  lifecycleState: "provisioning" as TestLifecycleState,
  sandboxProvisioningRunId: "provision-run-1",
  lifecycleVersion: 0,
  sandboxState: { type: "vercel" as const, sandboxName: "session_session-1" },
  repoOwner: null as string | null,
  repoName: null as string | null,
};

const provisionSessionSandboxMock = mock(async () => ({
  session: sessionRecord,
  sandbox,
  sandboxState: {
    type: "vercel" as const,
    sandboxName: "session_session-1",
    expiresAt: Date.now() + 60_000,
  },
  didSetupWorkspace: true,
}));

const connectSandboxMock = mock(async () => ({
  ...sandbox,
  getState: () => sessionRecord.sandboxState,
}));

mock.module("workflow", () => ({
  getWorkflowMetadata: () => ({ workflowRunId: "workflow-run-1" }),
  getWritable: () => {
    const writable = new WritableStream<UIMessageChunk>({
      write(chunk) {
        writtenChunks.push(chunk);
      },
    });
    return writable;
  },
}));

mock.module("workflow/api", () => ({
  getRun: (runId: string) => ({
    runId,
    get exists() {
      return Promise.resolve(runExists);
    },
    get returnValue() {
      returnValueAwaited = true;
      return (async () => {
        if (runReturnValueError) {
          throw runReturnValueError;
        }
        return { sandboxState: { type: "vercel" } };
      })();
    },
  }),
}));

mock.module("@/lib/db/sessions", () => ({
  getSessionById: async () => sessionRecord,
  updateSession: async (sessionId: string, patch: Record<string, unknown>) => {
    updateCalls.push({ sessionId, patch });
    sessionRecord = { ...sessionRecord, ...patch } as typeof sessionRecord;
    return sessionRecord;
  },
}));

mock.module("@/lib/sandbox/provision-session-sandbox", () => ({
  provisionSessionSandbox: provisionSessionSandboxMock,
}));

mock.module("@/lib/sandbox/lifecycle", () => ({
  buildActiveLifecycleUpdate: () => ({
    lifecycleState: "active",
    lifecycleError: null,
    lastActivityAt: new Date("2025-01-01T00:00:00.000Z"),
    hibernateAfter: new Date("2025-01-01T00:30:00.000Z"),
    sandboxExpiresAt: new Date("2025-01-01T01:00:00.000Z"),
  }),
  getNextLifecycleVersion: (currentVersion: number | null | undefined) =>
    (currentVersion ?? 0) + 1,
}));

mock.module("@/lib/sandbox/lifecycle-kick", () => ({
  kickSandboxLifecycleWorkflow: (input: {
    sessionId: string;
    reason: string;
  }) => {
    lifecycleKickCalls.push(input);
  },
}));

mock.module("@open-agents/sandbox", () => ({
  connectSandbox: connectSandboxMock,
}));

mock.module("@/lib/skills/directories", () => ({
  getSandboxSkillDirectories: async () => [],
}));

mock.module("@/lib/skills-cache", () => ({
  getCachedSkills: async () => [],
  setCachedSkills: async () => {},
}));

mock.module("@open-agents/agent", () => ({
  discoverSkills: async () => [],
}));

const runtimeModulePromise = import("./chat-sandbox-runtime");

describe("resolveChatSandboxRuntime provisioning coordination", () => {
  beforeEach(() => {
    writtenChunks.length = 0;
    updateCalls.length = 0;
    lifecycleKickCalls.length = 0;
    returnValueAwaited = false;
    runExists = true;
    runReturnValueError = null;
    connectSandboxMock.mockClear();
    provisionSessionSandboxMock.mockClear();
    sessionRecord = {
      id: "session-1",
      userId: "user-1",
      title: "Test session",
      status: "running",
      lifecycleState: "provisioning",
      sandboxProvisioningRunId: "provision-run-1",
      lifecycleVersion: 0,
      sandboxState: { type: "vercel", sandboxName: "session_session-1" },
      repoOwner: null,
      repoName: null,
    };
  });

  test("awaits an in-flight provisioning run before resolving the sandbox", async () => {
    const { resolveChatSandboxRuntime } = await runtimeModulePromise;

    const result = await resolveChatSandboxRuntime({
      userId: "user-1",
      sessionId: "session-1",
      assistantId: "assistant-1",
    });

    expect(returnValueAwaited).toBe(true);
    expect(provisionSessionSandboxMock).toHaveBeenCalledWith({
      userId: "user-1",
      sessionId: "session-1",
    });
    expect(result.workingDirectory).toBe("/vercel/sandbox");
    expect(writtenChunks[0]).toEqual({
      type: "start",
      messageId: "assistant-1",
    });
  });

  test("clears a missing provisioning run and falls back to provisioning", async () => {
    runExists = false;
    const { resolveChatSandboxRuntime } = await runtimeModulePromise;

    await resolveChatSandboxRuntime({
      userId: "user-1",
      sessionId: "session-1",
      assistantId: "assistant-1",
    });

    expect(returnValueAwaited).toBe(false);
    expect(updateCalls[0]).toEqual({
      sessionId: "session-1",
      patch: {
        sandboxProvisioningRunId: null,
        lifecycleError: "Sandbox provisioning workflow was not found",
      },
    });
    expect(provisionSessionSandboxMock).toHaveBeenCalledTimes(1);
  });

  test("connects to active sessions without reprovisioning", async () => {
    sessionRecord = {
      ...sessionRecord,
      lifecycleState: "active",
      sandboxProvisioningRunId: null,
      sandboxState: {
        type: "vercel",
        sandboxName: "session_session-1",
        expiresAt: Date.now() + 60_000,
      },
    };
    const { resolveChatSandboxRuntime } = await runtimeModulePromise;

    const result = await resolveChatSandboxRuntime({
      userId: "user-1",
      sessionId: "session-1",
      assistantId: "assistant-1",
    });

    expect(returnValueAwaited).toBe(false);
    expect(provisionSessionSandboxMock).not.toHaveBeenCalled();
    expect(connectSandboxMock).toHaveBeenCalledWith(
      sessionRecord.sandboxState,
      {
        ports: [3000, 5173, 4321, 8000],
      },
    );
    expect(result.workingDirectory).toBe("/vercel/sandbox");
    expect(result.didSetupWorkspace).toBe(false);
  });

  test("resumes hibernated sessions without using provisioning-only update path", async () => {
    sessionRecord = {
      ...sessionRecord,
      lifecycleState: "hibernated",
      sandboxProvisioningRunId: null,
      lifecycleVersion: 7,
      sandboxState: {
        type: "vercel",
        sandboxName: "session_session-1",
      },
    };
    const resumedState = {
      ...sessionRecord.sandboxState,
      expiresAt: Date.now() + 60_000,
    };
    connectSandboxMock.mockImplementationOnce(async () => ({
      ...sandbox,
      getState: () => resumedState,
      stop: mock(async () => {}),
    }));
    const { resolveChatSandboxRuntime } = await runtimeModulePromise;

    const result = await resolveChatSandboxRuntime({
      userId: "user-1",
      sessionId: "session-1",
      assistantId: "assistant-1",
    });

    expect(provisionSessionSandboxMock).not.toHaveBeenCalled();
    expect(connectSandboxMock).toHaveBeenCalledWith(
      { type: "vercel", sandboxName: "session_session-1" },
      {
        ports: [3000, 5173, 4321, 8000],
        resume: true,
      },
    );
    expect(updateCalls[0]).toMatchObject({
      sessionId: "session-1",
      patch: {
        sandboxState: resumedState,
        snapshotUrl: null,
        snapshotCreatedAt: null,
        lifecycleVersion: 8,
        lifecycleState: "active",
        lifecycleError: null,
      },
    });
    expect(lifecycleKickCalls).toEqual([
      { sessionId: "session-1", reason: "snapshot-restored" },
    ]);
    expect(result.sandboxState).toBe(resumedState);
    expect(result.didSetupWorkspace).toBe(true);
  });
});
