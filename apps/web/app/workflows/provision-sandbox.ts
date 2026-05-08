import { getWorkflowMetadata } from "workflow";
import { getSessionById, updateSession } from "@/lib/db/sessions";
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
    await updateSession(params.sessionId, {
      sandboxProvisioningRunId: params.runId,
      lifecycleState: "provisioning",
      lifecycleError: null,
    });
    const result = await provisionSessionSandbox(params);
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
