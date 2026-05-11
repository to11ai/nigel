import { tool } from "ai";
import { z } from "zod";

// Callback supplied via experimental_context by the dispatching layer
// (apps/web's specialist-execution wrapper). The agent package itself
// has no notion of Nigel's specialist registry or dispatch path; the
// caller wires the actual implementation in at runtime so this tool
// can stay package-local.
//
// The callback receives only what the LLM specialist itself can supply
// (target name, task, optional overrides); parent run id, root run id,
// sandbox state, and the human owner are curried in by the wrapper
// before the callback reaches the tool.
export type DispatchSpecialistCallback = (input: {
  specialistName: string;
  task: string;
  budgetUsdMicros?: number;
  sandboxPolicyOverride?: "inherit" | "fresh" | "fresh_clean";
}) => Promise<{ output: string }>;

interface DispatchSpecialistContext {
  dispatchSpecialist?: DispatchSpecialistCallback;
}

const dispatchSpecialistInputSchema = z.object({
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
});

export const dispatchSpecialistTool = tool({
  description: `Dispatch a Nigel specialist to handle a sub-task.

Use this when the task naturally decomposes into work that another specialist is better suited for — e.g., calling \`coder\` to make a code change, then \`linter\` to fix lint failures, then \`reviewer\` to audit the result.

The dispatched specialist runs as a child of your current run and returns its final text output. You receive that output and can use it as input to your next step.

Important:
- Each child run starts fresh; the specialist does NOT see your conversation. Make the \`task\` self-contained.
- The dispatched run's cost rolls up to the root budget. If the root budget is exhausted, the dispatch will throw.
- You can only dispatch specialists if your own specialist preset has \`may_recurse: true\`. If you receive an "may_recurse=false" error, that's a preset constraint, not a runtime bug.`,
  inputSchema: dispatchSpecialistInputSchema,
  execute: async (
    { specialist_name, task, budget_usd_micros, sandbox_policy_override },
    { experimental_context },
  ) => {
    const context = experimental_context as
      | DispatchSpecialistContext
      | undefined;
    const dispatchSpecialist = context?.dispatchSpecialist;
    if (!dispatchSpecialist) {
      return {
        success: false,
        error:
          "dispatch_specialist tool not wired: no callback in experimental_context. This is a runtime configuration bug, not something the agent can fix.",
      };
    }
    try {
      const result = await dispatchSpecialist({
        specialistName: specialist_name,
        task,
        ...(budget_usd_micros !== undefined
          ? { budgetUsdMicros: budget_usd_micros }
          : {}),
        ...(sandbox_policy_override !== undefined
          ? { sandboxPolicyOverride: sandbox_policy_override }
          : {}),
      });
      return {
        success: true,
        specialist: specialist_name,
        output: result.output,
      };
    } catch (err) {
      return {
        success: false,
        specialist: specialist_name,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
});

export type DispatchSpecialistInput = z.infer<
  typeof dispatchSpecialistInputSchema
>;
