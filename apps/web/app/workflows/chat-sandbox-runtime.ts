import { discoverSkills } from "@open-agents/agent";
import {
  connectSandbox,
  type Sandbox,
  type SandboxState,
} from "@open-agents/sandbox";
import type { UIMessageChunk } from "ai";
import { getWritable } from "workflow";
import { getRun } from "workflow/api";
import type { WebAgentWorkspaceStatusData } from "@/app/types";
import { getSessionById, updateSession } from "@/lib/db/sessions";
import { DEFAULT_SANDBOX_PORTS } from "@/lib/sandbox/config";
import {
  buildActiveLifecycleUpdate,
  getNextLifecycleVersion,
} from "@/lib/sandbox/lifecycle";
import { kickSandboxLifecycleWorkflow } from "@/lib/sandbox/lifecycle-kick";
import { provisionSessionSandbox } from "@/lib/sandbox/provision-session-sandbox";
import { hasPausedSandboxState, isSandboxActive } from "@/lib/sandbox/utils";
import { getSandboxSkillDirectories } from "@/lib/skills/directories";
import { getCachedSkills, setCachedSkills } from "@/lib/skills-cache";

type SessionRecord = NonNullable<Awaited<ReturnType<typeof getSessionById>>>;
type DiscoveredSkills = Awaited<ReturnType<typeof discoverSkills>>;

export type ResolvedChatSandboxRuntime = {
  sandboxState: SandboxState;
  workingDirectory: string;
  currentBranch?: string;
  environmentDetails?: string;
  skills: DiscoveredSkills;
  didSetupWorkspace: boolean;
  sessionTitle: string;
  repoOwner?: string;
  repoName?: string;
};

async function loadSessionSkills(params: {
  sessionId: string;
  sandboxState: SandboxState;
  sandbox: Sandbox;
}): Promise<DiscoveredSkills> {
  const cachedSkills = await getCachedSkills(
    params.sessionId,
    params.sandboxState,
  );
  if (cachedSkills !== null) {
    return cachedSkills;
  }

  const skillDirs = await getSandboxSkillDirectories(params.sandbox);
  const discoveredSkills = await discoverSkills(params.sandbox, skillDirs);
  await setCachedSkills(
    params.sessionId,
    params.sandboxState,
    discoveredSkills,
  );
  return discoveredSkills;
}

async function sendWorkspaceStatus(data: WebAgentWorkspaceStatusData) {
  const writer = getWritable<UIMessageChunk>().getWriter();
  try {
    await writer.write({
      type: "data-workspace-status",
      id: "workspace-status",
      data,
      transient: true,
    });
  } finally {
    writer.releaseLock();
  }
}

async function sendStart(messageId: string) {
  const writer = getWritable<UIMessageChunk>().getWriter();
  try {
    await writer.write({ type: "start", messageId });
  } finally {
    writer.releaseLock();
  }
}

async function awaitProvisioningRunIfNeeded(
  session: SessionRecord,
): Promise<void> {
  if (
    session.lifecycleState !== "provisioning" ||
    !session.sandboxProvisioningRunId ||
    isSandboxActive(session.sandboxState)
  ) {
    return;
  }

  const run = getRun(session.sandboxProvisioningRunId);
  if (!(await run.exists)) {
    await updateSession(session.id, {
      sandboxProvisioningRunId: null,
      lifecycleError: "Sandbox provisioning workflow was not found",
    });
    return;
  }

  try {
    await run.returnValue;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateSession(session.id, {
      sandboxProvisioningRunId: null,
      lifecycleError: message,
    });
  }
}

async function getRunnableSession(sessionId: string, userId: string) {
  const session = await getSessionById(sessionId);
  if (!session) {
    throw new Error("Session not found");
  }
  if (session.userId !== userId) {
    throw new Error("Unauthorized");
  }
  if (session.status === "archived" || session.lifecycleState === "archived") {
    throw new Error("Session is archived");
  }

  return session;
}

async function resolveActiveSessionSandbox(session: SessionRecord) {
  if (!isSandboxActive(session.sandboxState)) {
    return null;
  }

  const sandbox = await connectSandbox(session.sandboxState, {
    ports: DEFAULT_SANDBOX_PORTS,
  });
  const rawSandboxState = sandbox.getState?.() as SandboxState | undefined;
  const sandboxState = isSandboxActive(rawSandboxState)
    ? rawSandboxState
    : session.sandboxState;

  return { sandbox, sandboxState };
}

