import { getSpecialist } from "@/lib/specialists";
import { checkRootBudget } from "./budget";
import { Run } from "./create";
import { getRun, listChildren, updateRunStatus } from "./repository";
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

  // Phase 4 wires LLM-based specialists; until then, fail loudly so the
  // caller knows to wait for that phase rather than getting a stuck Run.
  await updateRunStatus(childRun.id, "failed").catch(() => undefined);
  throw new SpecialistDispatchError(
    `specialist '${specialist.name}' (kind=${specialist.kind}) cannot execute in Phase 2; LLM-based dispatch lands in Phase 4`,
  );
}

export async function dispatchSpecialistsParallel(
  inputs: DispatchSpecialistInput[],
): Promise<DispatchSpecialistResult[]> {
  return Promise.all(inputs.map((i) => dispatchSpecialist(i)));
}
