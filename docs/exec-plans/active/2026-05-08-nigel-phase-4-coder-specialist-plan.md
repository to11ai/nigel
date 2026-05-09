# Nigel Phase 4 — `coder` Specialist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the first LLM-driven specialist (`coder`) end-to-end. Replace the "Phase 4 wires LLM-based specialists" throw in `dispatchSpecialist` with a real execution path that provisions a sandbox, runs the existing `openAgent` ToolLoop with a filtered tool allowlist, captures token usage as cost, enforces the budget at every model call, and tears down on completion.

**Architecture:** All new code lives in `apps/web/lib/runs/`. The existing `packages/agent/open-agent.ts` (`ToolLoopAgent` from upstream open-agents, with `read/write/edit/grep/glob/bash/task/skill/web_fetch` tools) is the LLM execution engine — we don't reimplement it. The new code wraps it with: sandbox provisioning, tool allowlist filtering, per-model-call budget check, token-to-cost conversion, and Run lifecycle hooks. The `coder` specialist is registered as a code preset in `apps/web/lib/specialists/presets.ts`. The race condition flagged on PR #6 (parallel dispatch budget check) gets fixed via Postgres advisory locks now that we have a cost-accumulating path.

**Tech Stack:** Vercel AI SDK (`ai` package, `ToolLoopAgent`), Vercel AI Gateway (`@ai-sdk/gateway`), `@nigel/sandbox` (existing Vercel Sandbox wrapper), Drizzle ORM, Postgres advisory locks, Bun's test runner.

---

## File Structure

- Create:
  - `apps/web/lib/runs/pricing.ts` — model-id → per-million USD price table; `tokensToMicros(modelId, usage)` helper.
  - `apps/web/lib/runs/pricing.test.ts`
  - `apps/web/lib/runs/sandbox-coordinator.ts` — `provisionSandboxForRun(run, options)` and `teardownSandboxForRun(handle)`. Wraps the existing `packages/sandbox/vercel/sandbox.ts` factory; encapsulates the "if parent has a sandbox, inherit; else create + clone repo" decision per `sandbox_policy`.
  - `apps/web/lib/runs/sandbox-coordinator.test.ts`
  - `apps/web/lib/runs/specialist-execution.ts` — `executeSpecialistViaLLM({ run, sandbox, specialist, task })`. Filters the openAgent tool set by the specialist's allowlist; runs the ToolLoop; before each model call calls `checkRootBudget(rootRunId)`; after each model call calls `addCostMicros(run.id, tokensToMicros(...))`; returns `{ output: string }` on success.
  - `apps/web/lib/runs/specialist-execution.test.ts`
  - `apps/web/lib/runs/tool-allowlist.ts` — pure mapping: `filterAgentTools(allowlist: readonly string[], tools: ToolSet): ToolSet`. Maps spec categories (`file`, `search`, `shell`, `git`, `web`) to the underlying agent tool names.
  - `apps/web/lib/runs/tool-allowlist.test.ts`
- Modify:
  - `apps/web/lib/specialists/presets.ts` — add `coder` preset.
  - `apps/web/lib/runs/dispatch.ts` — replace the throw at line ~100 with the LLM execution path (provision sandbox → executeSpecialistViaLLM → teardown).
  - `apps/web/lib/runs/budget.ts` — wrap `checkRootBudget` body with a Postgres advisory lock keyed on `hashtext('nigel:budget:' || rootRunId)`. Serializes concurrent budget checks so the dispatch-time race goes away.
  - `apps/web/lib/runs/index.ts` — re-export the new public surface.

Each file has one concern. The `sandbox-coordinator` module is the only one that talks to `@nigel/sandbox` directly; everything else operates on a passed-in `AgentSandboxContext`.

---

## Tool allowlist mapping (locked)

The spec's specialist roster (line 246) lists `coder`'s tools as `[file, search, shell, git]`. The existing agent tools are finer-grained:

| Spec category | Underlying agent tools |
|---|---|
| `file` | `read`, `write`, `edit` |
| `search` | `grep`, `glob` |
| `shell` | `bash` |
| `git` | (none — `bash` runs git directly until a structured `git` tool lands) |
| `web` | `web_fetch` |

