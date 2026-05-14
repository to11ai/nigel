import { beforeEach, describe, expect, mock, test } from "bun:test";
import type {
  DispatchSpecialistCallback,
  DispatchSpecialistsParallelCallback,
  LinearAgentToolCallback,
} from "@nigel/agent";
import type { ResolvedSpecialist } from "@/lib/specialists";
import type { AgentRun } from "./types";

type CapturedSettings = {
  tools: Record<string, unknown>;
  experimental_context: {
    sandbox: unknown;
    model: unknown;
    dispatchSpecialist: DispatchSpecialistCallback;
    dispatchSpecialistsParallel?: DispatchSpecialistsParallelCallback;
    linear?: LinearAgentToolCallback;
  };
  prepareStep: (args: unknown) => Promise<unknown>;
  onStepFinish: (step: unknown) => Promise<unknown>;
};

const generateMock = mock(async () => ({
  text: "stub output",
  usage: { inputTokens: 100, outputTokens: 50, inputTokenDetails: {} },
  finishReason: "stop" as const,
}));

let lastConstructorSettings: CapturedSettings | null = null;

// Mock the AI SDK so we can drive ToolLoopAgent's lifecycle deterministically
// without hitting the AI Gateway. Mocking `ai` and `@nigel/agent` is fine —
// neither has cross-test side effects we care about here.
mock.module("ai", () => ({
  ToolLoopAgent: class {
    constructor(settings: CapturedSettings) {
      lastConstructorSettings = settings;
    }
    async generate() {
      return generateMock();
    }
  },
  stepCountIs: (n: number) => ({ kind: "stepCountIs", n }),
}));

mock.module("@nigel/agent", () => ({
  gateway: (id: string) => ({ id, _kind: "model" }),
  nigelTools: {
    read: { _kind: "tool" },
    write: { _kind: "tool" },
    edit: { _kind: "tool" },
    grep: { _kind: "tool" },
    glob: { _kind: "tool" },
    bash: { _kind: "tool" },
    task: { _kind: "tool" },
    web_fetch: { _kind: "tool" },
    dispatch_specialist: { _kind: "tool" },
    dispatch_specialists_parallel: { _kind: "tool" },
    linear_get_issue: { _kind: "tool" },
    linear_comment: { _kind: "tool" },
    linear_attach: { _kind: "tool" },
  },
}));

const { executeSpecialistViaLLM, shouldForwardInheritedSandbox } =
  await import("./specialist-execution");

// Stubs for the budget/repository functions are passed via the injection
// seam on ExecuteSpecialistInput.deps rather than mocked at the module
// boundary, because bun:test's mock.module leaks across files within the
// same `bun test` run and would break the real cost-rollup tests in
// cost.test.ts and integration.test.ts.
const checkRootBudgetStub = mock(async (_id: string) => undefined);
const addCostMicrosStub = mock(
  async (_id: string, _delta: number) => undefined,
);

beforeEach(() => {
  generateMock.mockClear();
  checkRootBudgetStub.mockClear();
  addCostMicrosStub.mockClear();
  lastConstructorSettings = null;
});

const fakeRun = (overrides: Partial<AgentRun> = {}): AgentRun =>
  ({
    id: "run_abc",
    rootRunId: "run_root",
    parentRunId: null,
    depth: 0,
    triggerSource: "chat",
    triggerRef: null,
    specialistId: "coder",
    sandboxPolicy: "inherit",
    humanOwnerId: "user_1",
    repoRef: null,
    workflowRunId: null,
    chatId: null,
    status: "running",
    blockedReason: null,
    budgetUsdCapMicros: 5_000_000,
    costUsdActualMicros: 0,
    startedAt: new Date(),
    endedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    sandboxState: null,
    ...overrides,
  }) as AgentRun;

const fakeSpecialist = (
  overrides: Partial<ResolvedSpecialist> = {},
): ResolvedSpecialist => ({
  name: "coder",
  kind: "preset",
  systemPrompt: "You are coder.",
  model: "anthropic/claude-sonnet-4.6",
  toolAllowlist: ["file", "search", "shell", "git"],
  sandboxPolicy: "inherit",
  mayRecurse: false,
  maxChildren: 0,
  budgetUsdDefaultMicros: 5_000_000,
  needsLocalStack: false,
  ...overrides,
});

const fakeSandbox = () => ({
  state: { type: "vercel" as const },
  workingDirectory: "/work",
});