async function resumePausedSessionSandbox(session: SessionRecord) {
  if (
    session.lifecycleState === "provisioning" ||
    !hasPausedSandboxState(session.sandboxState)
  ) {
    return null;
  }

  const sandbox = await connectSandbox(session.sandboxState, {
    ports: DEFAULT_SANDBOX_PORTS,
    resume: true,
  });
  const rawSandboxState = sandbox.getState?.() as SandboxState | undefined;
  const sandboxState = rawSandboxState ?? session.sandboxState;

  const updatedSession = await updateSession(session.id, {
    sandboxState,
    snapshotUrl: null,
    snapshotCreatedAt: null,
    lifecycleVersion: getNextLifecycleVersion(session.lifecycleVersion),
    ...buildActiveLifecycleUpdate(sandboxState),
  });

  if (!updatedSession) {
    await sandbox.stop();
    throw new Error("Session not found");
  }

  kickSandboxLifecycleWorkflow({
    sessionId: session.id,
    reason: "snapshot-restored",
  });

  return { sandbox, sandboxState, session: updatedSession };
}

export async function resolveChatSandboxRuntime(params: {
  userId: string;
  sessionId: string;
  assistantId: string;
}): Promise<ResolvedChatSandboxRuntime> {
  "use step";

  await sendStart(params.assistantId);

  const session = await getRunnableSession(params.sessionId, params.userId);

  const didSetupWorkspace = !isSandboxActive(session.sandboxState);
  if (didSetupWorkspace) {
    await sendWorkspaceStatus({
      status: "setting-up",
      message: "Setting up the workspace...",
    });
  }

  await awaitProvisioningRunIfNeeded(session);

  const runnableSession = await getRunnableSession(
    params.sessionId,
    params.userId,
  );

  const activeSandbox = await resolveActiveSessionSandbox(runnableSession);
  if (activeSandbox) {
    const skills = await loadSessionSkills({
      sessionId: params.sessionId,
      sandboxState: activeSandbox.sandboxState,
      sandbox: activeSandbox.sandbox,
    });

    return {
      sandboxState: activeSandbox.sandboxState,
      workingDirectory: activeSandbox.sandbox.workingDirectory,
      currentBranch: activeSandbox.sandbox.currentBranch,
      environmentDetails: activeSandbox.sandbox.environmentDetails,
      skills,
      didSetupWorkspace,
      sessionTitle: runnableSession.title,
      repoOwner: runnableSession.repoOwner ?? undefined,
      repoName: runnableSession.repoName ?? undefined,
    };
  }

  const resumedSandbox = await resumePausedSessionSandbox(runnableSession);
  if (resumedSandbox) {
    const skills = await loadSessionSkills({
      sessionId: params.sessionId,
      sandboxState: resumedSandbox.sandboxState,
      sandbox: resumedSandbox.sandbox,
    });

    return {
      sandboxState: resumedSandbox.sandboxState,
      workingDirectory: resumedSandbox.sandbox.workingDirectory,
      currentBranch: resumedSandbox.sandbox.currentBranch,
      environmentDetails: resumedSandbox.sandbox.environmentDetails,
      skills,
      didSetupWorkspace,
      sessionTitle: resumedSandbox.session.title,
      repoOwner: resumedSandbox.session.repoOwner ?? undefined,
      repoName: resumedSandbox.session.repoName ?? undefined,
    };
  }

  const provisioned = await provisionSessionSandbox({
    userId: params.userId,
    sessionId: params.sessionId,
  });
  const { sandbox, sandboxState } = provisioned;

  const skills = await loadSessionSkills({
    sessionId: params.sessionId,
    sandboxState,
    sandbox,
  });

  return {
    sandboxState,
    workingDirectory: sandbox.workingDirectory,
    currentBranch: sandbox.currentBranch,
    environmentDetails: sandbox.environmentDetails,
    skills,
    didSetupWorkspace: provisioned.didSetupWorkspace,
    sessionTitle: provisioned.session.title,
    repoOwner: provisioned.session.repoOwner ?? undefined,
    repoName: provisioned.session.repoName ?? undefined,
  };
}
