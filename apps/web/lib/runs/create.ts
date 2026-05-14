import { nanoid } from "nanoid";
import { getRun, insertRun } from "./repository";
import {
  MAX_DEPTH,
  type AgentRun,
  type SandboxPolicy,
  type TriggerSource,
} from "./types";

export type CreateRunInput = {
  triggerSource: TriggerSource;
  humanOwnerId: string | null;
  parentRunId?: string | null;
  triggerRef?: string | null;
  specialistId?: string | null;
  sandboxPolicy?: SandboxPolicy;
  repoRef?: string | null;
  workflowRunId?: string | null;
  chatId?: string | null;
  budgetUsdCapMicros: number;
  // Linear AgentSession id when the run was triggered by the
  // session-panel UI (AgentSessionEvent.created). Stamps the run
  // up-front so the step-finish hook can post AgentActivity events
  // without a follow-up update. Null for chat / cron / chained
  // runs and for legacy Linear assignments that don't carry one.
  linearAgentSessionId?: string | null;
};

async function createRun(input: CreateRunInput): Promise<AgentRun> {
  if (input.triggerSource === "chained" && !input.parentRunId) {
    throw new Error("parentRunId required for trigger_source=chained");
  }

  let depth = 0;
  let rootRunId: string;

  if (input.parentRunId) {
    const parent = await getRun(input.parentRunId);
    if (!parent) {
      throw new Error(`parent run not found: ${input.parentRunId}`);
    }
    depth = parent.depth + 1;
    if (depth > MAX_DEPTH) {
      throw new Error(`run depth ${depth} exceeds MAX_DEPTH=${MAX_DEPTH}`);
    }
    rootRunId = parent.rootRunId;
  } else {
    rootRunId = "";
  }

  const id = `run_${nanoid()}`;
  if (!input.parentRunId) {
    rootRunId = id;
  }

  await insertRun({
    id,
    parentRunId: input.parentRunId ?? null,
    rootRunId,
    depth,
    triggerSource: input.triggerSource,
    triggerRef: input.triggerRef ?? null,
    specialistId: input.specialistId ?? null,
    sandboxPolicy: input.sandboxPolicy ?? "inherit",
    humanOwnerId: input.humanOwnerId,
    repoRef: input.repoRef ?? null,
    workflowRunId: input.workflowRunId ?? null,
    chatId: input.chatId ?? null,
    budgetUsdCapMicros: input.budgetUsdCapMicros,
    linearAgentSessionId: input.linearAgentSessionId ?? null,
  });

  const created = await getRun(id);
  if (!created) {
    throw new Error(`failed to read back created run: ${id}`);
  }
  return created;
}

export const Run = {
  create: createRun,
};