function call(
  overrides: {
    run?: Partial<AgentRun>;
    specialist?: Partial<ResolvedSpecialist>;
    task?: string;
    dispatchSpecialist?: DispatchSpecialistCallback;
    dispatchSpecialistsParallel?: DispatchSpecialistsParallelCallback;
    linear?: LinearAgentToolCallback;
    buildLinearForRun?: (input: {
      runId: string;
      orgId: string;
    }) => LinearAgentToolCallback;
  } = {},
) {
  return executeSpecialistViaLLM({
    run: fakeRun(overrides.run),
    sandbox: fakeSandbox(),
    specialist: fakeSpecialist(overrides.specialist),
    task: overrides.task ?? "x",
    deps: {
      checkRootBudget: checkRootBudgetStub,
      addCostMicros: addCostMicrosStub,
      ...(overrides.dispatchSpecialist
        ? { dispatchSpecialist: overrides.dispatchSpecialist }
        : {}),
      ...(overrides.dispatchSpecialistsParallel
        ? {
            dispatchSpecialistsParallel: overrides.dispatchSpecialistsParallel,
          }
        : {}),
      ...(overrides.linear ? { linear: overrides.linear } : {}),
      ...(overrides.buildLinearForRun
        ? { buildLinearForRun: overrides.buildLinearForRun }
        : {}),
    },
  });
}

function captured(): CapturedSettings {
  if (!lastConstructorSettings) {
    throw new Error("ToolLoopAgent constructor was not called");
  }
  return lastConstructorSettings;
}

describe("executeSpecialistViaLLM", () => {
  test("returns the agent's final text", async () => {
    const result = await call({ task: "do the thing" });
    expect(result.output).toBe("stub output");
  });

  test("filters tools by specialist allowlist (search => grep+glob)", async () => {
    await call({ specialist: { toolAllowlist: ["search"] } });
    expect(Object.keys(captured().tools).sort()).toEqual(["glob", "grep"]);
  });

  test("coder allowlist [file, search, shell, git] => 6 tools", async () => {
    await call();
    expect(Object.keys(captured().tools).sort()).toEqual([
      "bash",
      "edit",
      "glob",
      "grep",
      "read",
      "write",
    ]);
  });

  test("throws if specialist is missing systemPrompt", async () => {
    await expect(call({ specialist: { systemPrompt: null } })).rejects.toThrow(
      /missing systemPrompt or model/,
    );
  });

  test("throws if specialist is missing model", async () => {
    await expect(call({ specialist: { model: null } })).rejects.toThrow(
      /missing systemPrompt or model/,
    );
  });

  test("prepareStep calls checkRootBudget with rootRunId", async () => {
    await call();
    await captured().prepareStep({});
    expect(checkRootBudgetStub).toHaveBeenCalledWith("run_root");
  });

  test("onStepFinish records gateway cost in micros", async () => {
    await call();
    await captured().onStepFinish({
      providerMetadata: { gateway: { cost: "0.0042" } },
      usage: { inputTokens: 100, outputTokens: 50, inputTokenDetails: {} },
    });
    expect(addCostMicrosStub).toHaveBeenCalledWith("run_abc", 4200);
  });

  test("onStepFinish falls back to PRICING when gateway cost absent", async () => {
    await call();
    // No gateway metadata, but token usage provided. PRICING for sonnet-4-6
    // is $3/M input, $15/M output. 100 in @ $3/M = 300 micros; 50 out @
    // $15/M = 750 micros; total = 1050.
    await captured().onStepFinish({
      providerMetadata: undefined,
      usage: { inputTokens: 100, outputTokens: 50, inputTokenDetails: {} },
    });
    expect(addCostMicrosStub).toHaveBeenCalledWith("run_abc", 1050);
  });

  test("onStepFinish does not throw when addCostMicros fails (gateway path)", async () => {
    addCostMicrosStub.mockImplementationOnce(async () => {
      throw new Error("DB transient failure");
    });
    await call();
    // The hook itself must not throw — onStepFinish failures crash the agent.
    await expect(
      captured().onStepFinish({
        providerMetadata: { gateway: { cost: "0.0042" } },
        usage: { inputTokens: 100, outputTokens: 50, inputTokenDetails: {} },
      }),
    ).resolves.toBeUndefined();
  });

  test("onStepFinish does not throw when addCostMicros fails (fallback path)", async () => {
    addCostMicrosStub.mockImplementationOnce(async () => {
      throw new Error("DB transient failure");
    });
    await call();
    await expect(
      captured().onStepFinish({
        providerMetadata: undefined,
        usage: { inputTokens: 100, outputTokens: 50, inputTokenDetails: {} },
      }),
    ).resolves.toBeUndefined();
  });

  test("onStepFinish silently skips cost when both gateway and tokens absent", async () => {
    await call();
    await captured().onStepFinish({
      providerMetadata: undefined,
      usage: { inputTokenDetails: {} },
    });
    expect(addCostMicrosStub).not.toHaveBeenCalled();
  });

  test("experimental_context carries sandbox + model so tools can find them", async () => {
    await call();
    expect(captured().experimental_context.sandbox).toBeTruthy();
    expect(captured().experimental_context.model).toBeTruthy();
  });

  test("experimental_context carries dispatchSpecialist callback", async () => {
    await call();
    expect(typeof captured().experimental_context.dispatchSpecialist).toBe(
      "function",
    );
  });

  test("planner allowlist surfaces dispatch_specialist alongside file/search/shell/git/web", async () => {
    await call({
      specialist: {
        toolAllowlist: [
          "file",
          "search",
          "shell",
          "git",
          "web",
          "dispatch_specialist",
        ],
      },
    });
    expect(Object.keys(captured().tools).sort()).toEqual([
      "bash",
      "dispatch_specialist",
      "edit",
      "glob",
      "grep",
      "read",
      "web_fetch",
      "write",
    ]);
  });
});

