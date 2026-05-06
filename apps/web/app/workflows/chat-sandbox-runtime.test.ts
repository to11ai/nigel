import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { UIMessageChunk } from "ai";

mock.module("server-only", () => ({}));

const writtenChunks: UIMessageChunk[] = [];
const updateCalls: Array<{
  sessionId: string;
  patch: Record<string, unknown>;
}> = [];
let returnValueAwaited = false;
let runExists = true;
let runReturnValueError: Error | null = null;

const sandbox = {
  workingDirectory: "/vercel/sandbox",
  currentBranch: "main",
  environmentDetails: "test sandbox",
};

let sessionRecord = {
  id: "session-1",
  userId: "user-1",
  title: "Test session",
  status: "running" as const,
  lifecycleState: "provisioning" as const,
  sandboxProvisioningRunId: "provision-run-1",
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

mock.module("workflow", () => ({
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
    returnValueAwaited = false;
    runExists = true;
    runReturnValueError = null;
    provisionSessionSandboxMock.mockClear();
    sessionRecord = {
      id: "session-1",
      userId: "user-1",
      title: "Test session",
      status: "running",
      lifecycleState: "provisioning",
      sandboxProvisioningRunId: "provision-run-1",
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
});
