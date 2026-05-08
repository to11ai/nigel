import { getWorkflowMetadata } from "workflow";
import {
  getSessionById,
  updateProvisioningSession,
  updateSession,
} from "@/lib/db/sessions";
import { provisionSessionSandbox } from "@/lib/sandbox/provision-session-sandbox";

export type ProvisionSandboxWorkflowResult = {
  sandboxState: Awaited<
    ReturnType<typeof provisionSessionSandbox>
  >["sandboxState"];
};

async function provisionSandboxStep(params: {
  userId: string;
  sessionId: string;
  runId: string;
}): Promise<ProvisionSandboxWorkflowResult> {
  "use step";

  try {
    const claimedSession = await updateProvisioningSession(params.sessionId, {
      sandboxProvisioningRunId: params.runId,
      lifecycleError: null,
    });
    if (!claimedSession) {
      const session = await getSessionById(params.sessionId);
      if (!session) {
        throw new Error("Session not found");
      }
      if (
        session.status === "archived" ||
        session.lifecycleState === "archived"
      ) {
        throw new Error("Session is archived");
      }
      throw new Error("Session is no longer provisioning");
    }

    const result = await provisionSessionSandbox({
      userId: params.userId,
      sessionId: params.sessionId,
    });
    return { sandboxState: result.sandboxState };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const session = await getSessionById(params.sessionId);
    if (session?.status === "archived") {
      await updateSession(params.sessionId, {
        sandboxProvisioningRunId: null,
      });
      throw error;
    }

    await updateSession(params.sessionId, {
      sandboxProvisioningRunId: null,
      lifecycleState: "failed",
      lifecycleError: message,
    });
    throw error;
  }
}

export async function provisionSandboxWorkflow(params: {
  userId: string;
  sessionId: string;
}): Promise<ProvisionSandboxWorkflowResult> {
  "use workflow";

  const { workflowRunId } = getWorkflowMetadata();
  return provisionSandboxStep({ ...params, runId: workflowRunId });
}