`coder`'s effective tool set: `read`, `write`, `edit`, `grep`, `glob`, `bash`. The agent uses `bash` for git ops; a structured `git` tool is deferred.

`task` (sub-agent dispatch) is **excluded** for `coder` because the spec sets `may_recurse: false`. The allowlist filter will surface neither `task` nor `dispatch_specialist` for non-recursive specialists.

---

## Pricing table (locked initial values)

From the AI Gateway public price list (USD per million tokens, lowest-rate tier, as of 2026-05). Values live in code; admin override comes in a later phase.

```ts
{
  "anthropic/claude-haiku-4.5":  { promptUsdPerMillion: 1.0,  completionUsdPerMillion: 5.0 },
  "anthropic/claude-sonnet-4.6": { promptUsdPerMillion: 3.0,  completionUsdPerMillion: 15.0 },
  "anthropic/claude-opus-4.6":   { promptUsdPerMillion: 15.0, completionUsdPerMillion: 75.0 },
  "anthropic/claude-opus-4.7":   { promptUsdPerMillion: 15.0, completionUsdPerMillion: 75.0 },
}
```

Unknown model id → `0` cost (logs a warning), so an unrecognized model doesn't break the run; budget accounting just under-reports until the table is updated. Numbers are easy to revise.

`tokensToMicros(modelId, { promptTokens, completionTokens })`:
```
prompt:     promptTokens     / 1_000_000 * promptUsdPerMillion     * 1_000_000 = promptTokens     * promptUsdPerMillion
completion: completionTokens / 1_000_000 * completionUsdPerMillion * 1_000_000 = completionTokens * completionUsdPerMillion
total micros = round(promptTokens * promptUsdPerMillion + completionTokens * completionUsdPerMillion)
```

So with $3/M prompt + $15/M completion: 1000 prompt + 200 completion = 3000 + 3000 = **6000 micros = $0.006**. Integer micros throughout.

---

## Sandbox lifecycle (locked)

`provisionSandboxForRun(run, options)` decides what kind of sandbox the run gets:

1. If `run.sandboxState` is set (parent already has one and the policy is `inherit`): connect to it via `Sandbox.get`. Don't create a new one.
2. Else: create a fresh sandbox with `Sandbox.create`, runtime `node24`, repo cloned from `run.repoRef`. Store the sandbox handle in `run.sandboxState` via `updateRunStatus` so the parent run owns it.

`teardownSandboxForRun(handle)`:
- If the run created the sandbox (not inherited): stop it.
- If inherited: leave it for the parent's lifecycle. (Phase 1 introduced sandbox_policy with `inherit`/`fresh`/`fresh_clean`. `coder` is `inherit`, but if no parent provides one, a fresh sandbox is created and torn down by this run.)

For Phase 4 PR #1, top-level chat-triggered runs always create a sandbox; chained dispatch with `inherit` reuses the parent's. That's enough for `coder`.

---

## Budget enforcement at LLM call boundaries

Inside `executeSpecialistViaLLM`'s ToolLoop call, before every model invocation:

```ts
await checkRootBudget(run.rootRunId);   // throws BudgetExhaustedError on cap exceeded
const result = await modelCall(...);
const usage = result.usage;
const micros = tokensToMicros(specialist.model, usage);
await addCostMicros(run.id, micros);    // trigger rolls up to root
```

The ToolLoopAgent's `prepareCall` / `prepareStep` hooks let us interpose this without forking the agent. If `checkRootBudget` throws, the ToolLoop bubbles the error up; `executeSpecialistViaLLM`'s catch block transitions the Run to `failed` (or `blocked` if the error is `BudgetExhaustedError`) and re-throws.

---

## Race-condition fix (deferred from PR #6)

`checkRootBudget` currently does read-then-update without serialization. Two parallel `dispatchSpecialist` calls can both read "cost < cap" and both proceed; if their combined cost crosses the cap, neither sees it at dispatch time. The per-model-call check (above) catches it eventually, but at the cost of dispatching children that immediately block.

