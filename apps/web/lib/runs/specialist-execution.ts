import type {
  DatabaseQueryCallback,
  DispatchSpecialistCallback,
} from "@nigel/agent";
import { gateway, nigelTools } from "@nigel/agent";
import type { SandboxState } from "@nigel/sandbox";
import { stepCountIs, ToolLoopAgent } from "ai";
import { extractGatewayCost } from "@/app/workflows/gateway-metadata";
import type { ResolvedSpecialist } from "@/lib/specialists";
import { checkRootBudget as defaultCheckRootBudget } from "./budget";
import { computeCostMicros } from "./cost";
import { createDatabaseQueryCallback } from "./database-query";
import { addCostMicros as defaultAddCostMicros } from "./repository";
import type { AgentSandboxContext } from "./sandbox-coordinator";
import { filterAgentTools } from "./tool-allowlist";
import type { AgentRun, SandboxPolicy } from "./types";

// `provisionSandboxForRun` decides inherit-vs-fresh from `inheritFrom`
// only and does not look at the child run's sandboxPolicy. So a
// `fresh`/`fresh_clean` override from the LLM gets silently negated if
// we also forward the parent's sandbox state. Return true only when
// inheritance is actually permitted by the override (or omitted, in
// which case the specialist's own preset wins downstream).
export function shouldForwardInheritedSandbox(
  state: SandboxState | null | undefined,
  override: SandboxPolicy | undefined,
): state is SandboxState {
  if (!state) return false;
  return override === undefined || override === "inherit";
}

const MAX_STEPS = 50;

export type ExecuteSpecialistInput = {
  run: AgentRun;
  sandbox: AgentSandboxContext;
  specialist: ResolvedSpecialist;
  task: string;
  // Test-only injection seams. Production callers should not set these.
  // Module mocking via bun:test's mock.module leaks across files in the
  // same `bun test` invocation, so we accept dependencies explicitly to
  // keep the cost-rollup integration tests working when this file's
  // unit tests run in the same process.
  deps?: {
    checkRootBudget?: (rootRunId: string) => Promise<void>;
    addCostMicros?: (runId: string, deltaMicros: number) => Promise<void>;
    // Curried dispatch callback handed to the dispatch_specialist tool.
    // The tool calls this with { specialistName, task, ... }; the wrapper
    // is responsible for filling in parentRunId + inheritSandboxState
    // before calling dispatchSpecialist() proper. Defaults to a binding
    // around the real dispatch function (set up at call time so we
    // avoid an import cycle).
    dispatchSpecialist?: DispatchSpecialistCallback;
    // Same DI seam for the database_query tool callback. Production
    // callers leave this unset and the wrapper builds a callback
    // bound to the current specialist's name (used by the scope
    // check inside the callback).
    databaseQuery?: DatabaseQueryCallback;
  };
};

export type ExecuteSpecialistResult = {
  output: string;
};

