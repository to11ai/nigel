import "server-only";

import { start } from "workflow/api";
import { provisionSandboxWorkflow } from "@/app/workflows/provision-sandbox";
import {
  setSessionSandboxProvisioningRunId,
  updateSession,
} from "@/lib/db/sessions";

export async function startSandboxProvisioningWorkflow(params: {
  userId: string;
  sessionId: string;
}): Promise<string | null> {
  try {
    const run = await start(provisionSandboxWorkflow, [params]);
    await setSessionSandboxProvisioningRunId(params.sessionId, run.runId);
    return run.runId;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `Failed to start sandbox provisioning workflow for session ${params.sessionId}:`,
      error,
    );
    await updateSession(params.sessionId, {
      sandboxProvisioningRunId: null,
      lifecycleError: message,
    }).catch((updateError) => {
      console.error(
        `Failed to persist sandbox provisioning start failure for session ${params.sessionId}:`,
        updateError,
      );
    });
    return null;
  }
}