Fix: wrap the check in a transaction-scoped Postgres advisory lock:

```ts
await db.transaction(async (tx) => {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`nigel:budget:${rootRunId}`}))`);
  // Existing read-and-maybe-transition logic, scoped to tx.
});
```

`pg_advisory_xact_lock` blocks until the previous holder commits, then the next call enters with a fresh read of the cost. Two parallel dispatches now serialize at the budget check; the second sees the (possibly updated) root cost reflecting any in-flight cost increments. Cheap — Postgres advisory locks don't touch table data.

The existing `BudgetExhaustedError` semantics don't change; only the timing of when concurrent callers see the exhaustion does.

---

## Tasks

### Task 1: Add pricing module

**Files:**
- Create: `apps/web/lib/runs/pricing.ts`
- Create: `apps/web/lib/runs/pricing.test.ts`

- [ ] **Step 1: Failing test**

```ts
// apps/web/lib/runs/pricing.test.ts
import { describe, expect, test } from "bun:test";
import { tokensToMicros } from "./pricing";

describe("tokensToMicros", () => {
  test("computes sonnet 4.6 cost", () => {
    // 1000 prompt @ $3/M + 200 completion @ $15/M = 3000 + 3000 = 6000 micros
    expect(
      tokensToMicros("anthropic/claude-sonnet-4.6", {
        promptTokens: 1000,
        completionTokens: 200,
      }),
    ).toBe(6000);
  });

  test("computes haiku 4.5 cost", () => {
    // 1000 prompt @ $1/M + 1000 completion @ $5/M = 1000 + 5000 = 6000 micros
    expect(
      tokensToMicros("anthropic/claude-haiku-4.5", {
        promptTokens: 1000,
        completionTokens: 1000,
      }),
    ).toBe(6000);
  });

  test("returns 0 for unknown model id (no throw)", () => {
    expect(
      tokensToMicros("unknown/model", { promptTokens: 1000, completionTokens: 1000 }),
    ).toBe(0);
  });

  test("rounds to integer micros", () => {
    // 1 prompt @ $1/M = 1 micro; 1 completion @ $5/M = 5 micros = 6 total
    expect(
      tokensToMicros("anthropic/claude-haiku-4.5", { promptTokens: 1, completionTokens: 1 }),
    ).toBe(6);
  });

  test("zero usage yields 0", () => {
    expect(
      tokensToMicros("anthropic/claude-sonnet-4.6", { promptTokens: 0, completionTokens: 0 }),
    ).toBe(0);
  });
});
```

- [ ] **Step 2: Implementation**

```ts
// apps/web/lib/runs/pricing.ts
export type ModelUsage = {
  promptTokens: number;
  completionTokens: number;
};

type PriceEntry = {
  promptUsdPerMillion: number;
  completionUsdPerMillion: number;
};

const PRICES: Record<string, PriceEntry> = {
  "anthropic/claude-haiku-4.5":  { promptUsdPerMillion: 1.0,  completionUsdPerMillion: 5.0 },
  "anthropic/claude-sonnet-4.6": { promptUsdPerMillion: 3.0,  completionUsdPerMillion: 15.0 },
  "anthropic/claude-opus-4.6":   { promptUsdPerMillion: 15.0, completionUsdPerMillion: 75.0 },
  "anthropic/claude-opus-4.7":   { promptUsdPerMillion: 15.0, completionUsdPerMillion: 75.0 },
};

export function tokensToMicros(modelId: string, usage: ModelUsage): number {
  const entry = PRICES[modelId];
  if (!entry) {
    console.warn(
      `[pricing] unknown model id '${modelId}'; cost reported as 0 micros`,
    );
    return 0;
  }
  const promptMicros = usage.promptTokens * entry.promptUsdPerMillion;
  const completionMicros = usage.completionTokens * entry.completionUsdPerMillion;
  return Math.round(promptMicros + completionMicros);
}
```

- [ ] **Step 3: Run, verify pass**

`cd apps/web && POSTGRES_URL=postgresql://test:test@localhost:5433/test bun test lib/runs/pricing.test.ts`
Expected: 5/5 pass.