describe("shouldForwardInheritedSandbox", () => {
  const state = { type: "vercel" as const, sandboxId: "s1", expiresAt: 1 };

  test("returns false when there is no parent sandbox state", () => {
    expect(shouldForwardInheritedSandbox(null, undefined)).toBe(false);
    expect(shouldForwardInheritedSandbox(undefined, "inherit")).toBe(false);
    expect(shouldForwardInheritedSandbox(null, "fresh")).toBe(false);
  });

  test("forwards inheritance when override is omitted (specialist preset wins)", () => {
    expect(shouldForwardInheritedSandbox(state, undefined)).toBe(true);
  });

  test("forwards inheritance when override is explicitly 'inherit'", () => {
    expect(shouldForwardInheritedSandbox(state, "inherit")).toBe(true);
  });

  test("withholds inheritance when override is 'fresh'", () => {
    expect(shouldForwardInheritedSandbox(state, "fresh")).toBe(false);
  });

  test("withholds inheritance when override is 'fresh_clean'", () => {
    expect(shouldForwardInheritedSandbox(state, "fresh_clean")).toBe(false);
  });
});

describe("dispatchSpecialist callback wiring", () => {
  test("injected dispatchSpecialist callback is used when provided in deps", async () => {
    const dispatchStub = mock(async (input: { task: string }) => ({
      output: `dispatched: ${input.task}`,
    }));
    await call({ dispatchSpecialist: dispatchStub });
    const cb = captured().experimental_context.dispatchSpecialist;
    const result = await cb({
      specialistName: "coder",
      task: "make a fix",
    });
    expect(result.output).toBe("dispatched: make a fix");
    expect(dispatchStub).toHaveBeenCalledTimes(1);
  });
});