// Runs the LLM-driven specialist's ToolLoop. Per-step hooks:
//   - prepareStep: pre-call budget check; throws BudgetExhaustedError on
//     cap exceeded, which surfaces out of agent.generate() and the caller
//     transitions the Run to `blocked`.
//   - onStepFinish: post-call cost capture from providerMetadata.gateway.cost
//     (preferred) or computed from token counts (fallback for direct-provider
//     calls). Cost rolls up to root via the Phase 1 trigger.
export async function executeSpecialistViaLLM(
  input: ExecuteSpecialistInput,
): Promise<ExecuteSpecialistResult> {
  const { run, sandbox, specialist, task, deps } = input;
  if (!specialist.systemPrompt || !specialist.model) {
    throw new Error(
      `LLM specialist '${specialist.name}' is missing systemPrompt or model`,
    );
  }
  const checkRootBudget = deps?.checkRootBudget ?? defaultCheckRootBudget;
  const addCostMicros = deps?.addCostMicros ?? defaultAddCostMicros;
  // The dispatch_specialist tool, exposed via experimental_context,
  // calls this curried callback. The wrapper supplies a default that
  // imports dispatchSpecialist lazily (inside the call) to avoid a
  // module-load-time circular import between dispatch.ts and
  // specialist-execution.ts.
  const dispatchSpecialistFn: DispatchSpecialistCallback =
    deps?.dispatchSpecialist ??
    (async (callInput) => {
      // Lazy import: dispatch.ts depends on specialist-execution.ts,
      // and a top-level import here would create a cycle that breaks
      // when tests mock either module.
      const { dispatchSpecialist } = await import("./dispatch");
      const result = await dispatchSpecialist({
        parentRunId: run.id,
        specialistName: callInput.specialistName,
        task: callInput.task,
        ...(callInput.budgetUsdMicros !== undefined
          ? { budgetUsdMicros: callInput.budgetUsdMicros }
          : {}),
        ...(callInput.sandboxPolicyOverride !== undefined
          ? { sandboxPolicyOverride: callInput.sandboxPolicyOverride }
          : {}),
        ...(shouldForwardInheritedSandbox(
          sandbox.state,
          callInput.sandboxPolicyOverride,
        )
          ? { inheritSandboxState: sandbox.state }
          : {}),
      });
      return { output: result.output };
    });

  // database_query callback. Like the dispatchSpecialist callback,
  // closures-in the things only this run knows — specifically the
  // specialist's own name, which the scope check inside the callback
  // uses to refuse connections scoped to a different specialist.
  const databaseQueryFn: DatabaseQueryCallback =
    deps?.databaseQuery ??
    createDatabaseQueryCallback({ specialistName: specialist.name });

  const filteredTools = filterAgentTools(specialist.toolAllowlist, nigelTools);
  const callModel = gateway(specialist.model);

  const agent = new ToolLoopAgent({
    model: callModel,
    instructions: specialist.systemPrompt,
    // Cast: filterAgentTools returns Partial<ToolSet> but the ToolLoopAgent
    // accepts any ToolSet at construction time. Both consumers see the same
    // runtime shape; the type widening is safe.
    tools: filteredTools as unknown as typeof nigelTools,
    stopWhen: stepCountIs(MAX_STEPS),
    // The agent's tools (read/write/edit/grep/glob/bash/etc.) read sandbox
    // and model from experimental_context. isAgentContext requires both
    // `sandbox` and `model` keys to be present.
    experimental_context: {
      sandbox,
      model: callModel,
      dispatchSpecialist: dispatchSpecialistFn,
      databaseQuery: databaseQueryFn,
    },
    prepareStep: async () => {
      await checkRootBudget(run.rootRunId);
      return undefined;
    },
    onStepFinish: async (step) => {
      // Cost reporting is best-effort. A transient DB error or an
      // unknown-model lookup must NOT crash the agent loop or fail an
      // otherwise-successful step. Both paths log on failure so leaks
      // are observable.
      const micros = resolveStepCostMicros(step, specialist.model as string);
      if (micros === null) return;
      try {
        await addCostMicros(run.id, micros);
      } catch (err) {
        console.error(
          `[specialist-execution] addCostMicros failed for run ${run.id}; cost under-reported`,
          err,
        );
      }
    },
  });

  const result = await agent.generate({
    messages: [{ role: "user", content: task }],
  });

  return { output: result.text };
}

// Resolves per-step cost in micros, preferring gateway-reported cost
// (preferred path) and falling back to PRICING-table computation when
// the gateway didn't attach a cost. Returns null when neither path
// produces a value (no gateway data + missing tokens, or unknown model
// in the PRICING table). Caller is responsible for the actual
// addCostMicros write and its error handling.
type StepUsage = {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  inputTokenDetails?: { cacheReadTokens?: number | undefined } | undefined;
};
type StepLike = {
  providerMetadata?: Parameters<typeof extractGatewayCost>[0];
  usage?: StepUsage;
};

function resolveStepCostMicros(step: StepLike, modelId: string): number | null {
  const usd = extractGatewayCost(step.providerMetadata);
  if (usd !== undefined) {
    return Math.round(usd * 1_000_000);
  }
  const inputTokens = step.usage?.inputTokens;
  const outputTokens = step.usage?.outputTokens;
  if (inputTokens == null || outputTokens == null) return null;
  try {
    return computeCostMicros(modelId, {
      inputTokens,
      outputTokens,
      cacheReadTokens: step.usage?.inputTokenDetails?.cacheReadTokens,
    });
  } catch {
    // Unknown model id in the PRICING table; cost just under-reports
    // until the table is updated. Not a run-breaking condition.
    return null;
  }
}