- [ ] **Step 4: Commit**

```bash
git add apps/web/lib/runs/pricing.ts apps/web/lib/runs/pricing.test.ts
git commit -m "feat(runs): add pricing table + tokensToMicros helper"
```

---

### Task 2: Tool allowlist filter

**Files:**
- Create: `apps/web/lib/runs/tool-allowlist.ts`
- Create: `apps/web/lib/runs/tool-allowlist.test.ts`

- [ ] **Step 1: Failing test**

```ts
// apps/web/lib/runs/tool-allowlist.test.ts
import { describe, expect, test } from "bun:test";
import { filterAgentTools } from "./tool-allowlist";

describe("filterAgentTools", () => {
  const allTools = {
    read: { _kind: "tool" },
    write: { _kind: "tool" },
    edit: { _kind: "tool" },
    grep: { _kind: "tool" },
    glob: { _kind: "tool" },
    bash: { _kind: "tool" },
    task: { _kind: "tool" },
    skill: { _kind: "tool" },
    web_fetch: { _kind: "tool" },
    todo_write: { _kind: "tool" },
    ask_user_question: { _kind: "tool" },
  } as const;

  test("file expands to read+write+edit", () => {
    const out = filterAgentTools(["file"], allTools);
    expect(Object.keys(out).sort()).toEqual(["edit", "read", "write"]);
  });

  test("search expands to grep+glob", () => {
    const out = filterAgentTools(["search"], allTools);
    expect(Object.keys(out).sort()).toEqual(["glob", "grep"]);
  });

  test("shell expands to bash", () => {
    const out = filterAgentTools(["shell"], allTools);
    expect(Object.keys(out).sort()).toEqual(["bash"]);
  });

  test("git expands to bash (no structured git tool yet)", () => {
    const out = filterAgentTools(["git"], allTools);
    expect(Object.keys(out).sort()).toEqual(["bash"]);
  });

  test("web expands to web_fetch", () => {
    const out = filterAgentTools(["web"], allTools);
    expect(Object.keys(out).sort()).toEqual(["web_fetch"]);
  });

  test("multiple categories deduplicate (shell+git both include bash)", () => {
    const out = filterAgentTools(["shell", "git"], allTools);
    expect(Object.keys(out).sort()).toEqual(["bash"]);
  });

  test("coder allowlist [file, search, shell, git] yields six tools", () => {
    const out = filterAgentTools(["file", "search", "shell", "git"], allTools);
    expect(Object.keys(out).sort()).toEqual([
      "bash", "edit", "glob", "grep", "read", "write",
    ]);
  });

  test("unknown category is silently ignored", () => {
    const out = filterAgentTools(["bogus", "shell"], allTools);
    expect(Object.keys(out).sort()).toEqual(["bash"]);
  });

  test("empty allowlist yields empty tool set", () => {
    expect(filterAgentTools([], allTools)).toEqual({});
  });
});
```

- [ ] **Step 2: Implementation**

```ts
// apps/web/lib/runs/tool-allowlist.ts
import type { ToolSet } from "ai";

// Maps a spec specialist tool category (e.g. "file") to the underlying
// open-agent tool names that implement it. Categories not in this map
// are silently ignored — they correspond to tools that this PR doesn't
// wire up (e.g. `database:*`, `mcp:pulumi`, `cloud:*`, `linear`,
// `dispatch_specialist`, `screenshot_matrix`).
const CATEGORY_TO_TOOLS: Record<string, readonly string[]> = {
  file: ["read", "write", "edit"],
  search: ["grep", "glob"],
  shell: ["bash"],
  // Until a structured git tool exists, the agent uses bash for git ops.
  git: ["bash"],
  web: ["web_fetch"],
};

export function filterAgentTools<T extends ToolSet>(
  allowlist: readonly string[],
  tools: T,
): Partial<T> {
  const wantedNames = new Set<string>();
  for (const category of allowlist) {
    const expansion = CATEGORY_TO_TOOLS[category];
    if (!expansion) continue;
    for (const name of expansion) wantedNames.add(name);
  }
  const out: Partial<T> = {};
  for (const name of wantedNames) {
    if (name in tools) {
      (out as Record<string, unknown>)[name] = tools[name as keyof T];
    }
  }
  return out;
}
```

