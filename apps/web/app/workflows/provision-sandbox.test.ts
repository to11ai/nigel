import { beforeEach, describe, expect, mock, test } from "bun:test";

type TestLifecycleState = "provisioning" | "active" | "archived" | "failed";

type TestSessionRecord = {
  id: string;
  userId: string;
  status: "running" | "archived";
  lifecycleState: TestLifecycleState;
  sandboxProvisioningRunId: string | null;
};

let sessionRecord: TestSessionRecord | null;
const updateCalls: Array<{
  sessionId: string;
  patch: Record<string, unknown>;
}> = [];

const provisionSessionSandboxMock = mock(async () => ({
  sandboxState: {
    type: "vercel" as const,
    sandboxName: "session_session-1",
    expiresAt: Date.now() + 60_000,
  },
}));

mock.module("workflow", () => ({
  getWorkflowMetadata: () => ({ workflowRunId: "workflow-run-1" }),
  getWritable: () => {
    const writable = new WritableStream();
    return writable;
  },
}));

mock.module("@/lib/db/sessions", () => ({
  getSessionById: async () => sessionRecord,
  updateProvisioningSession: async (
    sessionId: string,
    patch: Record<string, unknown>,
  ) => {
    if (
      !sessionRecord ||
      sessionRecord.status === "archived" ||
      sessionRecord.lifecycleState !== "provisioning"
    ) {
      return undefined;
    }

    updateCalls.push({ sessionId, patch });
    sessionRecord = { ...sessionRecord, ...patch } as TestSessionRecord;
    return sessionRecord;
  },
  updateSession: async (sessionId: string, patch: Record<string, unknown>) => {
    updateCalls.push({ sessionId, patch });
    if (sessionRecord) {
      sessionRecord = { ...sessionRecord, ...patch } as TestSessionRecord;
    }
    return sessionRecord;
  },
}));

mock.module("@/lib/sandbox/provision-session-sandbox", () => ({
  provisionSessionSandbox: provisionSessionSandboxMock,
}));

const workflowModulePromise = import("./provision-sandbox");

describe("provisionSandboxWorkflow", () => {
  beforeEach(() => {
    updateCalls.length = 0;
    provisionSessionSandboxMock.mockClear();
    sessionRecord = {
      id: "session-1",
      userId: "user-1",
      status: "running",
      lifecycleState: "provisioning",
      sandboxProvisioningRunId: null,
    };
  });

  test("claims provisioning sessions before provisioning", async () => {
    const { provisionSandboxWorkflow } = await workflowModulePromise;

    const result = await provisionSandboxWorkflow({
      userId: "user-1",
      sessionId: "session-1",
    });

    expect(updateCalls[0]).toEqual({
      sessionId: "session-1",
      patch: {
        sandboxProvisioningRunId: "workflow-run-1",
        lifecycleError: null,
      },
    });
    expect(provisionSessionSandboxMock).toHaveBeenCalledWith({
      userId: "user-1",
      sessionId: "session-1",
    });
    expect(result.sandboxState.type).toBe("vercel");
  });

  test("does not rewrite archived sessions back to provisioning", async () => {
    sessionRecord = {
      id: "session-1",
      userId: "user-1",
      status: "archived",
      lifecycleState: "archived",
      sandboxProvisioningRunId: "workflow-run-1",
    };
    const { provisionSandboxWorkflow } = await workflowModulePromise;

    await expect(
      provisionSandboxWorkflow({
        userId: "user-1",
        sessionId: "session-1",
      }),
    ).rejects.toThrow("Session is archived");

    expect(updateCalls).toEqual([
      {
        sessionId: "session-1",
        patch: { sandboxProvisioningRunId: null },
      },
    ]);
    expect(sessionRecord?.lifecycleState).toBe("archived");
    expect(provisionSessionSandboxMock).not.toHaveBeenCalled();
  });
});
