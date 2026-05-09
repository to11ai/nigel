import {
  connectSandbox,
  type Sandbox,
  type SandboxState,
} from "@nigel/sandbox";
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
  // Phase 4 PR #1 only supports the "inherit" sandbox policy — child Runs
  // attach to a sandbox an ancestor (typically the chat-driven top-level
  // Run) already owns. Fresh-sandbox provisioning for top-level specialist
  // Runs is deferred to a later PR. If `inheritFrom` is null, this throws.
  inheritFrom: SandboxState | null;
};

export class SandboxNotProvisionedError extends Error {
  constructor() {
    super(
      "Phase 4 only supports specialist execution under a Run whose ancestor already owns a sandbox; pass `inheritFrom` with a non-null SandboxState",
    );
    this.name = "SandboxNotProvisionedError";
  }
}

export async function provisionSandboxForRun(
  input: ProvisionInput,
): Promise<ProvisionedSandbox> {
  if (!input.inheritFrom) {
    throw new SandboxNotProvisionedError();
  }
  const sandbox = await connectSandbox(input.inheritFrom, {
    ports: DEFAULT_SANDBOX_PORTS,
  });
  const ownedByThisRun = false;
  return {
    sandbox,
    workingDirectory: sandbox.workingDirectory,
    ownedByThisRun,
    toAgentContext: () => ({
      state: input.inheritFrom!,
      workingDirectory: sandbox.workingDirectory,
      currentBranch: sandbox.currentBranch,
      environmentDetails: sandbox.environmentDetails,
    }),
    stop: async () => {
      // No-op when inherited; the ancestor owns the lifecycle.
    },
  };
}

export async function teardownSandboxForRun(
  handle: ProvisionedSandbox,
): Promise<void> {
  if (handle.ownedByThisRun) {
    // Call through the handle so any per-instance cleanup added later
    // (Phase 4b: cost-finalization, log flush, etc.) is honored.
    await handle.stop();
  }
}