- [ ] **Step 3: Run, verify pass**

Expected: 9/9 pass.

- [ ] **Step 4: Commit**

```bash
git add apps/web/lib/runs/tool-allowlist.ts apps/web/lib/runs/tool-allowlist.test.ts
git commit -m "feat(runs): add tool allowlist filter mapping spec categories to agent tools"
```

---

### Task 3: Race-condition fix in checkRootBudget

**Files:**
- Modify: `apps/web/lib/runs/budget.ts`
- Modify: `apps/web/lib/runs/budget.test.ts` (add concurrency test)

- [ ] **Step 1: Failing test**

Add to `apps/web/lib/runs/budget.test.ts`:

```ts
test("serializes concurrent budget checks via advisory lock", async () => {
  // Two parallel checks against the same root must not both see "below cap"
  // when their combined cost would cross it. We can't easily simulate the
  // race without a deterministic sleep, but we can at least verify the
  // function works correctly under Promise.all of N identical calls.
  const root = await Run.create({
    triggerSource: "chat",
    humanOwnerId: TEST_USER_ID,
    budgetUsdCapMicros: 1_000_000,
  });
  await updateRunStatus(root.id, "running");
  await addCostMicros(root.id, 1_000_000);

  const results = await Promise.allSettled([
    checkRootBudget(root.id),
    checkRootBudget(root.id),
    checkRootBudget(root.id),
  ]);
  expect(results.every((r) => r.status === "rejected")).toBe(true);

  const blocked = await getRun(root.id);
  expect(blocked?.status).toBe("blocked");
});
```

- [ ] **Step 2: Implementation**

In `apps/web/lib/runs/budget.ts`, wrap the body of `checkRootBudget` in a transaction with an advisory lock:

```ts
import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { getRun, updateRunStatus } from "./repository";

export class BudgetExhaustedError extends Error { /* unchanged */ }

export async function checkRootBudget(rootRunId: string): Promise<void> {
  await db.transaction(async (tx) => {
    // Serialize concurrent budget checks for this root. The lock is held
    // for the duration of the transaction; the next caller blocks until
    // the previous transaction commits, then reads the (possibly updated)
    // root cost.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`nigel:budget:${rootRunId}`}))`,
    );

    // The existing read-then-maybe-transition body, parameterized on `tx`
    // instead of the global `db`. Use tx-scoped getRun + updateRunStatus —
    // for now those helpers don't accept a transaction, so call db
    // operations directly on `tx` here. (Or refactor getRun/updateRunStatus
    // to accept an optional tx — same answer either way.)
    const rows = await tx.select().from(/* ...agentRuns... */).where(/* ... */).limit(1);
    // ...same logic as before, throwing BudgetExhaustedError on exhaust.
  });
}
```

(The exact body inlines the existing `checkRootBudget` logic so it can run inside the transaction. The implementer should keep the public API identical; only the internal path changes.)

- [ ] **Step 3: Run all budget tests, verify pass**

`cd apps/web && POSTGRES_URL=postgresql://test:test@localhost:5433/test bun test lib/runs/budget.test.ts`
Expected: original 4 tests + 1 new = 5/5 pass.

- [ ] **Step 4: Commit**

```bash
git add apps/web/lib/runs/budget.ts apps/web/lib/runs/budget.test.ts
git commit -m "fix(runs): serialize checkRootBudget via Postgres advisory lock

Closes the dispatch-time race called out by Greptile on PR #6: two
parallel dispatchSpecialist calls could both read root.cost < cap and
both proceed, dispatching N children whose combined cost exceeds cap.
Wrapping the read-then-maybe-transition body in a transaction-scoped
pg_advisory_xact_lock keyed on the root run id serializes concurrent
checks; the second caller blocks until the first commits, then re-reads."
```

