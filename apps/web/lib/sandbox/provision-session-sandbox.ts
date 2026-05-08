import "server-only";

import {
  connectSandbox,
  type Sandbox,
  type SandboxState,
} from "@open-agents/sandbox";
import { getSessionById, updateProvisioningSession } from "@/lib/db/sessions";
import {
  getRepoAccessErrorMessage,
  verifyRepoAccess,
} from "@/lib/github/access";
import {
  mintInstallationToken,
  revokeInstallationToken,
  type ScopedInstallationToken,
} from "@/lib/github/app";
import { getGitHubUserProfile } from "@/lib/github/users";
import {
  DEFAULT_SANDBOX_BASE_SNAPSHOT_ID,
  DEFAULT_SANDBOX_PORTS,
  DEFAULT_SANDBOX_TIMEOUT_MS,
} from "@/lib/sandbox/config";
import {
  buildActiveLifecycleUpdate,
  getNextLifecycleVersion,
} from "@/lib/sandbox/lifecycle";
import { kickSandboxLifecycleWorkflow } from "@/lib/sandbox/lifecycle-kick";
import {
  getResumableSandboxName,
  getSessionSandboxName,
  isSandboxActive,
} from "@/lib/sandbox/utils";
import { installGlobalSkills } from "@/lib/skills/global-skill-installer";

type SessionRecord = NonNullable<Awaited<ReturnType<typeof getSessionById>>>;

export type ProvisionedSessionSandbox = {
  session: SessionRecord;
  sandbox: Sandbox;
  sandboxState: SandboxState;
  didSetupWorkspace: boolean;
};

function isSandboxState(value: unknown): value is SandboxState {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "vercel"
  );
}

function buildSandboxSource(session: SessionRecord): SandboxState["source"] {
  if (!session.cloneUrl) {
    return undefined;
  }

  const branchExistsOnOrigin = session.prNumber != null;
  const shouldCreateNewBranch = session.isNewBranch && !branchExistsOnOrigin;

  return {
    repo: session.cloneUrl,
    ...(shouldCreateNewBranch
      ? { newBranch: session.branch ?? undefined }
      : { branch: session.branch ?? "main" }),
  };
}

export function buildSessionSandboxState(session: SessionRecord): SandboxState {
  const existingState = session.sandboxState;
  const sandboxName =
    getResumableSandboxName(existingState) ?? getSessionSandboxName(session.id);
  const source = buildSandboxSource(session);

  return {
    type: "vercel",
    ...(isSandboxState(existingState) ? existingState : {}),
    sandboxName,
    ...(source ? { source } : {}),
  };
}

async function getGitUser(userId: string) {
  const profile = await getGitHubUserProfile(userId);
  const githubNoreplyEmail =
    profile?.externalUserId && profile.username
      ? `${profile.externalUserId}+${profile.username}@users.noreply.github.com`
      : undefined;

  return {
    name: profile?.username ?? "Open Harness",
    email: githubNoreplyEmail ?? `${userId}@users.noreply.github.com`,
  };
}

async function mintSetupTokenIfNeeded(params: {
  userId: string;
  session: SessionRecord;
}): Promise<ScopedInstallationToken | undefined> {
  if (!params.session.cloneUrl) {
    return undefined;
  }

  if (!params.session.repoOwner || !params.session.repoName) {
    throw new Error("Session is missing repository metadata");
  }

  const access = await verifyRepoAccess({
    userId: params.userId,
    owner: params.session.repoOwner,
    repo: params.session.repoName,
  });
  if (!access.ok) {
    throw new Error(getRepoAccessErrorMessage(access.reason));
  }

  return mintInstallationToken({
    installationId: access.installationId,
    repositoryIds: [access.repositoryId],
    permissions: { contents: "read" },
  });
}

