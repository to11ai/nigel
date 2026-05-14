import type {
  ClickhouseQueryCallback,
  DatabaseQueryCallback,
  DispatchSpecialistCallback,
  McpCallCallback,
  RedisCommandCallback,
  SlackPostCallback,
} from "@nigel/agent";
import { gateway, nigelTools } from "@nigel/agent";
import { type Attributes, SpanStatusCode, trace } from "@opentelemetry/api";
import type { SandboxState } from "@nigel/sandbox";
import { stepCountIs, ToolLoopAgent } from "ai";
import { extractGatewayCost } from "@/app/workflows/gateway-metadata";
import { agentActivityCreate as defaultAgentActivityCreate } from "@/lib/linear/client";
import {
  resolveLinearWorkspace as defaultResolveLinearWorkspace,
  type ResolvedLinearWorkspace,
} from "@/lib/linear/workspace-repository";
import type { ResolvedSpecialist } from "@/lib/specialists";
import { checkRootBudget as defaultCheckRootBudget } from "./budget";
import { createClickhouseQueryCallback } from "./clickhouse-query";
import { computeCostMicros } from "./cost";
import { createDatabaseQueryCallback } from "./database-query";
import { createMcpCallCallback } from "./mcp-call";
import { createRedisCommandCallback } from "./redis-command";
import { createSlackPostCallback } from "./slack-post";
import { persistInitialUserMessage, persistRunStep } from "./run-persistence";
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

// Phase 7b: one OTel tracer per concern. Tool-call spans (Phase 7c)
// will use a separate tracer name so dashboards can filter by
// instrumentation layer.
const tracer = trace.getTracer("nigel.specialist");