---

### Task 4: Sandbox coordinator

**Files:**
- Create: `apps/web/lib/runs/sandbox-coordinator.ts`
- Create: `apps/web/lib/runs/sandbox-coordinator.test.ts`

- [ ] **Step 1: Implementation skeleton**

```ts
// apps/web/lib/runs/sandbox-coordinator.ts
import { createSandbox, getSandbox } from "@nigel/sandbox/vercel";
// (or wherever the existing factory lives — implementer should look at
// packages/sandbox/factory.ts and packages/sandbox/vercel/sandbox.ts)
import type { AgentRun } from "./types";

export type ProvisionedSandbox = {
  sandboxId: string;
  workingDirectory: string;
  ownedByThisRun: boolean;
  // ...whatever the existing wrapper returns; the AgentSandboxContext
  // shape from open-agent.ts (`{ state, workingDirectory, currentBranch?, environmentDetails? }`)
  // is what we ultimately want to pass to the LLM execution path.
  toAgentContext(): AgentSandboxContext;
  stop(): Promise<void>;
};

export async function provisionSandboxForRun(
  run: AgentRun,
): Promise<ProvisionedSandbox> {
  // 1. If run.sandboxState already references a live sandbox AND the
  //    specialist's sandbox_policy allows inherit, attach via getSandbox.
  // 2. Else create a fresh sandbox, clone run.repoRef into it, persist
  //    the resulting sandbox state on the run via updateRunStatus.
  // ...
}

export async function teardownSandboxForRun(handle: ProvisionedSandbox): Promise<void> {
  if (handle.ownedByThisRun) {
    await handle.stop();
  }
}
```

The implementer should consult `packages/sandbox/vercel/sandbox.ts` and `apps/web/lib/sandbox/` for existing patterns. The sandbox SDK accepts `source: { type: "git", url, revision? }` for clone-on-create; that's the path here.

- [ ] **Step 2: Tests**