async function installSessionGlobalSkills(params: {
  session: SessionRecord;
  sandbox: Sandbox;
  didSetupWorkspace: boolean;
}): Promise<void> {
  if (!params.didSetupWorkspace) {
    return;
  }

  const globalSkillRefs = params.session.globalSkillRefs ?? [];
  if (globalSkillRefs.length === 0) {
    return;
  }

  try {
    await installGlobalSkills({
      sandbox: params.sandbox,
      globalSkillRefs,
    });
  } catch (error) {
    console.error(
      `Failed to install global skills for session ${params.session.id}:`,
      error,
    );
  }
}

async function stopSandboxAfterProvisioningAbort(params: {
  sessionId: string;
  sandbox: Sandbox;
}): Promise<void> {
  try {
    await params.sandbox.stop();
  } catch (error) {
    console.error(
      `Failed to stop sandbox after provisioning was aborted for session ${params.sessionId}:`,
      error,
    );
  }
}

export async function provisionSessionSandbox(params: {
  userId: string;
  sessionId: string;
}): Promise<ProvisionedSessionSandbox> {
  const session = await getSessionById(params.sessionId);
  if (!session) {
    throw new Error("Session not found");
  }
  if (session.userId !== params.userId) {
    throw new Error("Unauthorized");
  }
  if (session.status === "archived") {
    throw new Error("Session is archived");
  }

  const didSetupWorkspace = !isSandboxActive(session.sandboxState);
  const gitUser = await getGitUser(params.userId);
  const setupToken = await mintSetupTokenIfNeeded({
    userId: params.userId,
    session,
  });

  let sandbox: Sandbox;
  try {
    sandbox = await connectSandbox({
      state: buildSessionSandboxState(session),
      options: {
        githubToken: setupToken?.token,
        gitUser,
        timeout: DEFAULT_SANDBOX_TIMEOUT_MS,
        ports: DEFAULT_SANDBOX_PORTS,
        baseSnapshotId: DEFAULT_SANDBOX_BASE_SNAPSHOT_ID,
        persistent: true,
        resume: true,
        createIfMissing: true,
      },
    });
  } finally {
    if (setupToken) {
      await revokeInstallationToken(setupToken.token);
    }
  }

  const rawSandboxState = sandbox.getState?.();
  const sandboxState = isSandboxState(rawSandboxState)
    ? rawSandboxState
    : buildSessionSandboxState(session);

  const currentSession = await getSessionById(params.sessionId);
  if (!currentSession) {
    await stopSandboxAfterProvisioningAbort({
      sessionId: params.sessionId,
      sandbox,
    });
    throw new Error("Session not found");
  }
  if (currentSession.userId !== params.userId) {
    await stopSandboxAfterProvisioningAbort({
      sessionId: params.sessionId,
      sandbox,
    });
    throw new Error("Unauthorized");
  }
  if (currentSession.status === "archived") {
    await stopSandboxAfterProvisioningAbort({
      sessionId: params.sessionId,
      sandbox,
    });
    throw new Error("Session is archived");
  }

  const [updatedSession] = await Promise.all([
    updateProvisioningSession(params.sessionId, {
      sandboxState,
      sandboxProvisioningRunId: null,
      snapshotUrl: null,
      snapshotCreatedAt: null,
      lifecycleVersion: getNextLifecycleVersion(
        currentSession.lifecycleVersion,
      ),
      ...buildActiveLifecycleUpdate(sandboxState),
    }),
    installSessionGlobalSkills({
      session: currentSession,
      sandbox,
      didSetupWorkspace,
    }),
  ]);

  if (!updatedSession) {
    await stopSandboxAfterProvisioningAbort({
      sessionId: params.sessionId,
      sandbox,
    });
    throw new Error("Session is no longer provisioning");
  }

  kickSandboxLifecycleWorkflow({
    sessionId: params.sessionId,
    reason: "sandbox-created",
  });

  return {
    session: updatedSession,
    sandbox,
    sandboxState,
    didSetupWorkspace,
  };
}
