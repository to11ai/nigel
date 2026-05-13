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
  // Branch to clone. When omitted, the repo's default_branch is
  // read from GitHub (`repos.get`) and used. This is the right
  // default for Linear-triggered runs that don't carry branch
  // info — hardcoding "main" was incorrect for any repo whose
  // default is `master`, `develop`, or anything else.
  branch?: string;
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

  // Resolve the repo's numeric id + default branch in one call —
  // installation-token minting is scoped per-repo by id, not name,
  // and we need the default branch for the clone when the caller
  // didn't supply one. The app-level Octokit (JWT-authed) can read
  // any installation's accessible repos without needing a token
  // mint first.
  const appOctokit = getAppOctokit();
  let repoId: number;
  let defaultBranch: string;
  try {
    const res = await appOctokit.repos.get({
      owner: parsed.owner,
      repo: parsed.repo,
    });
    repoId = res.data.id;
    defaultBranch = res.data.default_branch;
  } catch (err) {
    throw new SandboxCoordinatorError(
      "repo_not_accessible",
      `installation ${installation.installationId} cannot access ${input.repoRef}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const branch = input.branch ?? defaultBranch;

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
    // `connectSandbox` has an overloaded signature: when the first
    // argument is a config object (detected by nested `state.type`),
    // the factory calls `connectVercel(config.state, config.options)`
    // and IGNORES the second `legacyOptions` argument entirely.
    // Putting `githubToken` in the second position would silently
    // drop the clone credential and fail private-repo bootstrap
    // with a 403. The options have to live inside the config
    // object as `options`.
    sandbox = await connectSandbox({
      state: {
        type: "vercel",
        source: {
          repo: `https://github.com/${parsed.owner}/${parsed.repo}`,
          branch,
        },
      },
      options: {
        githubToken: token,
        ports: DEFAULT_SANDBOX_PORTS,
      },
    });
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
      // Capture the sandbox's reconnection identity in the state so
      // dispatched child specialists with sandboxPolicy: "inherit"
      // can `connectSandbox` back to the SAME sandbox instead of
      // spinning up an empty one. Without the `sandboxName` here,
      // `connectVercel` falls through to creating a new empty
      // sandbox (no source, no clone) and every child runs against
      // a blank workspace — silently breaking every planner → coder
      // dispatch chain. `getState()` is optional on the Sandbox
      // interface but always present on the Vercel concrete class,
      // which is what `connectVercel` returns for fresh sandboxes.
      state:
        typeof sandbox.getState === "function"
          ? (sandbox.getState() as SandboxState)
          : ({ type: "vercel" } as SandboxState),
      workingDirectory: sandbox.workingDirectory,
      currentBranch: sandbox.currentBranch,
      environmentDetails: sandbox.environmentDetails,
    }),
    stop: async () => {
      // Owned by this Run — tear it down. `stop()` is part of the
      // base Sandbox interface (non-optional) and idempotent if
      // the sandbox is already gone, so a double call from the
      // workflow's finally + the caller's catch is safe. No
      // defensive `typeof` check: a missing method should fail
      // loudly at build time via typecheck, not silently at
      // runtime leaving sandboxes running.
      await sandbox.stop();
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
