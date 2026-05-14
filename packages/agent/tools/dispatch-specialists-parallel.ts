import { tool } from "ai";
import { z } from "zod";

// Parallel sibling of `dispatch-specialist.ts`. Same callback-via-
// `experimental_context` pattern: the agent package itself has no
// notion of Nigel's specialist registry or dispatch path, and the
// caller (apps/web's specialist-execution wrapper) curries the
// parent/root run ids, sandbox state, and human-owner identity in
// before the callback ever reaches the tool.
//
// The callback receives the full array of dispatches at once so the
// server-side reservation primitive can lock root + parent rows and
// reserve N child slots + sum-of-budgets in a single transaction. A
// caller that needed per-child dispatch would not be using this tool.
//
// `results[i].error` carries per-child failures; the entire batch is
// only rejected when the atomic pre-flight fails (e.g.,
// `max_children_exceeded` or `budget_exhausted_at_reservation`).
export type DispatchSpecialistsParallelCallback = (input: {
  dispatches: Array<{
    specialistName: string;
    task: string;
    budgetUsdMicros?: number;
    sandboxPolicyOverride?: "inherit" | "fresh" | "fresh_clean";
  }>;
}) => Promise<{
  results: Array<{
    specialistName: string;
    output: string;
    error?: string;
  }>;
}>;

interface DispatchSpecialistsParallelContext {
  dispatchSpecialistsParallel?: DispatchSpecialistsParallelCallback;
}

const dispatchSpecialistsParallelInputSchema = z.object({
  dispatches: z
    .array(
      z.object({
        specialist_name: z
          .string()
          .describe(
            "Name of the specialist to dispatch (e.g. 'coder', 'linter', 'reviewer'). Must be in the available roster.",
          ),
        task: z
          .string()
          .describe(
            "Task description handed to the dispatched specialist. Should be self-contained — the specialist starts a fresh run without access to your current conversation.",
          ),
        budget_usd_micros: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Optional override of the dispatched specialist's default per-run budget (in micro-USD; 1_000_000 = $1). Omit to use the specialist's preset default.",
          ),
        sandbox_policy_override: z
          .enum(["inherit", "fresh", "fresh_clean"])
          .optional()
          .describe(
            "Optional override of the dispatched specialist's sandbox policy. Omit to use the specialist's preset default.",
          ),
      }),
    )
    .min(1)
    .describe(
      "Array of independent specialist dispatches to run in parallel. Must contain at least one entry — for a single dispatch, call `dispatch_specialist` directly instead of paying the parallel-path overhead.",
    ),
});

export const dispatchSpecialistsParallelTool = tool({
  description: `Dispatch multiple Nigel specialists in parallel to handle independent sub-tasks.

Use this when sub-tasks are independent (no shared state, no sequential dependency). Sequential follow-ups belong in your own tool loop — call \`dispatch_specialist\` once per step and read each output before deciding the next.

Wall-clock duration is roughly \`max(child_durations)\`. Cost is \`sum(child_costs)\` and is bounded by the root budget — if the sum-of-requested-budgets exceeds remaining root budget at dispatch time, the entire batch is rejected and no children spawn.

One child failure does not abort siblings. Each result has either \`output\` or \`error\`; you decide what to do with partial success.`,
  inputSchema: dispatchSpecialistsParallelInputSchema,
  execute: async ({ dispatches }, { experimental_context }) => {
    const context = experimental_context as
      | DispatchSpecialistsParallelContext
      | undefined;
    const dispatchSpecialistsParallel = context?.dispatchSpecialistsParallel;
    if (!dispatchSpecialistsParallel) {
      return {
        success: false,
        error:
          "dispatch_specialists_parallel tool not wired: no callback in experimental_context. This is a runtime configuration bug, not something the agent can fix.",
      };
    }
    try {
      const result = await dispatchSpecialistsParallel({
        dispatches: dispatches.map((d) => ({
          specialistName: d.specialist_name,
          task: d.task,
          ...(d.budget_usd_micros !== undefined
            ? { budgetUsdMicros: d.budget_usd_micros }
            : {}),
          ...(d.sandbox_policy_override !== undefined
            ? { sandboxPolicyOverride: d.sandbox_policy_override }
            : {}),
        })),
      });
      return {
        success: true,
        results: result.results.map((r) => ({
          specialist: r.specialistName,
          output: r.output,
          ...(r.error !== undefined ? { error: r.error } : {}),
        })),
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
});

export type DispatchSpecialistsParallelInput = z.infer<
  typeof dispatchSpecialistsParallelInputSchema
>;
