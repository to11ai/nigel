import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { ResolvedSpecialist } from "@/lib/specialists";
import type { AgentRun } from "./types";

type CapturedSettings = {
  tools: Record<string, unknown>;
  experimental_context: { sandbox: unknown; model: unknown };
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
  },
}));

const { executeSpecialistViaLLM } = await import("./specialist-execution");

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
  model: "anthropic/claude-sonnet-4-6",
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
});
