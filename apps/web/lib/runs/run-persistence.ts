import { nanoid } from "nanoid";
import { db } from "@/lib/db/client";
import { runMessages, runToolCalls, usageEvents } from "@/lib/db/schema";

// Persistence for agent run activity.
//
// Before this module, `executeSpecialistViaLLM` only recorded cost on
// `agent_runs.cost_usd_actual_micros`. The `run_messages`,
// `run_tool_calls`, and `usage_events` tables existed in the schema
// but had zero writers — so every Linear-triggered run that wasn't
// chat-coupled was invisible after the fact. The planner could spend
// the entire budget cap with no record of what it did.
//
// Writes are best-effort: every call site wraps in try/catch so a
// persistence failure can never crash the agent loop or fail an
// otherwise-successful step. The cost-tracking call in
// `specialist-execution.ts` follows the same pattern and the
// rationale is identical — observability surfaces must not block
// the actual work.

// Tool-kind classification for the run_tool_calls.tool_kind column.
// Mirrors the categories the observability layer uses elsewhere; new
// tools default to "agent" until they're listed explicitly here.
function classifyTool(name: string): string {
  if (name === "dispatch_specialist") return "dispatch";
  if (name === "database_query" || name === "clickhouse_query") return "query";
  if (name === "redis_command") return "redis";
  if (name === "mcp_call") return "mcp";
  if (name === "slack_post") return "slack";
  return "agent";
}

// Shape of an `ai` SDK `StepResult` that the persistence layer reads.
// We don't import the full type — it's heavily generic and pulls in
// the ToolSet of every defined tool — but capture the fields we
// actually use.
export type StepLikeForPersistence = {
  content: unknown;
  toolCalls?: ReadonlyArray<{
    toolName: string;
    input?: unknown;
    toolCallId?: string;
  }>;
  toolResults?: ReadonlyArray<{
    toolCallId?: string;
    output?: unknown;
  }>;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    inputTokenDetails?: { cacheReadTokens?: number };
  };
  model?: {
    provider?: string;
    modelId?: string;
  };
};

export async function persistInitialUserMessage(input: {
  runId: string;
  text: string;
}): Promise<void> {
  await db.insert(runMessages).values({
    id: nanoid(),
    runId: input.runId,
    role: "user",
    // Match the rich `parts` shape the assistant rows use so the
    // viewer can render either with one code path.
    parts: [{ type: "text", text: input.text }],
  });
}

export async function persistRunStep(input: {
  runId: string;
  userId: string | null;
  step: StepLikeForPersistence;
  triggerSource: string;
}): Promise<void> {
  // One assistant row per step, carrying the rich `content` array
  // (text + reasoning + tool-call parts) verbatim. Downstream UI can
  // walk `parts` to render whichever part types it knows about.
  await db.insert(runMessages).values({
    id: nanoid(),
    runId: input.runId,
    role: "assistant",
    parts: input.step.content ?? [],
  });

  // Tool-result rows are pulled out of `step.toolResults` (if
  // present) and matched to the corresponding tool_call by id. The
  // result lands as an additional `role=tool` run_message so the UI
  // can interleave it next to the call that produced it.
  const resultsByCallId = new Map<string, unknown>();
  for (const tr of input.step.toolResults ?? []) {
    if (tr.toolCallId) resultsByCallId.set(tr.toolCallId, tr.output);
  }

  for (const tc of input.step.toolCalls ?? []) {
    await db.insert(runToolCalls).values({
      id: nanoid(),
      runId: input.runId,
      toolKind: classifyTool(tc.toolName),
      toolName: tc.toolName,
      input: (tc.input as object | null) ?? null,
      output:
        (resultsByCallId.get(tc.toolCallId ?? "") as object | null) ?? null,
      // `success` is left null until tool execution is bound to a
      // result; the `ai` SDK doesn't expose success/failure on the
      // step shape directly. The presence/absence of `output` is the
      // signal callers use today.
      success: null,
      costUsdMicros: 0,
      latencyMs: null,
    });
  }

  // Usage event ties to the human owner so per-user cost rollups
  // work. Linear-triggered runs always have a humanOwnerId by the
  // time the planner runs (resolved in the webhook handler); skip
  // the row entirely if it's somehow null rather than synthesize a
  // fake user_id that would violate the FK.
  if (input.userId) {
    await db.insert(usageEvents).values({
      id: nanoid(),
      userId: input.userId,
      source: input.triggerSource,
      agentType: "specialist",
      provider: input.step.model?.provider ?? null,
      modelId: input.step.model?.modelId ?? null,
      inputTokens: input.step.usage?.inputTokens ?? 0,
      cachedInputTokens:
        input.step.usage?.inputTokenDetails?.cacheReadTokens ?? 0,
      outputTokens: input.step.usage?.outputTokens ?? 0,
      toolCallCount: input.step.toolCalls?.length ?? 0,
    });
  }
}
