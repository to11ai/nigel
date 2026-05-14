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
  // Each insert is isolated: a transient failure on one (e.g. a
  // large tool-call batch hitting a postgres parameter limit) must
  // NOT cause the other two — which are independent rows — to be
  // silently dropped. Without per-write isolation, one bad tool
  // call would forfeit the per-step usage_events row this PR
  // exists to record.
  //
  // The CALLER also wraps persistRunStep in try/catch (see
  // specialist-execution.ts onStepFinish) as a defense-in-depth
  // safety net for unexpected throws — but that outer catch is
  // single-shot, so it can't recover the other branches once one
  // throws. Hence the inner isolation here.
  // Run the three independent inserts in parallel. Each already
  // has its own .catch — Promise.all preserves the same per-write
  // isolation while collapsing three sequential round-trips into
  // one. This callback blocks the agent loop's step boundary so
  // the latency win compounds across the run (MAX_STEPS=50).
  await Promise.all([
    persistAssistantMessage(input).catch((err) => {
      console.error(
        `[run-persistence] runMessages insert failed for run ${input.runId}`,
        err,
      );
    }),
    persistToolCalls(input).catch((err) => {
      console.error(
        `[run-persistence] runToolCalls insert failed for run ${input.runId}`,
        err,
      );
    }),
    persistUsageEvent(input).catch((err) => {
      console.error(
        `[run-persistence] usageEvents insert failed for run ${input.runId}`,
        err,
      );
    }),
  ]);
}

async function persistAssistantMessage(input: {
  runId: string;
  step: StepLikeForPersistence;
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
}

async function persistToolCalls(input: {
  runId: string;
  step: StepLikeForPersistence;
}): Promise<void> {
  // Tool results from `step.toolResults` are matched to the
  // corresponding tool call by id and stored directly on the
  // `run_tool_calls` row's `output` column — no separate
  // role=tool message row. The UI joins input + output in one
  // entry without a second query.
  const resultsByCallId = new Map<string, unknown>();
  for (const tr of input.step.toolResults ?? []) {
    if (tr.toolCallId) resultsByCallId.set(tr.toolCallId, tr.output);
  }

  // Batch into a single INSERT — sequential awaits inside a for
  // loop would issue one round-trip per tool call and add
  // noticeable latency on busy steps. Drizzle's multi-row values()
  // overload sends everything in one statement.
  const toolCallRows = (input.step.toolCalls ?? []).map((tc) => ({
    id: nanoid(),
    runId: input.runId,
    toolKind: classifyTool(tc.toolName),
    toolName: tc.toolName,
    input: (tc.input as object | null) ?? null,
    output: (resultsByCallId.get(tc.toolCallId ?? "") as object | null) ?? null,
    // `success` left null until tool execution is bound to a
    // result; the `ai` SDK doesn't expose success/failure on the
    // step shape directly. The presence/absence of `output` is
    // the signal callers use today.
    success: null,
    costUsdMicros: 0,
    latencyMs: null,
  }));
  if (toolCallRows.length > 0) {
    await db.insert(runToolCalls).values(toolCallRows);
  }
}

async function persistUsageEvent(input: {
  runId: string;
  userId: string | null;
  step: StepLikeForPersistence;
  triggerSource: string;
}): Promise<void> {
  // Usage event ties to the human owner so per-user cost rollups
  // work. Linear-triggered runs always have a humanOwnerId by the
  // time the planner runs (resolved in the webhook handler); skip
  // the row entirely if it's somehow null rather than synthesize a
  // fake user_id that would violate the FK.
  if (!input.userId) return;
  // `triggerSource` is a TriggerSource ("chat" | "linear" | ...) but
  // `usage_events.source` is a UsageSource ("web" | "linear" | ...).
  // The two domains diverge on the chat path — TriggerSource calls
  // it "chat", UsageSource (and the legacy chat-post-finish writer)
  // call it "web". Map at the persistence boundary so chat-triggered
  // specialist runs (if/when they flow through here) land in the
  // same bucket as the chat-post-finish rows instead of fragmenting
  // reporting across two labels for the same concept.
  const source = input.triggerSource === "chat" ? "web" : input.triggerSource;
  await db.insert(usageEvents).values({
    id: nanoid(),
    userId: input.userId,
    source,
    // `agentType: "specialist"` distinguishes per-step specialist
    // writes from chat's per-turn `recordUsage` write. The chat
    // path writes once per chat turn; we write once per LLM step
    // via onStepFinish. Reusing "main" would inflate
    // getUsageHistory.messageCount (which counts rows where
    // agentType='main') by ~N-per-run for Linear-triggered runs,
    // breaking any "interactions" proxy built on messageCount.
    // The usage UI's pie chart now recognizes "specialist" as a
    // first-class segment alongside main/subagents (see
    // app/settings/usage-section.tsx) so tokens stay visible
    // without contaminating the message-count signal.
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
