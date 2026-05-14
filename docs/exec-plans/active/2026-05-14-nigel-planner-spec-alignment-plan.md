# Nigel Planner Spec Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the `planner` specialist into alignment with the (newly amended) spec. Two missing tool surfaces — `dispatch_specialists_parallel` and `linear` (read + comment + attach only) — get built as agent-facing tools. The planner's allowlist is narrowed from edit-capable to coordinator-only: `file_read`, `search`, `web`, `dispatch_specialist`, `dispatch_specialists_parallel`, `linear`. The planner system prompt is rewritten to remove the "patch trivially" escape hatch and add parallel-dispatch + Linear-callback instructions. Planner budget cap is reduced because the coordinator no longer holds the work.

**Architecture:** Two new AI SDK tool wrappers land in `packages/agent/tools/`: one for parallel dispatch (sibling of `dispatch-specialist.ts`), one for the three Linear operations the planner needs. The parallel-dispatch wrapper relies on the existing server-side `dispatchSpecialistsParallel` in `apps/web/lib/runs/dispatch.ts:222`, but the server function is upgraded to do atomic N-slot reservation against `max_children` before any child spawns (today's implementation has a TOCTOU race). The Linear tool wrapper takes a server-side callback shape mirroring `DispatchSpecialistCallback` — the token resolution happens in `apps/web` via a new `lib/linear/agent-tool-impl.ts` adapter that loads the singleton `linear_workspace` row and posts via Linear's GraphQL API. `tool-allowlist.ts` gains two new category mappings (`dispatch_specialists_parallel`, `linear`). `presets.ts` planner block is rewritten: narrower allowlist, lower budget cap, prompt rewritten. Model selection stays on OpenAI per the existing decision (no revert to sonnet-4.6).

**Tech Stack:** Bun, AI SDK tool definitions, Workflow SDK steps (existing call sites), Drizzle ORM (read-only — `linear_workspace` row), Bun test runner. Spec: [../../product-specs/2026-05-08-nigel-system-design.md](../../product-specs/2026-05-08-nigel-system-design.md) — Sections 3 (Chained dispatch — `dispatch_specialists_parallel`), 4 (Specialist preset roster + new "Planner role — coordinator-only constraint" subsection), 5 (Tool registry — `linear` entry).

---

## File structure

| File | Purpose |
|---|---|
| `packages/agent/tools/dispatch-specialists-parallel.ts` (new) | AI SDK tool wrapper exposing parallel dispatch to the model |
| `packages/agent/tools/dispatch-specialists-parallel.test.ts` (new) | Unit tests for input schema, callback wiring, error mapping |
| `packages/agent/tools/linear.ts` (new) | Three AI SDK tool wrappers: `linear_get_issue`, `linear_comment`, `linear_attach` |
| `packages/agent/tools/linear.test.ts` (new) | Unit tests for the three wrappers — schema + callback wiring + error mapping |
| `packages/agent/tools/index.ts` (modify) | Re-export the four new tools |
| `apps/web/lib/runs/dispatch.ts` (modify) | Replace `dispatchSpecialistsParallel` Promise.all with atomic N-slot reservation against `max_children` + root-budget pre-flight |
| `apps/web/lib/runs/dispatch.test.ts` (modify) | Add tests for the atomic reservation: concurrent dispatch sees the right cap; pre-flight rejection when sum-of-budgets exceeds remaining root budget |
| `apps/web/lib/runs/tool-allowlist.ts` (modify) | Add `dispatch_specialists_parallel` and `linear` entries to `CATEGORY_TO_TOOLS` |
| `apps/web/lib/runs/tool-allowlist.test.ts` (modify) | Cover the two new categories |
| `apps/web/lib/linear/agent-tool-impl.ts` (new) | Server-side callback impl that resolves the singleton `linear_workspace`, holds the GraphQL client, exposes `getIssue`, `comment`, `attach` |
| `apps/web/lib/linear/agent-tool-impl.test.ts` (new) | Integration tests against a mocked Linear GraphQL endpoint (Bun `fetch` mock) |
| `apps/web/lib/linear/index.ts` (modify, if barrel exists) | Re-export the new adapter |
| `apps/web/lib/runs/specialist-execution.ts` (modify) | Wire the two new tools' callbacks into `experimental_context` alongside `dispatchSpecialist` |
| `apps/web/lib/runs/specialist-execution.test.ts` (modify) | Cover the new callback wiring |
| `apps/web/lib/specialists/presets.ts` (modify) | Rewrite the `planner` preset block: allowlist, system prompt, `budgetUsdDefaultMicros` |
| `apps/web/lib/specialists/resolver.ts` (modify) | Refuse to apply a `kind='override'` row on `planner` that adds `file`, `shell`, or `git` to the allowlist — enforce the coordinator-only constraint at resolution time |
| `apps/web/lib/specialists/resolver.test.ts` (modify) | Cover the new override-validation rule |
| `apps/web/app/workflows/linear-trigger.ts` (no change required) | Verify: planner's new Linear tool usage at end-of-Run produces the expected completion comment + attachment without needing workflow-level changes |

---

## Prerequisites

- This PR's spec amendment (the matching commit that updates `docs/product-specs/2026-05-08-nigel-system-design.md` line 245 + adds the "Planner role — coordinator-only constraint" subsection) is in the same commit set as the implementation. Do not merge implementation without the spec amendment.
- Phase 6 Linear infrastructure is live: `linear_workspace` table exists with at least one workspace row, the OAuth flow has populated `accessToken` (verify via the `linear_workspaces` admin UI or `psql ... -c 'select id, workspace_id, bot_user_id from linear_workspace;'`).
- Phase 2 dispatch path is live: `dispatchSpecialist` server function + `dispatch_specialist` AI SDK tool wrapper are wired and tested.
- `bun run ci` clean on `main`.

---

### Task 1: Server-side parallel dispatch — fix TOCTOU on `max_children`

**Files:**
- Modify: `apps/web/lib/runs/dispatch.ts`
- Modify: `apps/web/lib/runs/dispatch.test.ts`

The existing `dispatchSpecialistsParallel` at `apps/web/lib/runs/dispatch.ts:222-226` is a thin `Promise.all` over independent `dispatchSpecialist` calls. Each call evaluates `parent.maxChildren` against the parent's *current* `child_count` at validation time. Under concurrency, N parallel dispatches all see `child_count = k` simultaneously, all pass the gate, and the parent ends up with `k + N` children even when `k + N > max_children`. Same problem applies to root-budget pre-flight: each call sees the same remaining budget, all reserve their `budget_usd`, the parent ends up over the cap.

- [ ] **Step 1: Define the atomic reservation primitive**

Add a transaction-wrapped helper that, given `parentRunId` + an array of intended budgets, attempts to:
1. `SELECT child_count, max_children, root_budget_remaining FROM agent_runs ... FOR UPDATE` (row lock on the parent).
2. Compute `child_count + inputs.length <= max_children` and `sum(budgets) <= root_budget_remaining`.
3. If both pass: `UPDATE agent_runs SET child_count = child_count + inputs.length WHERE id = ?` (in the same transaction).
4. If either fails: throw a typed error (`max_children_exceeded` or `budget_exhausted_at_reservation`) and roll back. Caller does not partial-spawn.

- [ ] **Step 2: Rewrite `dispatchSpecialistsParallel`**

```ts
export async function dispatchSpecialistsParallel(
  inputs: DispatchSpecialistInput[],
): Promise<DispatchSpecialistResult[]> {
  if (inputs.length === 0) return [];
  // Atomic pre-flight: reserve N child slots + sum-of-budgets in one
  // transaction. Either all dispatches are authorized or none.
  await reserveChildSlots({
    parentRunId: inputs[0].parentRunId,
    rootRunId: inputs[0].rootRunId,
    requestedBudgetsMicros: inputs.map((i) => i.budgetUsdMicros ?? 0),
    requestedSlots: inputs.length,
  });
  // dispatchSpecialist itself must skip its own child-slot + budget
  // pre-flight when invoked through this path. Plumb an internal
  // `skipReservation: true` flag.
  return Promise.all(
    inputs.map((i) => dispatchSpecialist({ ...i, skipReservation: true })),
  );
}
```

- [ ] **Step 3: Add the `skipReservation` private flag to `dispatchSpecialist`**

Internal-only. The single-dispatch path (planner does `dispatch_specialist` for one child) still does its own reservation. The parallel path does the reservation once for the whole array.

- [ ] **Step 4: Tests**

In `dispatch.test.ts`, add:
- Atomic batch rejection on `max_children`: a parent with `max_children = 3` and `child_count = 2` receiving a parallel-of-2 — entire batch rejected with `max_children_exceeded` (`2 + 2 = 4 > 3`), `child_count` still 2 after, no children spawn. The non-atomic / TOCTOU implementation would have let one of the two through; the atomic implementation does not.
- Concurrent single-dispatch race: two single `dispatchSpecialist` calls fired concurrently against a parent with `max_children = 3` and `child_count = 2` — exactly one succeeds, the other returns `max_children_exceeded`. This is the case where the atomic reservation in `dispatchSpecialist` itself (serialized via `SELECT ... FOR UPDATE`) prevents the TOCTOU race that exists in the unfixed code.
- Budget race: parent with `root_budget_remaining = $5` receiving a parallel-of-3 each requesting `$2` — entire batch is rejected `budget_exhausted_at_reservation`, no children spawn.
- Zero-input case: `dispatchSpecialistsParallel([])` returns `[]` without touching the DB.
- Happy path: parallel-of-3 under cap, all three spawn, all three return their child output.

---

### Task 2: AI SDK tool wrapper — `dispatch_specialists_parallel`

**Files:**
- New: `packages/agent/tools/dispatch-specialists-parallel.ts`
- New: `packages/agent/tools/dispatch-specialists-parallel.test.ts`
- Modify: `packages/agent/tools/index.ts`

Mirror the shape of `packages/agent/tools/dispatch-specialist.ts` exactly. Same callback-via-`experimental_context` pattern. The callback is the only thing the agent package imports from `apps/web` — at runtime, `specialist-execution.ts` (in `apps/web`) curries the `parentRunId` / `rootRunId` / sandbox state in before calling.

- [ ] **Step 1: Define the callback type**

```ts
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
```

- [ ] **Step 2: Define the AI SDK tool**

Input schema is an array of `{ specialist_name, task, budget_usd_micros?, sandbox_policy_override? }`. Description spells out:
- "Use this when sub-tasks are *independent* (no shared state, no sequential dependency). Sequential follow-ups belong in your own tool loop — call `dispatch_specialist` once per step and read each output before deciding the next."
- "Wall-clock duration is roughly `max(child_durations)`. Cost is `sum(child_costs)` and is bounded by the root budget — if the sum-of-requested-budgets exceeds remaining root budget at dispatch time, the entire batch is rejected and no children spawn."
- "One child failure does not abort siblings. Each result has either `output` or `error`; you decide what to do with partial success."

- [ ] **Step 3: Re-export from `packages/agent/tools/index.ts`**

- [ ] **Step 4: Tests**

In `dispatch-specialists-parallel.test.ts`:
- Schema rejects empty `dispatches` array (LLM must call `dispatch_specialist` for one item, not pay the overhead of the parallel path).
- Schema rejects negative `budget_usd_micros`.
- Callback is invoked exactly once with the full array.
- Missing callback in `experimental_context` returns the same shape-of-failure as `dispatch-specialist.ts` does today (`success: false, error: "...not wired..."`).
- Per-child error from the callback flows through to `result.results[i].error`.

---

### Task 3: Server-side Linear adapter

**Files:**
- New: `apps/web/lib/linear/agent-tool-impl.ts`
- New: `apps/web/lib/linear/agent-tool-impl.test.ts`
- Modify: `apps/web/lib/linear/index.ts` (if a barrel exists; otherwise skip)

This is the runtime impl for the three Linear operations the planner gets. The agent never sees the token.

- [ ] **Step 1: Define the three operations**

```ts
export type LinearAgentToolCallback = {
  getIssue: (input: { issueId: string }) => Promise<{
    id: string;
    identifier: string;        // e.g. "LIN-123"
    title: string;
    description: string | null;
    statusName: string;
    assigneeName: string | null;
    teamKey: string;
    url: string;
  }>;
  comment: (input: {
    issueId: string;
    body: string;
  }) => Promise<{ commentId: string; url: string }>;
  attach: (input: {
    issueId: string;
    url: string;
    title: string;
    subtitle?: string;
  }) => Promise<{ attachmentId: string }>;
};
```

- [ ] **Step 2: Token resolution (deferred to call time)**

`buildForRun({ runId, orgId })` is a synchronous constructor: it captures the run identifiers and returns the callback shape. It does NOT call `resolveLinearWorkspace()` at construction time. The first actual tool invocation (`getIssue` / `comment` / `attach`) calls `resolveLinearWorkspace()` lazily, caches the resolved token + workspace row on the closure for the rest of the Run, and proceeds. This matters because `specialist-execution.ts` constructs callbacks for every Run regardless of specialist; if construction threw on a missing `linear_workspace` row, *every* Run (`coder`, `linter`, etc.) would fail to start on a deployment that hadn't set up Linear yet — but `specialist-execution.ts` already gates the construction on the allowlist (Task 6 Step 2), so in practice this only matters for the planner.

Reuse `resolveLinearWorkspace()` as-is — the resolver already handles short-lived access tokens with refresh-token renewal. Cache the resolved row per Run for the duration of the run (no cross-Run caching — keep the surface narrow). When `resolveLinearWorkspace()` returns "no workspace row exists," the callbacks return `{ kind: 'not_configured' }` to the agent rather than throwing.

- [ ] **Step 3: GraphQL client**

The codebase likely already has Linear GraphQL helpers (the existing webhook-handler + lifecycle code at `apps/web/lib/linear/` posts comments today as part of the agent-session wiring). Audit `apps/web/lib/linear/*.ts` before writing new GraphQL — reuse the existing `commentCreate` mutation if present, and only add `attachmentCreate` + `issue` query if missing.

Three operations needed:
- `issue(id: ID!)` query — read title, description, state, assignee, team key, URL.
- `commentCreate(input: { issueId, body })` mutation — body is markdown. Linear renders it as their internal markdown flavor; the existing Linear comment code probably already handles the dialect quirks.
- `attachmentCreate(input: { issueId, url, title, subtitle? })` mutation — used for PR links and visual-proof gallery links.

- [ ] **Step 4: Idempotency for `comment`**

Linear's `commentCreate` does not natively dedup. Either:
- (a) Caller supplies a stable `dedup_key`, the adapter stores `(runId, dedup_key) -> commentId` in a small `linear_run_comments` table and short-circuits on duplicate keys, OR
- (b) Accept the duplicate-post risk and document it.

Pick (b) for v1 — the planner is single-threaded against a given issue and will not double-post under normal operation. The risk surfaces only on Workflow SDK step-replay-after-kill-9, which is rare and worth a duplicate comment over a new table + migration. Revisit if observed.

- [ ] **Step 5: Tests**

In `agent-tool-impl.test.ts`, against a mocked `fetch` returning canned Linear GraphQL responses:
- `getIssue` returns the expected shape; missing issue surfaces a typed error.
- `comment` posts with the expected mutation body; rate-limit error (HTTP 429) surfaces a typed error the agent can read.
- `attach` posts with the expected mutation body.
- Token resolution failure (no `linear_workspace` row) returns `{ kind: 'not_configured' }` rather than a raw stack trace — the planner needs to be able to report "Linear not configured on this org" to the user gracefully.

---

### Task 4: AI SDK tool wrappers — `linear_get_issue`, `linear_comment`, `linear_attach`

**Files:**
- New: `packages/agent/tools/linear.ts`
- New: `packages/agent/tools/linear.test.ts`
- Modify: `packages/agent/tools/index.ts`

Same callback-via-`experimental_context` pattern as `dispatch-specialist.ts`. The agent package has no Linear-specific knowledge; the callback is wired by `apps/web/lib/runs/specialist-execution.ts`.

- [ ] **Step 1: Define the three tools**

`linear_get_issue` — input: `{ issue_id: string }` (accepts Linear's `LIN-123` shorthand OR the GraphQL ID; the callback normalizes). Output: `{ identifier, title, description, status_name, assignee_name, team_key, url }`.

`linear_comment` — input: `{ issue_id: string, body: string }`. Output: `{ comment_id, url }`. Description spells out that this is the planner's primary callback channel at end-of-Run for Linear-triggered Runs, that the body is markdown, and that comments are *not* state changes (no transition gate needed).

`linear_attach` — input: `{ issue_id: string, url: string, title: string, subtitle?: string }`. Output: `{ attachment_id }`. Description spells out that this is for PR links and visual-proof gallery links, that attachments are *not* state changes, and that it should be called *in addition to* (not instead of) a `linear_comment` summarizing what was done.

- [ ] **Step 2: Re-export from `packages/agent/tools/index.ts`**

- [ ] **Step 3: Tests**

In `linear.test.ts`:
- Each tool's schema rejects malformed input (empty `body`, malformed `url`, etc.).
- Each tool calls the corresponding callback method exactly once with the normalized input.
- Missing callback returns `{ success: false, error: "...not wired..." }` — same failure shape as the other tool wrappers.
- A callback-thrown `{ kind: 'not_configured' }` surfaces as a graceful error the agent can include in its final response, not a raw stack trace.

---

### Task 5: Tool allowlist wiring

**Files:**
- Modify: `apps/web/lib/runs/tool-allowlist.ts`
- Modify: `apps/web/lib/runs/tool-allowlist.test.ts`

- [ ] **Step 1: Add the two new categories**

```ts
const CATEGORY_TO_TOOLS: Record<string, readonly string[]> = {
  file: ["read", "write", "edit"],
  file_read: ["read"],
  search: ["grep", "glob"],
  shell: ["bash"],
  git: ["bash"],
  web: ["web_fetch"],
  dispatch_specialist: ["dispatch_specialist"],
  dispatch_specialists_parallel: ["dispatch_specialists_parallel"], // NEW
  linear: ["linear_get_issue", "linear_comment", "linear_attach"],  // NEW — also drop the "linear" entry from the line-6 "silently ignored" comment
  database_query: ["database_query"],
  clickhouse_query: ["clickhouse_query"],
  redis_command: ["redis_command"],
  mcp_call: ["mcp_call"],
  slack_post: ["slack_post"],
};
```

Update the top-of-file comment (currently at `tool-allowlist.ts:6-7`) — drop `linear` from the "silently ignored" list and refresh the example list of still-unwired categories (`database:*`, `mcp:pulumi`, `cloud:*`, `screenshot_matrix` remain).

- [ ] **Step 2: Tests**

Add cases asserting that a specialist with `["dispatch_specialists_parallel"]` in its allowlist gets the `dispatch_specialists_parallel` tool key present in the filtered tool set; same for `linear` expanding to all three Linear tools.

---

### Task 6: Wire the callbacks in `specialist-execution.ts`

**Files:**
- Modify: `apps/web/lib/runs/specialist-execution.ts`
- Modify: `apps/web/lib/runs/specialist-execution.test.ts`

Today's flow at `specialist-execution.ts:202-267` curries `dispatchSpecialist` into `experimental_context`. Add the parallel-dispatch + Linear callbacks alongside.

- [ ] **Step 1: Build the parallel-dispatch callback (gated on allowlist)**

```ts
const dispatchSpecialistsParallelFn:
  DispatchSpecialistsParallelCallback | undefined =
  specialist.toolAllowlist.includes("dispatch_specialists_parallel")
    ? (deps?.dispatchSpecialistsParallel ??
        (async (input) => {
          const { dispatchSpecialistsParallel } = await import("./dispatch");
          const results = await dispatchSpecialistsParallel(
            input.dispatches.map((d) => ({
              parentRunId: run.id,
              rootRunId: run.rootRunId ?? run.id,
              specialistName: d.specialistName,
              task: d.task,
              ...(d.budgetUsdMicros !== undefined
                ? { budgetUsdMicros: d.budgetUsdMicros }
                : {}),
              ...(d.sandboxPolicyOverride !== undefined
                ? { sandboxPolicyOverride: d.sandboxPolicyOverride }
                : {}),
            })),
          );
          return {
            results: results.map((r) => ({
              specialistName: r.specialistName,
              output: r.output ?? "",
              ...(r.error !== undefined ? { error: r.error } : {}),
            })),
          };
        }))
    : undefined;
```

Gate the init on `specialist.toolAllowlist.includes("dispatch_specialists_parallel")`, mirroring the `linearFn` treatment in Step 2 below. Specialists whose resolved allowlist doesn't include parallel dispatch (today: every specialist except `planner`) don't get the callback at all, and Step 3 omits the key from `experimental_context`. This is defense-in-depth — `filterAgentTools` already drops the tool from the agent's toolset when the allowlist doesn't include it, but matching the absence of the callback to the absence of the tool keeps "callbacks should be absent when the allowlist doesn't include the category" (Step 4) true by construction.

- [ ] **Step 2: Build the Linear callback (gated on allowlist)**

```ts
const linearFn: LinearAgentToolCallback | undefined =
  specialist.toolAllowlist.includes("linear")
    ? (deps?.linear ??
        (await import("@/lib/linear/agent-tool-impl")).buildForRun({
          runId: run.id,
          orgId: run.orgId,  // confirm the field name once in schema.ts
        }))
    : undefined;
```

Two constraints:

1. **Gate the init on the allowlist.** Only specialists whose resolved `toolAllowlist` includes `"linear"` (today: just `planner`) get a Linear callback. If a `coder` or `linter` Run hits this code path with no `linear` in its allowlist, no callback is built. The corresponding tool wrapper in `packages/agent/tools/linear.ts` already returns a typed failure when its callback is missing from `experimental_context`, so a misconfigured allowlist degrades to "the agent can't call the tool" rather than "the Run can't start."
2. **`buildForRun` must not throw at init time on a missing workspace.** The adapter has to defer the `resolveLinearWorkspace()` call to the first actual tool invocation. At construction time it stores the `runId` / `orgId` and returns the callback shape; only when `getIssue` / `comment` / `attach` is called does it resolve the workspace. If no row exists, the call returns `{ kind: 'not_configured' }` for the agent to handle gracefully. This keeps the wiring step at `specialist-execution.ts` purely synchronous-construction, so a deployment without Linear configured still runs every non-Linear specialist normally.

The Linear adapter is built per-Run rather than per-step so the resolved-token cache lives for the Run lifetime, not the tool call.

- [ ] **Step 3: Pass into `experimental_context`**

```ts
experimental_context: {
  dispatchSpecialist: dispatchSpecialistFn,
  ...(dispatchSpecialistsParallelFn !== undefined
    ? { dispatchSpecialistsParallel: dispatchSpecialistsParallelFn }
    : {}),
  ...(linearFn !== undefined ? { linear: linearFn } : {}),
}
```

The `dispatchSpecialistsParallel` and `linear` keys are each omitted entirely (not set to `undefined`) when the specialist's allowlist doesn't include them. This matches the "callbacks should be absent when the allowlist doesn't include the category" rule from Step 4 below. `dispatchSpecialist` itself is unconditionally present because the planner is not the only recursive specialist — `researcher` also dispatches, gated by `mayRecurse` + `dispatchTargetAllowlist` at the server side rather than by allowlist absence.

- [ ] **Step 4: Tests**

Cover that the new callbacks are present in `experimental_context` when the specialist's allowlist includes the corresponding categories, and absent otherwise (defense-in-depth — if `filterAgentTools` drops the tool, the callback being present in context is benign, but if the allowlist filter is ever bypassed, the callback should also be absent).

---

### Task 7: Update the planner preset

**Files:**
- Modify: `apps/web/lib/specialists/presets.ts`

The current planner block is at lines 533-642 (the JS block + the prompt + the config). Rewrite the configuration; keep the model + provider options (`openai/gpt-5.5`, `reasoningEffort: "high"`) untouched per the standing decision not to revert to sonnet-4.6.

- [ ] **Step 1: Update the configuration block**

```ts
toolAllowlist: [
  "file_read",
  "search",
  "web",
  "dispatch_specialist",
  "dispatch_specialists_parallel",
  "linear",
],
sandboxPolicy: "inherit",
mayRecurse: true,
maxChildren: 10,
budgetUsdDefaultMicros: 3_000_000,  // was 10_000_000 — coordinator no longer holds the work
needsLocalStack: false,
```

- [ ] **Step 2: Rewrite the system prompt**

Drop the "Use your direct file/shell access for verification and trivial patches only" sentence. Add three new paragraphs:

1. **Parallel dispatch.** "When you have multiple independent sub-tasks (e.g., `linter` + `type-checker` + `unit-tester` after a finished code change), dispatch them with `dispatch_specialists_parallel` in a single call. Wall-clock duration is `max(child)` rather than `sum(child)`. Sequential follow-ups — where one specialist's output decides the next dispatch — still belong in your own tool loop via `dispatch_specialist`."

2. **Linear callback (for Linear-triggered Runs).** "If the task came in from Linear (you'll see the issue identifier in the task description), wrap up by posting a final comment with `linear_comment` summarizing what was done — include the PR URL if a code change was made, and call out any follow-up actions for the human owner. Then call `linear_attach` to attach the PR URL and (if a visual-prover ran) the proof gallery URL. Do NOT attempt to change the issue's status, assignee, or labels — those route through the `linear-engineer` specialist with explicit authorization."

3. **Coordinator-only constraint.** "You do not have file-write, shell, or git tools. Every code change must be dispatched to a worker specialist (`coder`, `linter`, `formatter`, `type-checker`, `unit-tester`, `e2e-tester`). If you find yourself wanting to 'just quickly patch' something, that is the moment to dispatch `coder` with a focused task instead. The narrower your tool surface, the cleaner your Run tree, the better per-worker budget attribution, and the cheaper your overall Run."

- [ ] **Step 3: Update the inline comment block above the preset**

Rewrite lines 533-561 to reflect the new coordinator-only design. Drop the line *"plus the full read/write/shell surface so the planner can sanity-check child output and patch trivial things directly when it's cheaper than re-dispatching"* — that escape hatch is exactly what the spec amendment closed.

---

### Task 8: Enforce the coordinator-only constraint in the resolver

**Files:**
- Modify: `apps/web/lib/specialists/resolver.ts`
- Modify: `apps/web/lib/specialists/resolver.test.ts`

An admin could otherwise paper over the spec amendment with a `kind='override'` row that re-adds `file` / `shell` / `git` to the planner. The resolver is the place to enforce the constraint at runtime — it already merges presets and overrides.

- [ ] **Step 1: Add the override guard**

In the resolver's merge step, when the target specialist's `name === 'planner'`:
- If the override-row's `toolAllowlist` contains any of `["file", "shell", "git"]`, refuse to apply the override with a typed error (`planner_override_forbidden_tools`).
- The merge should NOT silently strip the disallowed entries — silent stripping makes the override config look applied when it isn't. Hard-fail is the right call.

- [ ] **Step 2: Tests**

- Override on `planner` adding `["file"]` → resolver throws `planner_override_forbidden_tools`.
- Override on `planner` adding `["shell"]` → same.
- Override on `planner` changing model/budget/prompt without touching the allowlist → succeeds.
- Override on `coder` adding `["file"]` (no-op, coder already has it) → succeeds. The constraint is `planner`-specific.

---

### Task 9: Acceptance validation

**Files:**
- (none — manual / runtime validation)

- [ ] **Step 1: Replay the PR #54 budget-overrun scenario**

Re-trigger the scenario that hit the planner's old `$10/run` cap on PR #54. Verify against the new behavior:
- Planner's own Run records 0 `edit` / 0 `bash` / 0 `git` tool calls. Confirm via OTel spans in Datadog.
- Per-Run cost ledger shows planner's spend bounded by coordination (typically <$1 of model tokens on the planner Run), with the heavy lifting attributed to dispatched worker Runs.
- Total root-budget spend is comparable or lower than the original Run. If it's higher, dig into why — possible re-read amplification across workers; record findings.

- [ ] **Step 2: End-to-end Linear-triggered Run**

Open a curated test issue in Linear (or reuse the Phase 6 test fixture), assign to the Nigel bot user. Verify:
- The Run completes.
- A `linear_comment` lands on the issue with: a one-paragraph summary, the PR URL, any follow-up actions.
- A `linear_attach` lands with the PR URL as the attachment.
- The issue's status, assignee, labels are unchanged from pre-Run. (The lifecycle-hook reassignment back to the human owner described in spec section 3 still happens via the existing webhook handler, NOT via the planner's `linear` tool — confirm that wiring is unaffected.)

- [ ] **Step 3: Parallel dispatch wall-clock check**

Construct a synthetic Run where the planner needs to fan out to three specialists with non-trivial duration (say, `linter` + `type-checker` + `unit-tester` against a non-trivial diff). Verify in OTel:
- The three child Run spans overlap in time (start within ~1s of each other; durations overlap meaningfully).
- The parent's `dispatch_specialists_parallel` tool span has duration ≈ `max(child)` not `sum(child)`.

- [ ] **Step 4: Atomic-reservation race test**

Stress test the atomic reservation: from a test harness, fire a `dispatch_specialists_parallel` of N=5 against a parent with `max_children = 2` and `child_count = 0`. Expect: entire batch rejected with `max_children_exceeded` and `child_count` still 0. Repeat with N=3 against `max_children = 5` and `child_count = 3` — same outcome. Repeat with N=3 against `max_children = 5` and `child_count = 0` — all three spawn, `child_count = 3` after.

- [ ] **Step 5: Adversarial override**

Manually insert a `kind='override'` row on `planner` with `tool_allowlist = ["file_read", "search", "shell", "web", "dispatch_specialist", "linear"]` (note the `shell` injection). Trigger any planner Run. Expect: the Run fails at specialist-resolution time with `planner_override_forbidden_tools`, the human owner is notified, no LLM tokens are spent. Remove the bad override after the test.

---

## Out of scope

- `linear-engineer` improvements (the heavier write path — status transitions, assignee changes, label changes). Tracked separately under Phase 6 polish.
- `screenshot_matrix` / `visual-prover` integration with `linear_attach` for proof galleries. Spec section 4.4 (Lifecycle on completion) describes this; the wiring lands in the visual-prover phase.
- The `linear-trigger.ts` workflow startup-comment ("Nigel is on it"). Nice-to-have, not in spec.
- Reconciling spec lines 253-254 (`reviewer` / `adversarial-reviewer` allowlists still say "file, search (read-only)" rather than `file_read`) with the implementation that already uses `file_read`. Pre-existing spec inconsistency, not introduced by this plan; flag in the spec amendment commit but defer the fix.

---

## Validation checklist (before merge)

- [ ] `bun run ci` clean
- [ ] All new tests pass; existing tests unchanged
- [ ] OTel spans for the PR #54 replay show 0 planner-side file edits / 0 shell calls
- [ ] Linear-triggered Run end-to-end completes with a comment + attachment, no status change
- [ ] Parallel dispatch wall-clock ≈ `max(child)` confirmed in OTel
- [ ] Atomic-reservation race tests pass
- [ ] Adversarial override test fails the Run at resolution time with the expected typed error
- [ ] Spec amendment committed in the same commit set as the implementation
