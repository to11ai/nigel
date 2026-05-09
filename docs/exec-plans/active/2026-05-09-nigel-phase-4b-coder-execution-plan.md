# Nigel Phase 4b — `coder` LLM Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the actual `coder` specialist on top of the Phase 4a scaffolding (allowlist + race-fix + sandbox-coordinator). Replace the "Phase 4 wires LLM-based specialists" throw in `dispatchSpecialist` with a real execution path: provision a sandbox, construct a per-specialist `ToolLoopAgent` with the filtered tool set, run it with pre-step budget checks and per-step cost capture, return the final text.

**Architecture:** New module `apps/web/lib/runs/specialist-execution.ts` constructs a fresh `ToolLoopAgent` per dispatch (avoids stomping on the existing shared `webAgent` used by the chat path). The Vercel AI Gateway returns cost directly via `providerMetadata.gateway.cost` (in USD as a string) — the existing `extractGatewayCost` helper already parses it. Convert to micros via `Math.round(cost * 1_000_000)` and feed `addCostMicros(run.id, micros)` from the existing repository module. No new pricing logic needed; `lib/runs/cost.ts` (which I almost duplicated in Phase 4a) is only used as a fallback if the gateway didn't attach a cost.

**Tech Stack:** Vercel AI SDK (`ai` package, `ToolLoopAgent.generate()`), Vercel AI Gateway (cost via `providerMetadata.gateway.cost`), `@nigel/agent` (existing tools + system prompt builder), `@nigel/sandbox` (existing connectSandbox via Phase 4a's `provisionSandboxForRun`), Drizzle ORM, Bun's test runner.

---

## File Structure

- Create:
  - `apps/web/lib/runs/specialist-execution.ts` — `executeSpecialistViaLLM({ run, sandbox, specialist, task })`. Constructs a per-specialist `ToolLoopAgent`, runs it with budget + cost hooks, returns `{ output: string }`.
  - `apps/web/lib/runs/specialist-execution.test.ts` — covers the hook wiring with a stubbed agent.
- Modify:
  - `apps/web/lib/specialists/presets.ts` — add `coder` preset.
  - `apps/web/lib/runs/dispatch.ts` — replace the LLM-not-supported throw with the execution path: provision sandbox → execute → teardown.
  - `apps/web/lib/runs/dispatch.test.ts` — add an integration test for the LLM dispatch path with a mocked execution wrapper.
  - `apps/web/lib/runs/index.ts` — export the new public surface.

---

## ToolLoopAgent API (locked from spike of `node_modules/.bun/ai@6/.../dist/index.d.ts` and `apps/web/app/workflows/chat.ts`)

- `new ToolLoopAgent(settings)` — settings include `model`, `instructions`, `tools`, `stopWhen`, `prepareStep`, `prepareCall`, `onStepFinish`, `onFinish`, `callOptionsSchema`, `experimental_context`.
- `agent.generate({ messages, options, onStepFinish, abortSignal })` — non-streaming entry; resolves to `GenerateTextResult` containing `text`, `usage`, per-step results, and `finishReason`.
- `agent.stream(...)` — streaming variant. Phase 4b uses `generate` for simplicity; streaming to UI happens later.
- `prepareStep` runs before every step (= every model call). Right place for the pre-step budget check.
- `onStepFinish` runs after each step. Right place for per-step cost capture. Receives a `StepResult` with `usage: LanguageModelUsage` and `providerMetadata: ProviderMetadata | undefined`.
- The Vercel AI Gateway attaches per-step cost as a USD string at `providerMetadata.gateway.cost`. The existing `extractGatewayCost(providerMetadata)` returns a `number | undefined` in USD.

---

## Pre-step budget check (locked semantics)

`prepareStep` is invoked with the messages, model, current step index. We can run an async function and return mutated parameters. We do not mutate parameters, but we run `await checkRootBudget(run.rootRunId)`. If over budget, the call throws `BudgetExhaustedError`; the ToolLoopAgent surfaces the throw out of `agent.generate(...)`. Caller catches and transitions Run to `blocked`.

---

## Per-step cost capture (locked semantics)

`onStepFinish(step)` is invoked after each model call. Extract cost:
```ts
const usdCost = extractGatewayCost(step.providerMetadata);
if (usdCost !== undefined) {
  await addCostMicros(run.id, Math.round(usdCost * 1_000_000));
}
```

Fallback when gateway didn't attach a cost (direct-provider call, dev environment, etc.):
```ts
else if (step.usage.inputTokens !== undefined && step.usage.outputTokens !== undefined) {
  const micros = computeCostMicros(specialist.model!, {
    inputTokens: step.usage.inputTokens,
    outputTokens: step.usage.outputTokens,
    cacheReadTokens: step.usage.inputTokenDetails?.cacheReadTokens,
  });
  await addCostMicros(run.id, micros);
}
```

`computeCostMicros` is the existing helper in `apps/web/lib/runs/cost.ts`. The `PRICING` table there uses dash-form model ids (`anthropic/claude-sonnet-4-6`) to match Phase 1/2 conventions; the gateway accepts both forms via the `(string & {})` escape hatch in its `GatewayModelId` type.

---

## Per-specialist `ToolLoopAgent` construction (locked)

Don't reuse the shared `webAgent`. Construct a fresh `ToolLoopAgent` per dispatch:

```ts
import { gateway } from "@nigel/agent";  // re-exports gateway()
import {
  ToolLoopAgent,
  stepCountIs,
  type ToolSet,
} from "ai";

// Filter the full open-agent tool set down to the specialist's allowlist.
const filteredTools = filterAgentTools(specialist.toolAllowlist, allOpenAgentTools);

const agent = new ToolLoopAgent({
  model: gateway(specialist.model),
  instructions: specialist.systemPrompt,
  tools: filteredTools,
  stopWhen: stepCountIs(MAX_STEPS),  // safety cap; default 50
  prepareStep: async () => {
    await checkRootBudget(run.rootRunId);
    return undefined;  // no parameter mutation
  },
  onStepFinish: async (step) => {
    const usd = extractGatewayCost(step.providerMetadata);
    if (usd !== undefined) {
      await addCostMicros(run.id, Math.round(usd * 1_000_000));
      return;
    }
    if (step.usage.inputTokens != null && step.usage.outputTokens != null) {
      try {
        const micros = computeCostMicros(specialist.model!, {
          inputTokens: step.usage.inputTokens,
          outputTokens: step.usage.outputTokens,
          cacheReadTokens: step.usage.inputTokenDetails?.cacheReadTokens,
        });
        await addCostMicros(run.id, micros);
      } catch {
        // Unknown model id in PRICING. Don't fail the run; cost just under-reports.
      }
    }
  },
});

const result = await agent.generate({
  messages: [{ role: "user", content: task }],
  options: { sandbox },  // experimental_context for tool calls
});

return { output: result.text };
```

The "all open-agent tools" map needs to be exported from `@nigel/agent` so `specialist-execution.ts` can filter it. The existing `open-agent.ts` declares it locally as `tools` but doesn't export. Phase 4b adds an export.

---

## `coder` preset (locked)

```ts
const coderPreset: CodePreset = {
  name: "coder",
  kind: "preset",
  systemPrompt: [
    "You are `coder`, a Nigel specialist focused on making correct, minimal code changes",
    "in the user's repository. You work inside a sandboxed checkout of the repo and have",
    "tools to read, write, edit, search, and run shell commands (including git).",
    "",
    "Working principles:",
    "- Read before you write. Investigate the code that surrounds your target before editing.",
    "- Make the smallest change that fully addresses the task. No incidental refactors.",
    "- After every code change, verify by running the repo's checks (lint / typecheck / tests)",
    "  via shell. If a check fails, fix the failure and re-run before declaring success.",
    "- Commit your work with a descriptive message and (if asked) push to a feature branch.",
    "- Never edit files outside the cloned repo's working tree.",
    "- If the task is ambiguous or you cannot complete it safely, return an explicit",
    "  description of what you tried and what blocks you — do not invent an outcome.",
  ].join("\n"),
  model: "anthropic/claude-sonnet-4-6",
  toolAllowlist: ["file", "search", "shell", "git"],
  sandboxPolicy: "inherit",
  mayRecurse: false,
  maxChildren: 0,
  budgetUsdDefaultMicros: 5_000_000,  // $5 default per coder run
  needsLocalStack: false,
};
```

Note dash-form model id matches Phase 1+2 convention (`PRICING` keys, existing test data).

---

## Tasks

### Task 1: Export the open-agent tools map from `@nigel/agent`

**Files:**
- Modify: `packages/agent/open-agent.ts` (export the `tools` const)
- Modify: `packages/agent/index.ts` (re-export)

- [ ] **Step 1: Export**

In `packages/agent/open-agent.ts`, change the local `const tools = { ... }` to `export const nigelTools = { ... }` (rename for clarity since `tools` is too generic). The existing `tools` reference inside `prepareCall` becomes `nigelTools`.

In `packages/agent/index.ts`, re-export: `export { nigelTools } from "./open-agent";`.

- [ ] **Step 2: Quality gates**

```bash
cd /Users/matt/code/github.com/to11ai/nigel
bun run check
bunx turbo typecheck --filter=web
```

Both must pass.

- [ ] **Step 3: Commit**

```bash
git add packages/agent/open-agent.ts packages/agent/index.ts
git commit -m "feat(agent): export nigelTools so specialist execution can filter them"
```

---

### Task 2: Add `coder` preset

**Files:**
- Modify: `apps/web/lib/specialists/presets.ts`

- [ ] **Step 1: Add the preset**

In `apps/web/lib/specialists/presets.ts`, alongside `echoPreset`:

```ts
const coderPreset: CodePreset = {
  name: "coder",
  kind: "preset",
  // (full system prompt as in the locked block above)
  systemPrompt: [...].join("\n"),
  model: "anthropic/claude-sonnet-4-6",
  toolAllowlist: ["file", "search", "shell", "git"],
  sandboxPolicy: "inherit",
  mayRecurse: false,
  maxChildren: 0,
  budgetUsdDefaultMicros: 5_000_000,
  needsLocalStack: false,
};

export const PRESETS: Readonly<Record<string, CodePreset>> = Object.freeze({
  [echoPreset.name]: echoPreset,
  [coderPreset.name]: coderPreset,
});
```

- [ ] **Step 2: Verify resolver tests still pass**

`cd apps/web && POSTGRES_URL=postgresql://test:test@localhost:5433/test bun test lib/specialists/`
Expected: existing 6 tests still pass; the resolver naturally accepts the new preset since it's not specifically tested.

- [ ] **Step 3: Quality gates** (`bun run check`, `bunx turbo typecheck --filter=web`)

- [ ] **Step 4: Commit**

```bash
git add apps/web/lib/specialists/presets.ts
git commit -m "feat(specialists): add coder preset"
```

---

### Task 3: Specialist execution wrapper (TDD)

**Files:**
- Create: `apps/web/lib/runs/specialist-execution.ts`
- Create: `apps/web/lib/runs/specialist-execution.test.ts`

- [ ] **Step 1: Write the failing test**

The test stubs `ToolLoopAgent` so we can assert hook wiring without hitting the AI Gateway.

```ts
// apps/web/lib/runs/specialist-execution.test.ts
import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  executeSpecialistViaLLM,
  type ExecuteSpecialistInput,
} from "./specialist-execution";
import type { ResolvedSpecialist } from "@/lib/specialists";
import type { AgentRun } from "./types";

// Lightweight stubs. The real ToolLoopAgent is mocked at the module
// boundary so we can drive its lifecycle deterministically.
const generateMock = mock(async ({ messages: _m, options: _o }) => ({
  text: "stub output",
  usage: { inputTokens: 100, outputTokens: 50, inputTokenDetails: {} },
  finishReason: "stop" as const,
}));
let lastConstructorSettings: any = null;
mock.module("ai", () => ({
  ToolLoopAgent: class {
    constructor(settings: any) {
      lastConstructorSettings = settings;
    }
    async generate(params: any) {
      return generateMock(params);
    }
  },
  stepCountIs: (n: number) => ({ kind: "stepCountIs", n }),
}));

// Mock @nigel/agent to provide a deterministic nigelTools.
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

// Mock the budget + cost repository helpers so we can observe hook calls.
const checkRootBudgetMock = mock(async (_id: string) => undefined);
const addCostMicrosMock = mock(async (_id: string, _delta: number) => undefined);
mock.module("./budget", () => ({
  checkRootBudget: checkRootBudgetMock,
  BudgetExhaustedError: class extends Error {},
}));
mock.module("./repository", () => ({
  addCostMicros: addCostMicrosMock,
}));

beforeEach(() => {
  generateMock.mockClear();
  checkRootBudgetMock.mockClear();
  addCostMicrosMock.mockClear();
  lastConstructorSettings = null;
});

const fakeRun = (overrides: Partial<AgentRun> = {}): AgentRun => ({
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
});

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

describe("executeSpecialistViaLLM", () => {
  test("returns the agent's final text", async () => {
    const input: ExecuteSpecialistInput = {
      run: fakeRun(),
      sandbox: { state: { type: "vercel" } as any, workingDirectory: "/work" },
      specialist: fakeSpecialist(),
      task: "do the thing",
    };
    const result = await executeSpecialistViaLLM(input);
    expect(result.output).toBe("stub output");
  });

  test("filters tools by specialist allowlist", async () => {
    await executeSpecialistViaLLM({
      run: fakeRun(),
      sandbox: { state: {} as any, workingDirectory: "/work" },
      specialist: fakeSpecialist({ toolAllowlist: ["search"] }),
      task: "x",
    });
    expect(Object.keys(lastConstructorSettings.tools).sort()).toEqual([
      "glob",
      "grep",
    ]);
  });

  test("throws if specialist is missing systemPrompt or model", async () => {
    await expect(
      executeSpecialistViaLLM({
        run: fakeRun(),
        sandbox: { state: {} as any, workingDirectory: "/work" },
        specialist: fakeSpecialist({ systemPrompt: null }),
        task: "x",
      }),
    ).rejects.toThrow();
  });

  test("prepareStep calls checkRootBudget", async () => {
    await executeSpecialistViaLLM({
      run: fakeRun(),
      sandbox: { state: {} as any, workingDirectory: "/work" },
      specialist: fakeSpecialist(),
      task: "x",
    });
    // Invoke the captured prepareStep manually to verify wiring.
    await lastConstructorSettings.prepareStep({});
    expect(checkRootBudgetMock).toHaveBeenCalledWith("run_root");
  });

  test("onStepFinish records gateway cost in micros", async () => {
    await executeSpecialistViaLLM({
      run: fakeRun(),
      sandbox: { state: {} as any, workingDirectory: "/work" },
      specialist: fakeSpecialist(),
      task: "x",
    });
    await lastConstructorSettings.onStepFinish({
      providerMetadata: { gateway: { cost: "0.0042" } },
      usage: { inputTokens: 100, outputTokens: 50, inputTokenDetails: {} },
    });
    expect(addCostMicrosMock).toHaveBeenCalledWith("run_abc", 4200);
  });

  test("onStepFinish falls back to PRICING when gateway cost absent", async () => {
    await executeSpecialistViaLLM({
      run: fakeRun(),
      sandbox: { state: {} as any, workingDirectory: "/work" },
      specialist: fakeSpecialist(),
      task: "x",
    });
    // No gateway metadata, but token usage provided. PRICING for sonnet-4-6 = $3/M input, $15/M output.
    // 100 input @ $3/M = 300 micros; 50 output @ $15/M = 750 micros; total = 1050.
    await lastConstructorSettings.onStepFinish({
      providerMetadata: undefined,
      usage: { inputTokens: 100, outputTokens: 50, inputTokenDetails: {} },
    });
    expect(addCostMicrosMock).toHaveBeenCalledWith("run_abc", 1050);
  });

  test("onStepFinish silently skips cost when both gateway and tokens absent", async () => {
    await executeSpecialistViaLLM({
      run: fakeRun(),
      sandbox: { state: {} as any, workingDirectory: "/work" },
      specialist: fakeSpecialist(),
      task: "x",
    });
    await lastConstructorSettings.onStepFinish({
      providerMetadata: undefined,
      usage: { inputTokenDetails: {} },
    });
    expect(addCostMicrosMock).not.toHaveBeenCalled();
  });
});
```

7 tests. The "filter by allowlist" test passes a single category and asserts the resulting tool keys; this is the only assertion that crosses Phase 4a's `filterAgentTools` so it provides end-to-end coverage of the wiring.

- [ ] **Step 2: Run, verify failures**

`cd apps/web && POSTGRES_URL=postgresql://test:test@localhost:5433/test bun test lib/runs/specialist-execution.test.ts`
Expected: module not found.

- [ ] **Step 3: Implement `apps/web/lib/runs/specialist-execution.ts`**

```ts
import { gateway, nigelTools } from "@nigel/agent";
import { stepCountIs, ToolLoopAgent } from "ai";
import type { ResolvedSpecialist } from "@/lib/specialists";
import { extractGatewayCost } from "@/app/workflows/gateway-metadata";
import { checkRootBudget } from "./budget";
import { computeCostMicros } from "./cost";
import { addCostMicros } from "./repository";
import { filterAgentTools } from "./tool-allowlist";
import type { AgentRun } from "./types";

const MAX_STEPS = 50;

export type SpecialistSandboxContext = {
  state: unknown;
  workingDirectory: string;
  currentBranch?: string;
  environmentDetails?: string;
};

export type ExecuteSpecialistInput = {
  run: AgentRun;
  sandbox: SpecialistSandboxContext;
  specialist: ResolvedSpecialist;
  task: string;
};

export type ExecuteSpecialistResult = {
  output: string;
};

export async function executeSpecialistViaLLM(
  input: ExecuteSpecialistInput,
): Promise<ExecuteSpecialistResult> {
  const { run, sandbox, specialist, task } = input;
  if (!specialist.systemPrompt || !specialist.model) {
    throw new Error(
      `LLM specialist '${specialist.name}' is missing systemPrompt or model`,
    );
  }
  const filteredTools = filterAgentTools(
    specialist.toolAllowlist,
    nigelTools,
  );

  const agent = new ToolLoopAgent({
    model: gateway(specialist.model),
    instructions: specialist.systemPrompt,
    tools: filteredTools as any,
    stopWhen: stepCountIs(MAX_STEPS),
    prepareStep: async () => {
      await checkRootBudget(run.rootRunId);
      return undefined as never;
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
          const micros = computeCostMicros(specialist.model!, {
            inputTokens,
            outputTokens,
            cacheReadTokens: step.usage?.inputTokenDetails?.cacheReadTokens,
          });
          await addCostMicros(run.id, micros);
        } catch {
          // Unknown model in PRICING table; don't fail the run.
        }
      }
    },
  });

  const result = await agent.generate({
    messages: [{ role: "user", content: task }],
    options: { sandbox },
  });

  return { output: result.text };
}
```

The `experimental_context` injection happens via `options: { sandbox }`. The existing `openAgent` extracts `sandbox` from `experimental_context` in tool implementations — we pass the same shape so the existing tools work without modification. (If `options` doesn't propagate to `experimental_context` automatically, set `experimental_context: { sandbox }` on the constructor or via `prepareCall`.)

- [ ] **Step 4: Run tests, verify pass**

Expected: 7/7 pass.

- [ ] **Step 5: Quality gates** (`bun run check`, `bunx turbo typecheck --filter=web`)

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/runs/specialist-execution.ts apps/web/lib/runs/specialist-execution.test.ts
git commit -m "feat(runs): add executeSpecialistViaLLM with budget + cost hooks"
```

---

### Task 4: Wire `dispatchSpecialist` to the LLM execution path

**Files:**
- Modify: `apps/web/lib/runs/dispatch.ts`
- Modify: `apps/web/lib/runs/dispatch.test.ts`

- [ ] **Step 1: Replace the throw**

In `apps/web/lib/runs/dispatch.ts`, the current code throws `SpecialistDispatchError` for non-scripted specialists at the end. Replace that block with:

```ts
import { provisionSandboxForRun, teardownSandboxForRun } from "./sandbox-coordinator";
import { executeSpecialistViaLLM } from "./specialist-execution";
import { BudgetExhaustedError } from "./budget";

// ... existing function body up through the scripted path stays unchanged ...

// LLM-driven specialists (Phase 4b).
if (specialist.kind === "preset" || specialist.kind === "custom") {
  if (!specialist.systemPrompt || !specialist.model) {
    await updateRunStatus(childRun.id, "failed").catch(() => undefined);
    throw new SpecialistDispatchError(
      `specialist '${specialist.name}' is incomplete (missing systemPrompt or model)`,
    );
  }

  let provisioned: Awaited<ReturnType<typeof provisionSandboxForRun>> | null = null;
  try {
    await updateRunStatus(childRun.id, "running");
    provisioned = await provisionSandboxForRun({
      inheritFrom: parent.sandboxState,
    });
    const result = await executeSpecialistViaLLM({
      run: childRun,
      sandbox: provisioned.toAgentContext(),
      specialist,
      task: input.task,
    });
    await updateRunStatus(childRun.id, "completed");
    const refreshed = (await getRun(childRun.id)) ?? childRun;
    return { childRun: refreshed, output: result.output };
  } catch (err) {
    if (err instanceof BudgetExhaustedError) {
      await updateRunStatus(childRun.id, "blocked", {
        blockedReason: "budget exhausted",
      }).catch(() => undefined);
    } else {
      await updateRunStatus(childRun.id, "failed").catch(() => undefined);
    }
    throw err;
  } finally {
    if (provisioned) await teardownSandboxForRun(provisioned);
  }
}

// (Remove the old final throw — it's now unreachable.)
```

- [ ] **Step 2: Add an integration test**

In `apps/web/lib/runs/dispatch.test.ts`, add a test that mocks `executeSpecialistViaLLM` and `provisionSandboxForRun` (so the test doesn't hit the AI Gateway or the Vercel Sandbox API):

```ts
import { mock } from "bun:test";

const executeMock = mock(async () => ({ output: "mocked llm output" }));
const provisionMock = mock(async () => ({
  sandbox: {} as any,
  workingDirectory: "/work",
  ownedByThisRun: false,
  toAgentContext: () => ({ state: {} as any, workingDirectory: "/work" }),
  stop: async () => {},
}));
const teardownMock = mock(async () => undefined);
mock.module("./specialist-execution", () => ({
  executeSpecialistViaLLM: executeMock,
}));
mock.module("./sandbox-coordinator", () => ({
  provisionSandboxForRun: provisionMock,
  teardownSandboxForRun: teardownMock,
}));

// ... inside the existing describe block ...
test("dispatches an LLM-driven specialist end-to-end", async () => {
  // Pre-register a parent run with a (faked) sandbox state.
  const parent = await Run.create({
    triggerSource: "chat",
    humanOwnerId: TEST_USER_ID,
    budgetUsdCapMicros: 5_000_000,
  });
  await db
    .update(agentRuns)
    .set({ sandboxState: { type: "vercel" } as any })
    .where(eq(agentRuns.id, parent.id));

  const result = await dispatchSpecialist({
    parentRunId: parent.id,
    specialistName: "coder",
    task: "do the thing",
  });

  expect(result.output).toBe("mocked llm output");
  expect(provisionMock).toHaveBeenCalledTimes(1);
  expect(teardownMock).toHaveBeenCalledTimes(1);
  const child = await getRun(result.childRun.id);
  expect(child?.status).toBe("completed");
});
```

The `bun:test` `mock.module` API replaces the imported module for subsequent tests in the same file. If multiple files import these modules, the mock only affects the file that registers it. Verify the existing `dispatch.test.ts` doesn't already have `executeSpecialistViaLLM` or `provisionSandboxForRun` mocks; if it does, merge with the new test.

If `mock.module` doesn't work cleanly for these specific imports, fall back to dependency injection: refactor `dispatchSpecialist` to take optional overrides for the two functions in its input shape, defaulting to the real implementations. Less elegant but bullet-proof.

- [ ] **Step 3: Run all dispatch tests**

`cd apps/web && POSTGRES_URL=postgresql://test:test@localhost:5433/test bun test lib/runs/dispatch.test.ts`
Expected: existing 7 tests pass + 1 new = 8/8.

- [ ] **Step 4: Run the full regression suite**

```bash
cd /Users/matt/code/github.com/to11ai/nigel/apps/web
POSTGRES_URL=postgresql://test:test@localhost:5433/test bun test lib/runs/ lib/specialists/ lib/repo-config/ lib/local-stack/
```

Expected: all tests pass.

- [ ] **Step 5: Quality gates** (`bun run check`, `bunx turbo typecheck --filter=web`)

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/runs/dispatch.ts apps/web/lib/runs/dispatch.test.ts
git commit -m "feat(runs): wire dispatchSpecialist to LLM execution path"
```

---

### Task 5: Barrel exports + final checks

**Files:**
- Modify: `apps/web/lib/runs/index.ts`

- [ ] **Step 1: Add the new public surface**

```ts
export {
  type ExecuteSpecialistInput,
  type ExecuteSpecialistResult,
  executeSpecialistViaLLM,
  type SpecialistSandboxContext,
} from "./specialist-execution";
```

- [ ] **Step 2: Full quality gate**

```bash
cd /Users/matt/code/github.com/to11ai/nigel
bun run check
bunx turbo typecheck --filter=web
cd apps/web
POSTGRES_URL=postgresql://test:test@localhost:5433/test bun test lib/runs/ lib/specialists/ lib/repo-config/ lib/local-stack/
```

All three must pass.

- [ ] **Step 3: Commit**

```bash
git add apps/web/lib/runs/index.ts
git commit -m "feat(runs): export Phase 4b public surface"
```

---

### Task 6: PR + babysit

- [ ] **Step 1: Push**

```bash
git push -u origin phase-4b-coder-execution
```

- [ ] **Step 2: Open PR**

Use the REST fallback (the GraphQL `gh pr create` has been failing for this account):

```bash
gh api repos/to11ai/nigel/pulls -f title="Phase 4b: coder LLM execution path" -f head=phase-4b-coder-execution -f base=main -f body="See docs/exec-plans/active/2026-05-09-nigel-phase-4b-coder-execution-plan.md"
```

Then `gh api -X PATCH repos/to11ai/nigel/pulls/<num>` with the full body.

- [ ] **Step 3: Hand off to babysit-pr**

Address Cursor Bugbot / Greptile findings using the same pattern as prior PRs.

---

## Open questions / followups

1. **Streaming output to UI**. This PR returns the final text. Live streaming via SSE goes with Phase 8 (UI completeness).
2. **Per-specialist max-iterations**. `MAX_STEPS = 50` is a hard-coded constant; if specialists need different limits, expose it as a `ResolvedSpecialist` field in a later PR.
3. **`experimental_context` propagation**. The plan passes `options: { sandbox }`. The existing tools read sandbox from `experimental_context` set by the openAgent's `prepareCall` hook. We may need to either set `experimental_context: { sandbox }` directly on the constructor or use a `prepareCall` hook ourselves. The implementer should verify this works in the tests; if tools don't get the sandbox, switch to constructor-level `experimental_context`.
4. **Real eval scenario for `coder`**. Deferred to Phase 9 per spec.
5. **GitHub credential brokering**. The chat path uses `setGitHubAuthToken` to broker GitHub creds during sandbox setup. Phase 4b inherits sandbox state from the parent so the parent's broker setup carries over. If a top-level coder run ever needs its own sandbox (Phase 4c?), broker setup needs to be replicated.
