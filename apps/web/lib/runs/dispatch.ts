import type { SandboxState } from "@nigel/sandbox";
import { getSpecialist } from "@/lib/specialists";
import { BudgetExhaustedError, checkRootBudget } from "./budget";
import { Run } from "./create";
import { getRun, listChildren, updateRunStatus } from "./repository";
import {
  type ProvisionedSandbox,
  type ProvisionInput,
  provisionSandboxForRun as defaultProvisionSandboxForRun,
  teardownSandboxForRun as defaultTeardownSandboxForRun,
} from "./sandbox-coordinator";
import {
  type ExecuteSpecialistInput,
  type ExecuteSpecialistResult,
  executeSpecialistViaLLM as defaultExecuteSpecialistViaLLM,
} from "./specialist-execution";
import type { AgentRun, SandboxPolicy } from "./types";

export class SpecialistDispatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpecialistDispatchError";
  }
}

export type DispatchSpecialistInput = {
  parentRunId: string;
  specialistName: string;
  task: string;
  sandboxPolicyOverride?: SandboxPolicy;
  budgetUsdMicros?: number;
  // Optional in the type, required at runtime for LLM specialists. The
  // agent_runs table stores only a sandbox id, not the full SandboxState
  // needed to reconnect — so the dispatch caller (chat path / Linear
  // webhook / etc.) supplies the parent session's SandboxState. If
  // omitted for an LLM specialist, `provisionSandboxForRun` throws
  // `SandboxNotProvisionedError`. Scripted specialists ignore this field.
  inheritSandboxState?: SandboxState;
  // Test-only injection seam (same pattern as ExecuteSpecialistInput.deps).
  deps?: {
    provisionSandboxForRun?: (
      input: ProvisionInput,
    ) => Promise<ProvisionedSandbox>;
    teardownSandboxForRun?: (handle: ProvisionedSandbox) => Promise<void>;
    executeSpecialistViaLLM?: (
      input: ExecuteSpecialistInput,
    ) => Promise<ExecuteSpecialistResult>;
  };
};

export type DispatchSpecialistResult = {
  childRun: AgentRun;
  output: string;
};

export async function dispatchSpecialist(
  input: DispatchSpecialistInput,
): Promise<DispatchSpecialistResult> {
  const parent = await getRun(input.parentRunId);
  if (!parent) {
    throw new SpecialistDispatchError(
      `parent run not found: ${input.parentRunId}`,
    );
  }

  // Budget check at the boundary — fail before doing anything.
  await checkRootBudget(parent.rootRunId);

  const specialist = await getSpecialist(input.specialistName);
  if (!specialist) {
    throw new SpecialistDispatchError(
      `unknown specialist: ${input.specialistName}`,
    );
  }

  // Recurse permission: a parent specialist with mayRecurse=false cannot
  // dispatch children. Top-level chat (no specialist) can always dispatch.
  if (parent.specialistId) {
    const parentSpecialist = await getSpecialist(parent.specialistId);
    if (!parentSpecialist) {
      throw new SpecialistDispatchError(
        `parent specialist '${parent.specialistId}' not found in registry; recursion constraints cannot be enforced`,
      );
    }
    if (!parentSpecialist.mayRecurse) {
      throw new SpecialistDispatchError(
        `parent specialist '${parent.specialistId}' does not allow recursion`,
      );
    }
    // Per-specialist max-children cap.
    const siblings = await listChildren(parent.id);
    if (
      parentSpecialist.maxChildren > 0 &&
      siblings.length >= parentSpecialist.maxChildren
    ) {
      throw new SpecialistDispatchError(
        `parent specialist '${parent.specialistId}' has reached max_children=${parentSpecialist.maxChildren}`,
      );
    }
  }

  // Run.create handles depth > MAX_DEPTH and parent existence.
  const childRun = await Run.create({
    triggerSource: "chained",
    humanOwnerId: parent.humanOwnerId,
    parentRunId: parent.id,
    specialistId: specialist.name,
    sandboxPolicy: input.sandboxPolicyOverride ?? specialist.sandboxPolicy,
    repoRef: parent.repoRef,
    chatId: parent.chatId,
    budgetUsdCapMicros:
      input.budgetUsdMicros ?? specialist.budgetUsdDefaultMicros,
  });

  // Phase 2 only supports scripted execution end-to-end. LLM-driven
  // specialists (kind='preset' or 'custom' with a model+systemPrompt) are
  // wired in Phase 4.
  if (specialist.kind === "scripted" && specialist.script) {
    await updateRunStatus(childRun.id, "running");
    try {
      const output = await specialist.script(input.task);
      await updateRunStatus(childRun.id, "completed");
      const refreshed = (await getRun(childRun.id)) ?? childRun;
      return { childRun: refreshed, output };
    } catch (err) {
      await updateRunStatus(childRun.id, "failed").catch(() => undefined);
      throw err;
    }
  }

  // Phase 4b: LLM-driven specialists (kind = 'preset' | 'custom').
  if (!specialist.systemPrompt || !specialist.model) {
    await updateRunStatus(childRun.id, "failed").catch(() => undefined);
    throw new SpecialistDispatchError(
      `specialist '${specialist.name}' is incomplete (missing systemPrompt or model)`,
    );
  }

  const provisionSandboxForRun =
    input.deps?.provisionSandboxForRun ?? defaultProvisionSandboxForRun;
  const teardownSandboxForRun =
    input.deps?.teardownSandboxForRun ?? defaultTeardownSandboxForRun;
  const executeSpecialistViaLLM =
    input.deps?.executeSpecialistViaLLM ?? defaultExecuteSpecialistViaLLM;

  let provisioned: ProvisionedSandbox | null = null;
  try {
    await updateRunStatus(childRun.id, "running");
    provisioned = await provisionSandboxForRun({
      inheritFrom: input.inheritSandboxState ?? null,
    });
    const result = await executeSpecialistViaLLM({
      run: childRun,
      sandbox: provisioned.toAgentContext(),
      specialist,
      task: input.task,
    });
    await updateRunStatus(childRun.id, "completed");
    const refreshed = (await getRun(childRun.id)) ?? childRun;
    return { childRun: refreshed, output: result.output };
  } catch (err) {
    if (err instanceof BudgetExhaustedError) {
      await updateRunStatus(childRun.id, "blocked", {
        blockedReason: "budget exhausted",
      }).catch(() => undefined);
    } else {
      await updateRunStatus(childRun.id, "failed").catch(() => undefined);
    }
    throw err;
  } finally {
    if (provisioned) {
      // Don't let teardown failure mask the original outcome (success or
      // the original throw). But do log — silent failure here can leak
      // sandboxes that hold quota and writable repo access.
      try {
        await teardownSandboxForRun(provisioned);
      } catch (teardownErr) {
        console.error(
          `[dispatch] sandbox teardown failed for run ${childRun.id}; sandbox may be leaked`,
          teardownErr,
        );
      }
    }
  }
}

export async function dispatchSpecialistsParallel(
  inputs: DispatchSpecialistInput[],
): Promise<DispatchSpecialistResult[]> {
  return Promise.all(inputs.map((i) => dispatchSpecialist(i)));
}