The implementer should:
- Mock `@nigel/sandbox` at the test boundary (the Vercel Sandbox API can't be hit in a unit test).
- Verify `provisionSandboxForRun` creates a new sandbox when none exists.
- Verify `teardownSandboxForRun` only stops sandboxes the run owns.
- Add a unit test for the "inherit existing sandbox" path.

If mocking turns out to be onerous for this small surface, defer the unit tests and rely on the integration test in Task 6.

- [ ] **Step 3: Commit**

```bash
git add apps/web/lib/runs/sandbox-coordinator.ts apps/web/lib/runs/sandbox-coordinator.test.ts
git commit -m "feat(runs): add sandbox coordinator (provision + teardown for specialist runs)"
```

---

### Task 5: Specialist execution wrapper

**Files:**
- Create: `apps/web/lib/runs/specialist-execution.ts`
- Create: `apps/web/lib/runs/specialist-execution.test.ts`

- [ ] **Step 1: Implementation**

```ts
// apps/web/lib/runs/specialist-execution.ts
import { generateText, type ToolSet } from "ai";
import { gateway } from "@/lib/agent-gateway"; // or wherever models.ts re-exports
import { openAgent } from "@nigel/agent";       // or the appropriate import path
import type { ResolvedSpecialist } from "@/lib/specialists";
import { addCostMicros } from "./repository";
import { checkRootBudget } from "./budget";
import { tokensToMicros } from "./pricing";
import { filterAgentTools } from "./tool-allowlist";
import type { AgentRun } from "./types";
import type { AgentSandboxContext } from "@nigel/agent";

export type ExecuteSpecialistInput = {
  run: AgentRun;
  sandbox: AgentSandboxContext;
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

  // Build the filtered tool set. The full openAgent tools are loaded by the
  // ToolLoopAgent; we pass our subset via the call options so the model only
  // sees the allowed surface.
  const filteredTools = filterAgentTools(
    specialist.toolAllowlist,
    /* underlying agent tools — implementer pulls these from the open-agent
       module's `tools` const, exporting it if needed. */
  );

  // ToolLoopAgent's prepareCall hook is where we interpose budget + cost.
  // The cleanest implementation either:
  //   (a) constructs a fresh ToolLoopAgent per run with our hooks wired in, or
  //   (b) calls openAgent.respond(...) and uses the SDK's onFinish callback.
  // Implementer should pick whichever the AI SDK supports cleanly.

  // Pseudocode for the wrap:
  //   const result = await openAgent.respond({
  //     prompt: task,
  //     callOptions: { sandbox, model: specialist.model },
  //     tools: filteredTools,
  //     onStepStart: async () => { await checkRootBudget(run.rootRunId); },
  //     onStepFinish: async ({ usage }) => {
  //       const micros = tokensToMicros(specialist.model!, usage);
  //       await addCostMicros(run.id, micros);
  //     },
  //   });

  // Return the model's final text response as the run's output.
  return { output: /* result.text */ "" };
}
```

The implementer should pick the AI SDK's actual hook names (`onStepStart` / `onStepFinish` / equivalent) and adapt the pseudocode. The contract this module owes the rest of the system:
- pre-call: `checkRootBudget(run.rootRunId)` runs before every model call. Throws → caller catches → run transitions to `blocked` (BudgetExhaustedError) or `failed` (other).
- per-call: `addCostMicros(run.id, micros)` runs after every model call. Cost rolls up to root via the Phase 1 trigger.
- output: returns the final text response as a string.

- [ ] **Step 2: Tests**

Two tests are non-negotiable; the rest can be deferred to integration coverage in Task 6:

1. `executeSpecialistViaLLM` throws if `specialist.systemPrompt` or `specialist.model` is null.
2. Tool allowlist is honored: stub a fake agent that records the tools it was given; assert `coder`'s allowlist produces exactly `[bash, edit, glob, grep, read, write]`.

The "cost is captured" and "budget exhaustion mid-run blocks the run" assertions are easier to express as part of the dispatch integration test in Task 6.

- [ ] **Step 3: Commit**

```bash
git add apps/web/lib/runs/specialist-execution.ts apps/web/lib/runs/specialist-execution.test.ts
git commit -m "feat(runs): add executeSpecialistViaLLM wrapping openAgent with budget + cost hooks"
```

---

### Task 6: Wire dispatchSpecialist to the LLM path + add `coder` preset

**Files:**
- Modify: `apps/web/lib/runs/dispatch.ts`
- Modify: `apps/web/lib/specialists/presets.ts`
- Modify: `apps/web/lib/runs/dispatch.test.ts`

- [ ] **Step 1: Add `coder` preset**

In `apps/web/lib/specialists/presets.ts`, add alongside `echoPreset`:

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
  model: "anthropic/claude-sonnet-4.6",
  toolAllowlist: ["file", "search", "shell", "git"],
  sandboxPolicy: "inherit",
  mayRecurse: false,
  maxChildren: 0,
  budgetUsdDefaultMicros: 5_000_000, // $5 default budget for a coder run
  needsLocalStack: false,
};