describe("dispatch_specialists_parallel callback gating", () => {
  test("callback is ABSENT from experimental_context when allowlist omits the category", async () => {
    await call({
      specialist: { toolAllowlist: ["file", "search", "dispatch_specialist"] },
    });
    expect(
      captured().experimental_context.dispatchSpecialistsParallel,
    ).toBeUndefined();
  });

  test("callback is PRESENT when allowlist includes the category", async () => {
    const parallelStub = mock(
      async (_: {
        dispatches: Array<{ specialistName: string; task: string }>;
      }) => ({
        results: [
          { specialistName: "linter", output: "ok" },
          { specialistName: "type-checker", output: "ok" },
        ],
      }),
    );
    await call({
      specialist: {
        toolAllowlist: [
          "file_read",
          "search",
          "dispatch_specialist",
          "dispatch_specialists_parallel",
        ],
      },
      dispatchSpecialistsParallel: parallelStub,
    });
    const cb = captured().experimental_context.dispatchSpecialistsParallel;
    expect(cb).toBeDefined();
    const result = await cb!({
      dispatches: [
        { specialistName: "linter", task: "lint" },
        { specialistName: "type-checker", task: "tc" },
      ],
    });
    expect(result.results.map((r) => r.specialistName)).toEqual([
      "linter",
      "type-checker",
    ]);
    expect(parallelStub).toHaveBeenCalledTimes(1);
  });

  test("forwards inheritSandboxState PER CHILD based on each dispatch's sandboxPolicyOverride", async () => {
    let receivedInputs: Array<{
      specialistName: string;
      inheritSandboxState?: unknown;
      sandboxPolicyOverride?: string;
    }> | null = null;
    const parallelStub = mock(
      async (_input: {
        dispatches: Array<{
          specialistName: string;
          task: string;
          sandboxPolicyOverride?: "inherit" | "fresh" | "fresh_clean";
        }>;
      }) => ({
        results: _input.dispatches.map((d) => ({
          specialistName: d.specialistName,
          output: "ok",
        })),
      }),
    );

    // Inject a custom dispatchSpecialistsParallel so we can capture
    // the DispatchSpecialistInput[] that the wiring computes. We
    // simulate the real server-side function's signature shape.
    await call({
      specialist: {
        toolAllowlist: [
          "file_read",
          "dispatch_specialist",
          "dispatch_specialists_parallel",
        ],
      },
      // Override the parallel callback to peek at the snake_case input
      // BEFORE it reaches the server. The wiring should map each
      // dispatch into a row that carries (or omits) inheritSandboxState
      // based on the per-child override.
      dispatchSpecialistsParallel: async (input) => {
        receivedInputs = input.dispatches.map((d) => ({
          specialistName: d.specialistName,
          sandboxPolicyOverride: d.sandboxPolicyOverride,
        }));
        return parallelStub(input);
      },
    });
    const cb = captured().experimental_context.dispatchSpecialistsParallel;
    expect(cb).toBeDefined();

    // Three dispatches: fresh, inherit (default), fresh_clean.
    await cb!({
      dispatches: [
        {
          specialistName: "coder-fresh",
          task: "t1",
          sandboxPolicyOverride: "fresh",
        },
        { specialistName: "coder-default", task: "t2" },
        {
          specialistName: "coder-clean",
          task: "t3",
          sandboxPolicyOverride: "fresh_clean",
        },
      ],
    });

    // The callback fired and the override fields are passed through
    // verbatim. (The server-side dispatchSpecialistsParallel is the
    // unit that finally evaluates `shouldForwardInheritedSandbox`
    // and passes `inheritSandboxState`; the wiring just funnels the
    // per-child override down.) The contract being tested here is:
    //   - The wiring calls the parallel callback exactly once
    //   - Each per-child override survives the camelCase mapping
    if (receivedInputs === null) {
      throw new Error("dispatchSpecialistsParallel callback was not invoked");
    }
    expect(receivedInputs as Array<unknown>).toEqual([
      { specialistName: "coder-fresh", sandboxPolicyOverride: "fresh" },
      { specialistName: "coder-default", sandboxPolicyOverride: undefined },
      { specialistName: "coder-clean", sandboxPolicyOverride: "fresh_clean" },
    ]);
  });
});

describe("linear callback gating", () => {
  test("callback is ABSENT when allowlist omits 'linear'", async () => {
    await call({
      specialist: { toolAllowlist: ["file", "search"] },
    });
    expect(captured().experimental_context.linear).toBeUndefined();
  });

  test("callback is PRESENT when allowlist includes 'linear'", async () => {
    const linearStub: LinearAgentToolCallback = {
      getIssue: mock(async () => ({
        id: "uuid-1",
        identifier: "LIN-1",
        title: "t",
        description: null,
        statusName: "Todo",
        assigneeName: null,
        teamKey: "LIN",
        url: "https://linear.app/x/issue/LIN-1",
      })),
      comment: mock(async () => ({
        commentId: "c1",
        url: "https://linear.app/x/issue/LIN-1#comment-c1",
      })),
      attach: mock(async () => ({ attachmentId: "a1" })),
    };
    await call({
      specialist: {
        toolAllowlist: [
          "file_read",
          "search",
          "web",
          "dispatch_specialist",
          "dispatch_specialists_parallel",
          "linear",
        ],
      },
      linear: linearStub,
    });
    const cb = captured().experimental_context.linear;
    expect(cb).toBeDefined();
    expect(cb).toBe(linearStub);
  });

  test("default `buildLinearForRun` is invoked exactly once with the run's id when allowlist includes 'linear'", async () => {
    const builtCallback: LinearAgentToolCallback = {
      getIssue: mock(async () => ({ kind: "not_configured" as const })),
      comment: mock(async () => ({ kind: "not_configured" as const })),
      attach: mock(async () => ({ kind: "not_configured" as const })),
    };
    const buildStub = mock(
      (_input: { runId: string; orgId: string }) => builtCallback,
    );
    await call({
      run: { id: "run_planner", humanOwnerId: "user_42" },
      specialist: {
        name: "planner",
        toolAllowlist: ["file_read", "search", "linear"],
      },
      buildLinearForRun: buildStub,
    });
    expect(buildStub).toHaveBeenCalledTimes(1);
    expect(buildStub).toHaveBeenCalledWith({
      runId: "run_planner",
      orgId: "user_42",
    });
    expect(captured().experimental_context.linear).toBe(builtCallback);
  });
});
