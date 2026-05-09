import { gateway, nigelTools } from "@nigel/agent";
import { stepCountIs, ToolLoopAgent } from "ai";
import { extractGatewayCost } from "@/app/workflows/gateway-metadata";
import type { ResolvedSpecialist } from "@/lib/specialists";
import { checkRootBudget as defaultCheckRootBudget } from "./budget";
import { computeCostMicros } from "./cost";
import { addCostMicros as defaultAddCostMicros } from "./repository";
import type { AgentSandboxContext } from "./sandbox-coordinator";
import { filterAgentTools } from "./tool-allowlist";
import type { AgentRun } from "./types";

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
    },
    prepareStep: async () => {
      await checkRootBudget(run.rootRunId);
      return undefined;
    },
    onStepFinish: async (step) => {
      const usd = extractGatewayCost(step.providerMetadata);
      if (usd !== undefined) {
        await addCostMicros(run.id, Math.round(usd * 1_000_000));
        return;
      }
      const inputTokens = step.usage?.inputTokens;
      const outputTokens = step.usage?.outputTokens;
      if (inputTokens != null && outputTokens != null) {
        try {
          const micros = computeCostMicros(specialist.model as string, {
            inputTokens,
            outputTokens,
            cacheReadTokens: step.usage?.inputTokenDetails?.cacheReadTokens,
          });
          await addCostMicros(run.id, micros);
        } catch {
          // Unknown model in PRICING table; don't fail the run, just
          // under-report cost until the table is updated.
        }
      }
    },
  });

  const result = await agent.generate({
    messages: [{ role: "user", content: task }],
  });

  return { output: result.text };
}