export const PRESETS: Readonly<Record<string, CodePreset>> = Object.freeze({
  [echoPreset.name]: echoPreset,
  [coderPreset.name]: coderPreset,
});
```

- [ ] **Step 2: Replace the throw in dispatchSpecialist**

In `apps/web/lib/runs/dispatch.ts`, currently the function throws for non-scripted specialists at the end. Replace that block with:

```ts
// Phase 4: LLM-driven specialists.
if (specialist.kind === "preset" || specialist.kind === "custom") {
  if (!specialist.systemPrompt || !specialist.model) {
    await updateRunStatus(childRun.id, "failed").catch(() => undefined);
    throw new SpecialistDispatchError(
      `specialist '${specialist.name}' is incomplete (missing systemPrompt or model)`,
    );
  }

  let provisioned: ProvisionedSandbox | null = null;
  try {
    await updateRunStatus(childRun.id, "running");
    provisioned = await provisionSandboxForRun(childRun);
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
```

The preceding `if (specialist.kind === "scripted" && specialist.script)` block stays unchanged. Remove the `throw new SpecialistDispatchError(... "Phase 4 wires LLM-based specialists" ...)` at the end of the function.

- [ ] **Step 3: Integration test**

Add a single end-to-end test to `apps/web/lib/runs/dispatch.test.ts` that:
1. Creates a parent Run with a stubbed sandbox attached.
2. Mocks `@nigel/sandbox` and the AI SDK (the existing `openAgent` is too heavy for a unit test).
3. The mock returns deterministic `usage` numbers.
4. Asserts the child Run completes, output is the mock's text, and `cost_usd_actual_micros` on root reflects the mock's usage × pricing.

If full mocking is too invasive, narrow the integration test to: "child run reaches `completed` status when the execution wrapper is mocked to succeed" — and rely on the unit tests for the execution wrapper to cover cost + tool-filter assertions.

The pre-existing scripted specialist tests must continue to pass.

- [ ] **Step 4: Run full test suite**

`cd apps/web && POSTGRES_URL=postgresql://test:test@localhost:5433/test bun test lib/runs/ lib/specialists/ lib/repo-config/ lib/local-stack/`
Expected: all prior tests pass + the new ones.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/runs/dispatch.ts apps/web/lib/specialists/presets.ts apps/web/lib/runs/dispatch.test.ts
git commit -m "feat(runs): wire dispatchSpecialist to LLM execution path; add coder preset

Replaces the Phase 2 'cannot execute in Phase 2' throw with the real
LLM-driven path: provision sandbox, run executeSpecialistViaLLM
(openAgent + filtered tools + per-call budget check + cost capture),
teardown on completion. coder preset registered with the spec's
canonical system prompt and tool allowlist [file, search, shell, git]."
```

---

### Task 7: Barrel exports + final quality gate

**Files:**
- Modify: `apps/web/lib/runs/index.ts`

- [ ] **Step 1: Re-export the new public surface**

Add to the existing exports:

```ts
export { tokensToMicros, type ModelUsage } from "./pricing";
export { filterAgentTools } from "./tool-allowlist";
export {
  type ExecuteSpecialistInput,
  type ExecuteSpecialistResult,
  executeSpecialistViaLLM,
} from "./specialist-execution";
export {
  type ProvisionedSandbox,
  provisionSandboxForRun,
  teardownSandboxForRun,
} from "./sandbox-coordinator";
```

(Adjust ordering to match Ultracite if it complains.)

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
git commit -m "feat(runs): export Phase 4 public surface (pricing, tool-allowlist, execution)"
```

---

### Task 8: PR + babysit

- [ ] **Step 1: Push branch**

```bash
git push -u origin phase-4-coder-specialist
```

- [ ] **Step 2: Open PR**

Use the REST fallback (since `gh pr create` errored last time):

```bash
gh api repos/to11ai/nigel/pulls -f title="Phase 4: coder specialist (LLM-driven dispatch path)" -f head=phase-4-coder-specialist -f base=main -f body="See docs/exec-plans/active/2026-05-08-nigel-phase-4-coder-specialist-plan.md"
```

Then update the body via `gh api -X PATCH` with the full markdown summary.

- [ ] **Step 3: Hand off to babysit-pr**

Address Cursor Bugbot / Greptile findings using the same pattern as Phase 0/1/2/3a/3b-1 PRs.

---

## Open questions / followups

1. **Specialist execution telemetry.** The Phase 7 observability work will add OTel spans around model calls and tool calls. Phase 4 lays the wiring (`onStepStart` / `onStepFinish` hooks); Phase 7 attaches spans there.
2. **Structured `git` tool.** Deferred. `coder` uses `bash` for git ops in this PR. Add later if the agent reliably mis-uses git.
3. **Sandbox snapshot caching for repo clones.** Phase 3b-1 added the `sandbox_snapshots` schema; Phase 3b-2 will apply it. For now `coder` clones from scratch on every run.
4. **Streaming output.** This PR returns the final text. Streaming model output to the chat UI is a separate concern — the chat path already streams via the Workflow SDK; integrating that with `executeSpecialistViaLLM` is followup work.
