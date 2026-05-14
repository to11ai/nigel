import { describe, expect, mock, test } from "bun:test";
import type { z } from "zod";

mock.module("ai", () => ({
  tool: <T extends Record<string, unknown>>(definition: T) => definition,
}));

const { dispatchSpecialistsParallelTool } = await import(
  "./dispatch-specialists-parallel"
);

// The AI SDK `tool()` factory hides the zod schema behind `FlexibleSchema`
// at the type level. The test-time mock above returns the definition
// verbatim, so at runtime `inputSchema` is the actual zod schema —
// `safeParse` exists and works. The cast just bridges the static gap.
const schema = dispatchSpecialistsParallelTool.inputSchema as unknown as z.ZodTypeAny;

function executionOptions(experimental_context?: unknown) {
  return {
    toolCallId: "tool-call-1",
    messages: [],
    experimental_context,
  };
}

describe("dispatchSpecialistsParallelTool", () => {
  test("schema rejects empty dispatches array", () => {
    const result = schema.safeParse({
      dispatches: [],
    });
    expect(result.success).toBe(false);
  });

  test("schema accepts a non-empty dispatches array", () => {
    const result = schema.safeParse({
      dispatches: [{ specialist_name: "coder", task: "do a thing" }],
    });
    expect(result.success).toBe(true);
  });

  test("schema rejects negative budget_usd_micros", () => {
    const result = schema.safeParse({
      dispatches: [
        {
          specialist_name: "coder",
          task: "do a thing",
          budget_usd_micros: -1,
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  test("schema rejects zero budget_usd_micros (positive required)", () => {
    const result = schema.safeParse({
      dispatches: [
        {
          specialist_name: "coder",
          task: "do a thing",
          budget_usd_micros: 0,
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  test("schema rejects non-integer budget_usd_micros", () => {
    const result = schema.safeParse({
      dispatches: [
        {
          specialist_name: "coder",
          task: "do a thing",
          budget_usd_micros: 1.5,
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  test("callback is invoked exactly once with the full array (snake_case → camelCase)", async () => {
    let callCount = 0;
    let lastInput:
      | {
          dispatches: Array<{
            specialistName: string;
            task: string;
            budgetUsdMicros?: number;
            sandboxPolicyOverride?: "inherit" | "fresh" | "fresh_clean";
          }>;
        }
      | undefined;

    const callback = async (input: {
      dispatches: Array<{
        specialistName: string;
        task: string;
        budgetUsdMicros?: number;
        sandboxPolicyOverride?: "inherit" | "fresh" | "fresh_clean";
      }>;
    }) => {
      callCount += 1;
      lastInput = input;
      return {
        results: input.dispatches.map((d) => ({
          specialistName: d.specialistName,
          output: `output-for-${d.specialistName}`,
        })),
      };
    };

    const result = await dispatchSpecialistsParallelTool.execute?.(
      {
        dispatches: [
          {
            specialist_name: "coder",
            task: "fix the bug",
            budget_usd_micros: 2_000_000,
          },
          {
            specialist_name: "linter",
            task: "lint the change",
            sandbox_policy_override: "fresh",
          },
        ],
      },
      executionOptions({ dispatchSpecialistsParallel: callback }),
    );

    expect(callCount).toBe(1);
    expect(lastInput).toEqual({
      dispatches: [
        {
          specialistName: "coder",
          task: "fix the bug",
          budgetUsdMicros: 2_000_000,
        },
        {
          specialistName: "linter",
          task: "lint the change",
          sandboxPolicyOverride: "fresh",
        },
      ],
    });
    expect(result).toEqual({
      success: true,
      results: [
        { specialist: "coder", output: "output-for-coder" },
        { specialist: "linter", output: "output-for-linter" },
      ],
    });
  });

  test("missing callback in experimental_context returns success:false with wired error", async () => {
    const result = await dispatchSpecialistsParallelTool.execute?.(
      {
        dispatches: [{ specialist_name: "coder", task: "do a thing" }],
      },
      executionOptions({}),
    );

    expect(result).toEqual({
      success: false,
      error:
        "dispatch_specialists_parallel tool not wired: no callback in experimental_context. This is a runtime configuration bug, not something the agent can fix.",
    });
  });

  test("undefined experimental_context returns success:false with wired error", async () => {
    const result = await dispatchSpecialistsParallelTool.execute?.(
      {
        dispatches: [{ specialist_name: "coder", task: "do a thing" }],
      },
      executionOptions(undefined),
    );

    expect(result).toEqual({
      success: false,
      error:
        "dispatch_specialists_parallel tool not wired: no callback in experimental_context. This is a runtime configuration bug, not something the agent can fix.",
    });
  });

  test("per-child error flows through to results[i].error", async () => {
    const callback = async () => ({
      results: [
        { specialistName: "coder", output: "done" },
        {
          specialistName: "linter",
          output: "",
          error: "sandbox provisioning failed",
        },
        { specialistName: "reviewer", output: "approved" },
      ],
    });

    const result = await dispatchSpecialistsParallelTool.execute?.(
      {
        dispatches: [
          { specialist_name: "coder", task: "code" },
          { specialist_name: "linter", task: "lint" },
          { specialist_name: "reviewer", task: "review" },
        ],
      },
      executionOptions({ dispatchSpecialistsParallel: callback }),
    );

    expect(result).toEqual({
      success: true,
      results: [
        { specialist: "coder", output: "done" },
        {
          specialist: "linter",
          output: "",
          error: "sandbox provisioning failed",
        },
        { specialist: "reviewer", output: "approved" },
      ],
    });
  });

  test("thrown callback error maps to success:false with err.message", async () => {
    const callback = async () => {
      throw new Error("max_children_exceeded");
    };

    const result = await dispatchSpecialistsParallelTool.execute?.(
      {
        dispatches: [{ specialist_name: "coder", task: "code" }],
      },
      executionOptions({ dispatchSpecialistsParallel: callback }),
    );

    expect(result).toEqual({
      success: false,
      error: "max_children_exceeded",
    });
  });
});
