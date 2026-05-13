import {
  connectSandbox,
  type Sandbox,
  type SandboxState,
} from "@nigel/sandbox";
import { getInstallationByAccountLogin } from "@/lib/db/installations";
import { getAppOctokit, mintInstallationToken } from "@/lib/github/app";
import { DEFAULT_SANDBOX_PORTS } from "@/lib/sandbox/config";

// Subset of `AgentSandboxContext` from `@nigel/agent`'s open-agent module,
// duplicated here to avoid a hard import of the agent package at this layer.
// The runtime shape is identical.
export type AgentSandboxContext = {
  state: SandboxState;
  workingDirectory: string;
  currentBranch?: string;
  environmentDetails?: string;
};

export type ProvisionedSandbox = {
  sandbox: Sandbox;
  workingDirectory: string;
  ownedByThisRun: boolean;
  toAgentContext(): AgentSandboxContext;
  stop(): Promise<void>;
};

export type ProvisionInput = {
  // Inherit mode: child Runs attach to a sandbox an ancestor (typically
  // the chat-driven top-level Run) already owns. Pass `inheritFrom`
  // with a non-null SandboxState.
  inheritFrom: SandboxState | null;
};

export type ProvisionFreshInput = {
  // Fresh mode: clone the repo into a brand-new sandbox owned by this
  // Run. Used by Linear-triggered top-level Runs that have no ancestor.
  // The sandbox's lifecycle is bound to the Run; `stop()` on the
  // returned handle tears it down.
  repoRef: string; // "owner/repo"
  branch: string;
  // The Nigel user whose GitHub installation provides the clone token.
  // For Linear-triggered runs this is the `humanOwnerId` resolved by
  // the webhook handler.
  humanOwnerId: string;
};

// Single error class for every sandbox-coordinator failure mode so
// this file stays under the "one class per file" lint rule.
// Discriminate via `code` when you need to react to a specific
// cause. Matches the pattern in lib/tool-connections.
export type SandboxCoordinatorErrorCode =
  | "not_provisioned"
  | "invalid_repo_ref"
  | "no_installation"
  | "repo_not_accessible"
  | "token_mint_failed"
  | "sandbox_create_failed";

export class SandboxCoordinatorError extends Error {
  readonly code: SandboxCoordinatorErrorCode;
  constructor(code: SandboxCoordinatorErrorCode, message: string) {
    super(message);
    this.name = "SandboxCoordinatorError";
    this.code = code;
  }
}

// Inherit-mode provisioning. Used by dispatched child Runs whose
// parent already owns a sandbox. Throws if `inheritFrom` is null.
export async function provisionSandboxForRun(
  input: ProvisionInput,
): Promise<ProvisionedSandbox> {
  if (!input.inheritFrom) {
    throw new SandboxCoordinatorError(
      "not_provisioned",
      "sandbox-coordinator: pass `inheritFrom` (inherit mode) or call provisionFreshSandboxForRun (fresh mode)",
    );
  }
  const sandbox = await connectSandbox(input.inheritFrom, {
    ports: DEFAULT_SANDBOX_PORTS,
  });
  return {
    sandbox,
    workingDirectory: sandbox.workingDirectory,
    ownedByThisRun: false,
    toAgentContext: () => ({
      state: input.inheritFrom as SandboxState,
      workingDirectory: sandbox.workingDirectory,
      currentBranch: sandbox.currentBranch,
      environmentDetails: sandbox.environmentDetails,
    }),
    stop: async () => {
      // No-op when inherited; the ancestor owns the lifecycle.
    },
  };
}

// Fresh-mode provisioning. Resolves the GitHub installation, mints a
// scoped clone token, and creates a new Vercel sandbox cloning the
// requested repo + branch. The returned handle's `stop()` tears down
// the sandbox — callers must invoke it (typically in a try/finally).
//
// Used by Phase 6 L2b: Linear-triggered runs are top-level (no
// ancestor sandbox) and need to clone the target repo themselves
// before the planner can read / edit it.
export async function provisionFreshSandboxForRun(
  input: ProvisionFreshInput,
): Promise<ProvisionedSandbox> {
  const parsed = parseRepoRef(input.repoRef);
  if (!parsed) {
    throw new SandboxCoordinatorError(
      "invalid_repo_ref",
      `repoRef '${input.repoRef}' is not in 'owner/repo' format`,
    );
  }
  const installation = await getInstallationByAccountLogin(
    input.humanOwnerId,
    parsed.owner,
  );
  if (!installation) {
    throw new SandboxCoordinatorError(
      "no_installation",
      `no GitHub App installation found for user '${input.humanOwnerId}' under owner '${parsed.owner}'`,
    );
  }

  // Resolve the repo's numeric id — installation-token minting is
  // scoped per-repo by id, not name. The app-level Octokit (JWT-
  // authed) can read any installation's accessible repos without
  // needing a token mint first.
  const appOctokit = getAppOctokit();
  let repoId: number;
  try {
    const res = await appOctokit.repos.get({
      owner: parsed.owner,
      repo: parsed.repo,
    });
    repoId = res.data.id;
  } catch (err) {
    throw new SandboxCoordinatorError(
      "repo_not_accessible",
      `installation ${installation.installationId} cannot access ${input.repoRef}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let token: string;
  try {
    const minted = await mintInstallationToken({
      installationId: installation.installationId,
      repositoryIds: [repoId],
      permissions: { contents: "write" },
    });
    token = minted.token;
  } catch (err) {
    throw new SandboxCoordinatorError(
      "token_mint_failed",
      err instanceof Error ? err.message : String(err),
    );
  }

  let sandbox: Sandbox;
  try {
    sandbox = await connectSandbox(
      {
        state: {
          type: "vercel",
          source: {
            repo: `https://github.com/${parsed.owner}/${parsed.repo}`,
            branch: input.branch,
          },
        },
      },
      {
        githubToken: token,
        ports: DEFAULT_SANDBOX_PORTS,
      },
    );
  } catch (err) {
    throw new SandboxCoordinatorError(
      "sandbox_create_failed",
      err instanceof Error ? err.message : String(err),
    );
  }

  return {
    sandbox,
    workingDirectory: sandbox.workingDirectory,
    ownedByThisRun: true,
    toAgentContext: () => ({
      // The freshly-created sandbox's state lives on the sandbox
      // instance via its connection metadata. We pass an empty
      // `source`-less state because the agent context only needs
      // the live sandbox handle's runtime values; it never
      // re-uses `state` for reconnection.
      state: { type: "vercel" } as SandboxState,
      workingDirectory: sandbox.workingDirectory,
      currentBranch: sandbox.currentBranch,
      environmentDetails: sandbox.environmentDetails,
    }),
    stop: async () => {
      // Owned by this Run — tear it down. The sandbox SDK's stop()
      // is idempotent if the sandbox is already gone, so a double
      // call from the workflow's finally + the caller's catch is
      // safe.
      const session = (sandbox as unknown as { stop?: () => Promise<unknown> })
        .stop;
      if (typeof session === "function") {
        await session.call(sandbox);
      }
    },
  };
}

export async function teardownSandboxForRun(
  handle: ProvisionedSandbox,
): Promise<void> {
  if (handle.ownedByThisRun) {
    await handle.stop();
  }
}

function parseRepoRef(ref: string): { owner: string; repo: string } | null {
  const trimmed = ref.trim();
  const match = /^([a-z0-9._-]+)\/([a-z0-9._-]+)$/i.exec(trimmed);
  if (!match?.[1] || !match[2]) return null;
  return { owner: match[1], repo: match[2] };
}