// Build the attribute bag for a specialist span. Split out so undefined
// values are dropped (OTel rejects them) rather than coerced. Kept as a
// plain function — the values are run/specialist immutables, so no
// reason to thread the span through.
function buildSpecialistSpanAttributes(input: {
  run: AgentRun;
  specialist: ResolvedSpecialist;
}): Attributes {
  const { run, specialist } = input;
  const attrs: Attributes = {
    "nigel.specialist.name": specialist.name,
    "nigel.specialist.kind": specialist.kind,
    "nigel.run.id": run.id,
    "nigel.run.root_id": run.rootRunId,
    "nigel.run.depth": run.depth,
    "nigel.run.trigger_source": run.triggerSource,
    "nigel.run.sandbox_policy": run.sandboxPolicy,
    "nigel.run.budget_micros": run.budgetUsdCapMicros,
  };
  if (specialist.model) {
    attrs["nigel.specialist.model"] = specialist.model;
  }
  if (run.parentRunId !== null) {
    attrs["nigel.run.parent_id"] = run.parentRunId;
  }
  return attrs;
}

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
    // And the ClickHouse equivalent.
    clickhouseQuery?: ClickhouseQueryCallback;
    // And the Redis equivalent.
    redisCommand?: RedisCommandCallback;
    // And the MCP equivalent.
    mcpCall?: McpCallCallback;
    // And the Slack equivalent.
    slackPost?: SlackPostCallback;
    // Linear AgentSession streaming seams. Both have to be
    // injectable separately: the workspace resolver decrypts
    // secrets via the DB, while agentActivityCreate hits Linear's
    // GraphQL API — tests stub each to verify the streaming
    // path without network or DB access. Matches the seam
    // pattern used for the other external dependencies above.
    resolveLinearWorkspace?: () => Promise<ResolvedLinearWorkspace | null>;
    agentActivityCreate?: typeof defaultAgentActivityCreate;
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
//
// Phase 7b: the whole execution is wrapped in an OTel `specialist.execute`
// span. `startActiveSpan` installs the span as the current context so
// downstream tool spans (Phase 7c) attach as children automatically. The
// span ends in `finally`; failures record an exception + ERROR status.
export async function executeSpecialistViaLLM(
  input: ExecuteSpecialistInput,
): Promise<ExecuteSpecialistResult> {
  const { run, sandbox, specialist, task, deps } = input;
  if (!specialist.systemPrompt || !specialist.model) {
    throw new Error(
      `LLM specialist '${specialist.name}' is missing systemPrompt or model`,
    );
  }
  const systemPrompt = specialist.systemPrompt;
  const model = specialist.model;
  const checkRootBudget = deps?.checkRootBudget ?? defaultCheckRootBudget;
  const addCostMicros = deps?.addCostMicros ?? defaultAddCostMicros;
  const resolveLinearWorkspace =
    deps?.resolveLinearWorkspace ?? defaultResolveLinearWorkspace;
  const agentActivityCreate =
    deps?.agentActivityCreate ?? defaultAgentActivityCreate;

  return tracer.startActiveSpan(
    "specialist.execute",
    { attributes: buildSpecialistSpanAttributes({ run, specialist }) },
    async (span) => {
      // Declared outside the try so the `finally` can still flush
      // the aggregate cost when the agent throws mid-run (budget
      // exhaustion, network failure, etc). Without this, completed
      // steps' costs would be recorded as individual events but
      // the rollup attribute would be missing — making partial-run
      // cost queries hard.
      let totalCostMicros = 0;
      // Resolve the Linear workspace ONCE per run when this run
      // has an AgentSession id stamped. resolveLinearWorkspace
      // decrypts the secrets bag — calling it per-step would be
      // wasteful, and the 24h access token comfortably outlives
      // even long planner runs. Failures here just disable
      // AgentActivity streaming for this run; the run itself
      // proceeds normally and Linear's session panel will fall
      // back to its "did not respond" placeholder.
      let agentSessionContext: {
        accessToken: string;
        agentSessionId: string;
      } | null = null;
      if (run.linearAgentSessionId) {
        try {
          const workspace = await resolveLinearWorkspace();
          if (workspace) {
            agentSessionContext = {
              accessToken: workspace.secrets.accessToken,
              agentSessionId: run.linearAgentSessionId,
            };
          }
        } catch (err) {
          console.error(
            `[specialist-execution] resolveLinearWorkspace failed for run ${run.id}; AgentActivity disabled`,
            err,
          );
        }
      }
      try {
        // dispatch_specialist callback — see comment near the
        // experimental_context binding for the lazy-import rationale.
        const dispatchSpecialistFn: DispatchSpecialistCallback =
          deps?.dispatchSpecialist ??
          (async (callInput) => {
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

        // Each tool callback closures-in the current specialist's
        // name so the scope check inside the callback can refuse a
        // connection scoped to a different specialist.
        const databaseQueryFn: DatabaseQueryCallback =
          deps?.databaseQuery ??
          createDatabaseQueryCallback({ specialistName: specialist.name });
        const clickhouseQueryFn: ClickhouseQueryCallback =
          deps?.clickhouseQuery ??
          createClickhouseQueryCallback({ specialistName: specialist.name });
        const redisCommandFn: RedisCommandCallback =
          deps?.redisCommand ??
          createRedisCommandCallback({ specialistName: specialist.name });
        const mcpCallFn: McpCallCallback =
          deps?.mcpCall ??
          createMcpCallCallback({ specialistName: specialist.name });
        const slackPostFn: SlackPostCallback =
          deps?.slackPost ??
          createSlackPostCallback({ specialistName: specialist.name });

        const filteredTools = filterAgentTools(
          specialist.toolAllowlist,
          nigelTools,
        );
        const callModel = specialist.providerOptions
          ? gateway(model, {
              providerOptionsOverrides: specialist.providerOptions,
            })
          : gateway(model);

        const agent = new ToolLoopAgent({
          model: callModel,
          instructions: systemPrompt,
          // Cast: filterAgentTools returns Partial<ToolSet> but
          // ToolLoopAgent accepts any ToolSet at construction time.
          // Same runtime shape; type widening is safe.
          tools: filteredTools as unknown as typeof nigelTools,
          stopWhen: stepCountIs(MAX_STEPS),
          // isAgentContext requires both `sandbox` and `model` keys.
          experimental_context: {
            sandbox,
            model: callModel,
            dispatchSpecialist: dispatchSpecialistFn,
            databaseQuery: databaseQueryFn,
            clickhouseQuery: clickhouseQueryFn,
            redisCommand: redisCommandFn,
            mcpCall: mcpCallFn,
            slackPost: slackPostFn,
          },
          prepareStep: async () => {
            await checkRootBudget(run.rootRunId);
            return undefined;
          },
          onStepFinish: async (step) => {
            // Cost reporting is best-effort. A transient DB error
            // or unknown-model lookup must NOT crash the agent loop
            // or fail an otherwise-successful step.
            const micros = resolveStepCostMicros(step, model);
            // Emit a span event for every finished step regardless
            // of cost resolution — token counts are independent and
            // useful on their own.
            span.addEvent("specialist.step", {
              "step.input_tokens": step.usage?.inputTokens ?? 0,
              "step.output_tokens": step.usage?.outputTokens ?? 0,
              "step.cache_read_tokens":
                step.usage?.inputTokenDetails?.cacheReadTokens ?? 0,
              ...(micros !== null ? { "step.cost_micros": micros } : {}),
            });
            // Persist visibility artifacts: run_messages (assistant
            // content), run_tool_calls (per tool invocation), and
            // usage_events (per-step token counts). All three are
            // best-effort — same rationale as the cost write below.
            // Before this hook every Linear-triggered run was
            // invisible after the fact; the planner could burn the
            // whole budget with no record of what it did.
            try {
              await persistRunStep({
                runId: run.id,
                userId: run.humanOwnerId,
                step,
                triggerSource: run.triggerSource,
              });
            } catch (err) {
              console.error(
                `[specialist-execution] persistRunStep failed for run ${run.id}; activity log under-reported`,
                err,
              );
            }
            if (micros !== null) {
              totalCostMicros += micros;
              try {
                await addCostMicros(run.id, micros);
              } catch (err) {
                console.error(
                  `[specialist-execution] addCostMicros failed for run ${run.id}; cost under-reported`,
                  err,
                );
              }
            }
            // Stream AgentActivity to the Linear session panel so
            // the user sees that work is happening. Per Linear's
            // docs (https://linear.app/developers/agent-interaction),
            // the content shape varies by activity type:
            //   - "thought" / "response" / "error" / "elicitation"
            //     take { type, body }
            //   - "action" takes { type, action, parameter, result? }
            //     — body is NOT valid here, Linear rejects it
            //
            // For text content from the model, emit a "thought".
            // For each tool call, emit a separate "action" with the
            // tool name (past tense for now since we have no
            // pre-tool-call hook) and the JSON-stringified input
            // truncated. Fire-and-forget for each post — Linear API
            // hiccups must not abort the agent loop.
            if (agentSessionContext) {
              const thoughtBody = extractStepText(step);
              if (thoughtBody) {
                agentActivityCreate({
                  accessToken: agentSessionContext.accessToken,
                  agentSessionId: agentSessionContext.agentSessionId,
                  content: { type: "thought", body: thoughtBody },
                }).catch((err) => {
                  console.error(
                    `[specialist-execution] thought agentActivityCreate failed for run ${run.id}`,
                    err,
                  );
                });
              }
              const resultsByCallId = new Map<string, unknown>();
              for (const tr of step.toolResults ?? []) {
                if (tr.toolCallId) {
                  resultsByCallId.set(tr.toolCallId, tr.output);
                }
              }
              for (const tc of step.toolCalls ?? []) {
                const result = resultsByCallId.get(tc.toolCallId ?? "");
                agentActivityCreate({
                  accessToken: agentSessionContext.accessToken,
                  agentSessionId: agentSessionContext.agentSessionId,
                  content: {
                    type: "action",
                    action: tc.toolName,
                    parameter: truncateForPanel(stringifyForPanel(tc.input)),
                    ...(result !== undefined
                      ? { result: truncateForPanel(stringifyForPanel(result)) }
                      : {}),
                  },
                }).catch((err) => {
                  console.error(
                    `[specialist-execution] action agentActivityCreate failed for run ${run.id}`,
                    err,
                  );
                });
              }
            }
          },
        });

        // Record the user-message that kicked off this run so the
        // viewer can show the task text alongside the assistant
        // response chain. Best-effort: a write failure here would
        // be a strange state (DB writable for cost rollup but not
        // for the initial message) so we log and continue.
        try {
          await persistInitialUserMessage({ runId: run.id, text: task });
        } catch (err) {
          console.error(
            `[specialist-execution] persistInitialUserMessage failed for run ${run.id}`,
            err,
          );
        }

        const result = await agent.generate({
          messages: [{ role: "user", content: task }],
        });
        // Final user-visible reply. Linear's session panel renders
        // this as the "response" body so the user sees something
        // concrete instead of the default "did not respond"
        // placeholder. Same fire-and-forget rationale as the
        // per-step posts above.
        if (agentSessionContext && result.text) {
          agentActivityCreate({
            accessToken: agentSessionContext.accessToken,
            agentSessionId: agentSessionContext.agentSessionId,
            content: { type: "response", body: result.text },
          }).catch((err) => {
            console.error(
              `[specialist-execution] final agentActivityCreate failed for run ${run.id}`,
              err,
            );
          });
        }
        return { output: result.text };
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        // Post a kind="error" AgentActivity so the Linear session
        // panel shows the failure instead of going silent after the
        // last successful step's activity. Without this, a budget-
        // exhausted or network-failed run would emit partial step
        // activities and then stop — the user sees "did not respond"
        // for the exact failure mode this PR exists to fix.
        // Fire-and-forget (same rationale as the per-step posts);
        // a Linear API hiccup on the error path can't mask the
        // original throw that the catch is about to re-raise.
        if (agentSessionContext) {
          const message = err instanceof Error ? err.message : String(err);
          agentActivityCreate({
            accessToken: agentSessionContext.accessToken,
            agentSessionId: agentSessionContext.agentSessionId,
            content: { type: "error", body: `Run failed: ${message}` },
          }).catch((postErr) => {
            console.error(
              `[specialist-execution] error agentActivityCreate failed for run ${run.id}`,
              postErr,
            );
          });
        }
        throw err;
      } finally {
        // Always flush the running cost total, even on the error
        // path — the attribute records work the run actually did
        // before it failed, which is what cost dashboards need.
        span.setAttribute("nigel.run.cost_total_micros", totalCostMicros);
        span.end();
      }
    },
  );
}

// Pull the plain-text portion of a step's content array, joined
// and trimmed. Returns null for steps with no text content (e.g.
// tool-call-only steps emitted by the planner) — caller skips the
// "thought" AgentActivity post in that case.
//
// Long bodies waste session-panel real estate AND Linear's API has
// payload caps, so we truncate. The Activity log on the run-detail
// page is the place to read full step content; AgentActivity is
// the at-a-glance signal.
const ACTIVITY_BODY_SNIPPET_LIMIT = 500;

function extractStepText(step: { content?: unknown }): string | null {
  if (!Array.isArray(step.content)) return null;
  const text = step.content
    .filter(
      (p): p is { type: "text"; text: string } =>
        typeof p === "object" &&
        p !== null &&
        "type" in p &&
        (p as { type: unknown }).type === "text" &&
        typeof (p as { text?: unknown }).text === "string",
    )
    .map((p) => p.text)
    .join("\n")
    .trim();
  if (!text) return null;
  return text.length > ACTIVITY_BODY_SNIPPET_LIMIT
    ? `${text.slice(0, ACTIVITY_BODY_SNIPPET_LIMIT)}…`
    : text;
}

// JSON-stringify for the session panel. Linear's docs describe
// `parameter` and `result` as plain strings (not JSON objects), so
// we serialize ourselves. Falls back to String() for non-JSON
// values (functions, BigInts, etc.) which shouldn't occur on the
// AI SDK's input/output channels but is defensive.
function stringifyForPanel(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncateForPanel(s: string): string {
  return s.length > ACTIVITY_BODY_SNIPPET_LIMIT
    ? `${s.slice(0, ACTIVITY_BODY_SNIPPET_LIMIT)}…`
    : s;
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
