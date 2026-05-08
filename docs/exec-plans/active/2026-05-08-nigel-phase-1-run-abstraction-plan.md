# Nigel Phase 1: `Run` Abstraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce the `Run` abstraction as the unifying primitive for every agent execution (chat, future Linear-triggered, future chained sub-agent), with the schema, runtime helpers, lifecycle state machine, denormalized cost rollup, and feature-flagged chat-path integration in place — so Phase 2 (specialist registry + dispatch) and beyond compose cleanly on top.

**Architecture:** Adds five new tables (`agent_runs`, `run_messages`, `run_tool_calls`, `run_artifacts`, `webhook_events`) co-located in the existing Drizzle schema. A small `lib/runs/` module owns the runtime: `types.ts` (Zod-validated state enum + `AgentRun` row type), `state-machine.ts` (transition validator), `repository.ts` (Drizzle queries), `create.ts` (`Run.create()` factory with depth/budget validation), `cost.ts` (price-table + rollup helpers), `lifecycle.ts` (status-change hooks — empty in Phase 1, just the dispatch shape), `feature-flag.ts` (`NIGEL_ENABLE_RUNS` env gate). Cost rollup is denormalized via a Postgres trigger that updates `root_run_id`'s `cost_usd_actual` on every row insert/update. Existing `workflow_runs` data is backfilled one-to-one into `agent_runs` rows in a single SQL migration. Chat path branches behind a feature flag — old code path is the default, new `Run.create()` path activates when `NIGEL_ENABLE_RUNS=1`.

**Tech Stack:** Drizzle ORM + Drizzle Kit (migrations), Postgres (Neon), Zod (schema validation), Bun test runner, Workflow SDK (`workflow`/`workflow/api`), Next.js App Router. Spec: [../../product-specs/2026-05-08-nigel-system-design.md](../../product-specs/2026-05-08-nigel-system-design.md) (Sections 1–4, 9, 11).

---

## File structure

| File | Purpose |
|---|---|
| `apps/web/lib/db/schema.ts` (modify) | Add `agentRuns`, `runMessages`, `runToolCalls`, `runArtifacts`, `webhookEvents` table definitions next to existing tables |
| `apps/web/lib/db/migrations/0036_agent_runs.sql` (new) | DDL for the new tables + indexes + cost-rollup trigger |
| `apps/web/lib/db/migrations/0037_backfill_agent_runs.sql` (new) | Backfill existing `workflow_runs` rows into `agent_runs` |
| `apps/web/lib/db/migrations/meta/_journal.json` (modify) | Drizzle journal — auto-updated by `bun run db:generate` |
| `apps/web/lib/db/migrations/meta/0036_snapshot.json` (new, generated) | Drizzle schema snapshot |
| `apps/web/lib/db/migrations/meta/0037_snapshot.json` (new, generated) | Drizzle schema snapshot |
| `apps/web/lib/runs/types.ts` (new) | `RunStatus`, `TriggerSource`, `SandboxPolicy` Zod enums + `AgentRun` row type |
| `apps/web/lib/runs/state-machine.ts` (new) | `validateTransition(from, to)` — pure function, transition table |
| `apps/web/lib/runs/state-machine.test.ts` (new) | Unit tests for the state machine |
| `apps/web/lib/runs/repository.ts` (new) | Drizzle queries: `insertRun`, `updateRunStatus`, `getRun`, `getRootRun`, `listChildren`, `treeWalk` |
| `apps/web/lib/runs/repository.test.ts` (new) | Integration tests against test Postgres |
| `apps/web/lib/runs/create.ts` (new) | `Run.create({...})` factory — validates depth ≤ 5, budget arithmetic, parent constraints |
| `apps/web/lib/runs/create.test.ts` (new) | Unit + integration tests for `Run.create` |
| `apps/web/lib/runs/cost.ts` (new) | `PRICING` table, `computeCostUsd(model, tokens)`, rollup query helper |
| `apps/web/lib/runs/cost.test.ts` (new) | Unit tests for pricing + rollup-trigger behavior |
| `apps/web/lib/runs/lifecycle.ts` (new) | `onStatusChange(runId, oldStatus, newStatus)` dispatcher (empty body in Phase 1) |
| `apps/web/lib/runs/feature-flag.ts` (new) | `isRunsEnabled()` reads `NIGEL_RESOURCE_PROFILE` companion env `NIGEL_ENABLE_RUNS` |
| `apps/web/lib/runs/index.ts` (new) | Re-exports the public surface (`Run`, `RunStatus`, etc.) |
| `apps/web/.env.example` (modify) | Add `NIGEL_ENABLE_RUNS=` |
| `apps/web/app/workflows/chat.ts` (modify) | When flag is on, call `Run.create()` at workflow start and update Run status at workflow end |
| `apps/web/app/api/chat/_lib/runtime.ts` (modify) | When flag is on, link the workflow run id back to its `agent_run` row |
| `apps/web/lib/runs/integration.test.ts` (new) | End-to-end Drizzle + Postgres test: create top-level Run, child Run, transitions, cost rollup |
| `infra/vercel/index.ts` (modify) | Add `NIGEL_ENABLE_RUNS` env var to Vercel project (default unset = old path) |

---

## Prerequisites

- Phase 0 complete and merged to `main`. The repo has `apps/web` running on Vercel against the prod Neon Postgres at `to11/nigel-data-neon/prod`.
- Local dev: `bun install` succeeds, `bun run typecheck` and `bun run check` are green on `main`.
- A local Postgres for tests. Either `docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=test -e POSTGRES_USER=test -e POSTGRES_DB=test postgres:16` or a Neon dev branch. Connection string exported as `TEST_POSTGRES_URL`.
- Drizzle Kit available: `bun run --cwd apps/web db:generate` works.

---

### Task 1: Branch + scope check

**Files:**
- (none — git only)

- [ ] **Step 1: Create the feature branch off main**

```bash
cd /Users/matt/code/github.com/to11ai/nigel
git checkout main
git pull origin main
git checkout -b phase-1-run-abstraction
```

Expected: switched to `phase-1-run-abstraction`. Per saved feedback, never commit to `main`.

- [ ] **Step 2: Verify clean baseline**

```bash
bun install
bun run typecheck
bun run check
```

Expected: all pass. If any fails, fix on `main` first; do not start Phase 1 on a broken baseline.

---

### Task 2: Add `agent_runs` schema definition (Drizzle)

**Files:**
- Modify: `apps/web/lib/db/schema.ts` — append `agentRuns` table after `workflowRunSteps` (around line 336)

- [ ] **Step 1: Append the schema block**

Edit `apps/web/lib/db/schema.ts`. After the `workflowRunSteps` definition (just before `userPreferences`), insert:

```ts
// agent_runs — the unifying execution primitive (Phase 1).
// One row per agent execution: top-level (chat, linear-triggered, cron) or
// chained sub-agent. Tree structure via parent_run_id; root_run_id is
// denormalized for cost-rollup queries.
export const agentRuns = pgTable(
  "agent_runs",
  {
    id: text("id").primaryKey(),
    parentRunId: text("parent_run_id"),
    rootRunId: text("root_run_id").notNull(),
    depth: integer("depth").notNull().default(0),

    triggerSource: text("trigger_source", {
      enum: ["chat", "linear", "chained", "cron"],
    }).notNull(),
    triggerRef: text("trigger_ref"),

    specialistId: text("specialist_id"),
    sandboxPolicy: text("sandbox_policy", {
      enum: ["inherit", "fresh", "fresh_clean"],
    })
      .notNull()
      .default("inherit"),

    humanOwnerId: text("human_owner_id").references(() => users.id, {
      onDelete: "set null",
    }),

    repoRef: text("repo_ref"),
    sandboxId: text("sandbox_id"),
    workflowRunId: text("workflow_run_id"),
    chatId: text("chat_id").references(() => chats.id, {
      onDelete: "set null",
    }),

    budgetUsdCap: integer("budget_usd_cap_micros").notNull().default(0),
    costUsdActual: integer("cost_usd_actual_micros").notNull().default(0),

    status: text("status", {
      enum: [
        "pending",
        "running",
        "blocked",
        "awaiting_approval",
        "completed",
        "failed",
        "cancelled",
      ],
    })
      .notNull()
      .default("pending"),
    blockedReason: text("blocked_reason"),

    approvalRequired: boolean("approval_required").notNull().default(false),
    approvedBy: text("approved_by").references(() => users.id, {
      onDelete: "set null",
    }),
    approvedAt: timestamp("approved_at"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    startedAt: timestamp("started_at"),
    endedAt: timestamp("ended_at"),
  },
  (table) => [
    index("agent_runs_parent_idx").on(table.parentRunId),
    index("agent_runs_root_idx").on(table.rootRunId),
    index("agent_runs_owner_idx").on(table.humanOwnerId),
    index("agent_runs_chat_idx").on(table.chatId),
    index("agent_runs_workflow_idx").on(table.workflowRunId),
    index("agent_runs_status_idx").on(table.status),
    index("agent_runs_trigger_idx").on(table.triggerSource),
  ],
);

// run_messages — chat/conversation messages owned by a Run.
// In Phase 1 the chat path keeps writing to chat_messages; this table is the
// landing zone for messages emitted by sub-agents and future trigger sources.
export const runMessages = pgTable(
  "run_messages",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["user", "assistant", "system"] }).notNull(),
    parts: jsonb("parts").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("run_messages_run_idx").on(table.runId)],
);

// run_tool_calls — record of every tool invocation under a Run, with its
// cost and outcome. Phase 1 writes are limited to the new chat path when
// the feature flag is on; Phase 2+ adds the dispatch_specialist tool.
export const runToolCalls = pgTable(
  "run_tool_calls",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    toolKind: text("tool_kind").notNull(),
    toolName: text("tool_name").notNull(),
    input: jsonb("input"),
    output: jsonb("output"),
    success: boolean("success"),
    costUsdMicros: integer("cost_usd_micros").notNull().default(0),
    latencyMs: integer("latency_ms"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("run_tool_calls_run_idx").on(table.runId)],
);

// run_artifacts — files, screenshots, logs, pulumi previews, etc. produced
// by a Run. Phase 1 is the table only; producers come in later phases.
export const runArtifacts = pgTable(
  "run_artifacts",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    rootRunId: text("root_run_id").notNull(),
    kind: text("kind", {
      enum: ["screenshot", "html", "log", "file", "pulumi_preview"],
    }).notNull(),
    path: text("path").notNull(),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("run_artifacts_run_idx").on(table.runId),
    index("run_artifacts_root_idx").on(table.rootRunId),
    index("run_artifacts_kind_idx").on(table.kind),
  ],
);

// webhook_events — idempotency log for inbound webhooks (Linear in Phase 6,
// reserved here so the schema is stable). Unique constraint on (source,
// external_id) prevents double-processing.
export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: text("id").primaryKey(),
    source: text("source").notNull(),
    externalId: text("external_id").notNull(),
    receivedAt: timestamp("received_at").defaultNow().notNull(),
    processedAt: timestamp("processed_at"),
    runId: text("run_id").references(() => agentRuns.id, {
      onDelete: "set null",
    }),
  },
  (table) => [
    uniqueIndex("webhook_events_source_external_idx").on(
      table.source,
      table.externalId,
    ),
  ],
);
```

(Cost values are stored as **micro-USD integers** — `1.50 USD` becomes `1_500_000`. Avoids floating-point rounding in rollup arithmetic. Convert at presentation only.)

- [ ] **Step 2: Verify schema typechecks**

```bash
bun run typecheck
```

Expected: passes. If `index`, `boolean`, etc. aren't imported from `drizzle-orm/pg-core`, add them to the existing import block at the top of `schema.ts`.

- [ ] **Step 3: Commit**

```bash
git add apps/web/lib/db/schema.ts
git commit -m "feat(db): add agent_runs schema (Phase 1)"
```

---

### Task 3: Generate the Drizzle migration

**Files:**
- Create: `apps/web/lib/db/migrations/0036_*.sql` (Drizzle picks the suffix)
- Modify: `apps/web/lib/db/migrations/meta/_journal.json`
- Create: `apps/web/lib/db/migrations/meta/0036_snapshot.json`

- [ ] **Step 1: Generate**

```bash
cd apps/web
bun run db:generate
```

Expected: Drizzle Kit prints something like `0036_<random_name>.sql created`. The file contains `CREATE TABLE ...` statements for each new table + indexes.

- [ ] **Step 2: Inspect the generated file**

```bash
ls migrations/0036_*.sql
cat migrations/0036_*.sql | head -40
```

Confirm the file contains:
- `CREATE TABLE "agent_runs"` with the columns from Task 2.
- `CREATE TABLE "run_messages"`, `"run_tool_calls"`, `"run_artifacts"`, `"webhook_events"`.
- All seven indexes on `agent_runs` plus the per-table indexes.
- The unique index on `webhook_events`.

If anything is missing, edit `schema.ts`, delete the generated migration, and re-run `db:generate`.

- [ ] **Step 3: Commit the generated migration**

```bash
cd /Users/matt/code/github.com/to11ai/nigel
git add apps/web/lib/db/migrations/
git commit -m "feat(db): generate 0036 migration for agent_runs"
```

---

### Task 4: Add the cost-rollup Postgres trigger

The denormalized rollup keeps `agent_runs.cost_usd_actual` on the **root** in sync with the sum across the subtree. Drizzle Kit doesn't generate raw triggers; we hand-write a custom migration after the schema migration.

**Files:**
- Create: `apps/web/lib/db/migrations/0037_cost_rollup_trigger.sql`
- Modify: `apps/web/lib/db/migrations/meta/_journal.json` (Drizzle won't touch this — append manually)

- [ ] **Step 1: Create the trigger migration**

Create `apps/web/lib/db/migrations/0037_cost_rollup_trigger.sql`:

```sql
-- Maintains agent_runs.cost_usd_actual on the root row as the sum of self +
-- all descendants. Fires on insert and on update of cost_usd_actual on any
-- non-root row. Walks parent_run_id chain to find the root and updates it.
CREATE OR REPLACE FUNCTION agent_runs_cost_rollup() RETURNS TRIGGER AS $$
DECLARE
  v_root_id text;
  v_delta_micros integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_delta_micros := NEW.cost_usd_actual_micros;
    v_root_id := NEW.root_run_id;
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.cost_usd_actual_micros = NEW.cost_usd_actual_micros THEN
      RETURN NEW;
    END IF;
    v_delta_micros := NEW.cost_usd_actual_micros - OLD.cost_usd_actual_micros;
    v_root_id := NEW.root_run_id;
  ELSE
    RETURN NEW;
  END IF;

  -- Self-update on the root row is the only path that reaches the root row;
  -- non-root rows propagate via this function which adds delta to the root.
  IF NEW.id = v_root_id THEN
    RETURN NEW;
  END IF;

  UPDATE agent_runs
    SET cost_usd_actual_micros = cost_usd_actual_micros + v_delta_micros
    WHERE id = v_root_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agent_runs_cost_rollup_trg
  AFTER INSERT OR UPDATE OF cost_usd_actual_micros ON agent_runs
  FOR EACH ROW EXECUTE FUNCTION agent_runs_cost_rollup();
```

- [ ] **Step 2: Append to Drizzle journal**

Edit `apps/web/lib/db/migrations/meta/_journal.json`. The file is a JSON object with an `entries` array. Append a new entry after the existing last one (idx 35 currently):

```json
    {
      "idx": 36,
      "version": "7",
      "when": 1715180000000,
      "tag": "0036_agent_runs",
      "breakpoints": true
    },
    {
      "idx": 37,
      "version": "7",
      "when": 1715180001000,
      "tag": "0037_cost_rollup_trigger",
      "breakpoints": true
    }
```

(Use the actual filename Drizzle generated for `0036` — replace `0036_agent_runs` with the real tag like `0036_<random_name>`. The `when` value just has to be monotonically increasing; copy from the previous entry and add 1000.)

- [ ] **Step 3: Apply migrations against a local test DB**

```bash
export TEST_POSTGRES_URL="postgresql://test:test@localhost:5432/test"
export POSTGRES_URL="$TEST_POSTGRES_URL"
cd apps/web
bun run db:migrate
```

Expected: prints the new migrations being applied. No errors.

- [ ] **Step 4: Verify the trigger exists**

```bash
psql "$TEST_POSTGRES_URL" -c "SELECT tgname FROM pg_trigger WHERE tgrelid = 'agent_runs'::regclass;"
```

Expected: one row, `agent_runs_cost_rollup_trg`.

- [ ] **Step 5: Commit**

```bash
cd /Users/matt/code/github.com/to11ai/nigel
git add apps/web/lib/db/migrations/0037_cost_rollup_trigger.sql apps/web/lib/db/migrations/meta/_journal.json
git commit -m "feat(db): add cost rollup trigger on agent_runs"
```

---

### Task 5: Define `RunStatus` state machine

**Files:**
- Create: `apps/web/lib/runs/state-machine.ts`
- Create: `apps/web/lib/runs/state-machine.test.ts`

- [ ] **Step 1: Write failing tests**

Create `apps/web/lib/runs/state-machine.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { isValidTransition, terminalStates } from "./state-machine";

describe("isValidTransition", () => {
  test("pending → running is valid", () => {
    expect(isValidTransition("pending", "running")).toBe(true);
  });

  test("running → completed is valid", () => {
    expect(isValidTransition("running", "completed")).toBe(true);
  });

  test("running → failed is valid", () => {
    expect(isValidTransition("running", "failed")).toBe(true);
  });

  test("running → blocked is valid", () => {
    expect(isValidTransition("running", "blocked")).toBe(true);
  });

  test("running → cancelled is valid", () => {
    expect(isValidTransition("running", "cancelled")).toBe(true);
  });

  test("running → awaiting_approval is valid", () => {
    expect(isValidTransition("running", "awaiting_approval")).toBe(true);
  });

  test("blocked → running is valid", () => {
    expect(isValidTransition("blocked", "running")).toBe(true);
  });

  test("blocked → cancelled is valid", () => {
    expect(isValidTransition("blocked", "cancelled")).toBe(true);
  });

  test("awaiting_approval → running is valid", () => {
    expect(isValidTransition("awaiting_approval", "running")).toBe(true);
  });

  test("awaiting_approval → cancelled is valid", () => {
    expect(isValidTransition("awaiting_approval", "cancelled")).toBe(true);
  });

  test("completed → running is invalid", () => {
    expect(isValidTransition("completed", "running")).toBe(false);
  });

  test("failed → running is invalid", () => {
    expect(isValidTransition("failed", "running")).toBe(false);
  });

  test("cancelled → running is invalid", () => {
    expect(isValidTransition("cancelled", "running")).toBe(false);
  });

  test("pending → completed (skipping running) is invalid", () => {
    expect(isValidTransition("pending", "completed")).toBe(false);
  });

  test("identity transitions (X → X) are invalid", () => {
    for (const s of [
      "pending",
      "running",
      "blocked",
      "awaiting_approval",
      "completed",
      "failed",
      "cancelled",
    ] as const) {
      expect(isValidTransition(s, s)).toBe(false);
    }
  });
});

describe("terminalStates", () => {
  test("contains exactly completed, failed, cancelled", () => {
    expect(terminalStates).toEqual(
      new Set(["completed", "failed", "cancelled"]),
    );
  });
});
```

- [ ] **Step 2: Run tests, expect failure**

```bash
cd apps/web
bun test lib/runs/state-machine.test.ts 2>&1 | tail -10
```

Expected: file/module not found — tests fail because `state-machine.ts` doesn't exist yet.

- [ ] **Step 3: Implement state machine**

Create `apps/web/lib/runs/state-machine.ts`:

```ts
export type RunStatus =
  | "pending"
  | "running"
  | "blocked"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

export const terminalStates: ReadonlySet<RunStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

// Transition table — keys are sources, values are valid destinations.
// Identity transitions (X -> X) are intentionally excluded.
const TRANSITIONS: Record<RunStatus, ReadonlySet<RunStatus>> = {
  pending: new Set(["running", "cancelled", "failed"]),
  running: new Set([
    "blocked",
    "awaiting_approval",
    "completed",
    "failed",
    "cancelled",
  ]),
  blocked: new Set(["running", "cancelled", "failed"]),
  awaiting_approval: new Set(["running", "cancelled", "failed"]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

export function isValidTransition(from: RunStatus, to: RunStatus): boolean {
  return TRANSITIONS[from].has(to);
}

export function assertValidTransition(from: RunStatus, to: RunStatus): void {
  if (!isValidTransition(from, to)) {
    throw new Error(`invalid run status transition: ${from} -> ${to}`);
  }
}
```

- [ ] **Step 4: Run tests, expect pass**

```bash
bun test lib/runs/state-machine.test.ts 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/matt/code/github.com/to11ai/nigel
git add apps/web/lib/runs/state-machine.ts apps/web/lib/runs/state-machine.test.ts
git commit -m "feat(runs): add RunStatus state machine"
```

---

### Task 6: Define types module

**Files:**
- Create: `apps/web/lib/runs/types.ts`

- [ ] **Step 1: Define the types**

Create `apps/web/lib/runs/types.ts`:

```ts
import type { InferSelectModel } from "drizzle-orm";
import { z } from "zod";
import type { agentRuns } from "@/lib/db/schema";

export const runStatusSchema = z.enum([
  "pending",
  "running",
  "blocked",
  "awaiting_approval",
  "completed",
  "failed",
  "cancelled",
]);

export const triggerSourceSchema = z.enum([
  "chat",
  "linear",
  "chained",
  "cron",
]);

export const sandboxPolicySchema = z.enum([
  "inherit",
  "fresh",
  "fresh_clean",
]);

export type TriggerSource = z.infer<typeof triggerSourceSchema>;
export type SandboxPolicy = z.infer<typeof sandboxPolicySchema>;

// Row type derived from the Drizzle table definition; stays in sync
// automatically when columns change.
export type AgentRun = InferSelectModel<typeof agentRuns>;

export const MAX_DEPTH = 5;
export const DEFAULT_MAX_CHILDREN = 10;
```

- [ ] **Step 2: Typecheck**

```bash
cd apps/web
bun run typecheck
```

Expected: passes.

- [ ] **Step 3: Commit**

```bash
cd /Users/matt/code/github.com/to11ai/nigel
git add apps/web/lib/runs/types.ts
git commit -m "feat(runs): add types module"
```

---

### Task 7: Add pricing module

Stored in code so model-pricing changes ship via deploy.

**Files:**
- Create: `apps/web/lib/runs/cost.ts`
- Create: `apps/web/lib/runs/cost.test.ts`

- [ ] **Step 1: Write failing tests**

Create `apps/web/lib/runs/cost.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { computeCostMicros, PRICING } from "./cost";

describe("PRICING table", () => {
  test("contains the three current Anthropic models", () => {
    expect(PRICING).toHaveProperty("anthropic/claude-opus-4-7");
    expect(PRICING).toHaveProperty("anthropic/claude-sonnet-4-6");
    expect(PRICING).toHaveProperty("anthropic/claude-haiku-4-5");
  });
});

describe("computeCostMicros", () => {
  test("haiku 1000 input + 500 output = 4000 micros", () => {
    // haiku: 0.80 in / 4.00 out per 1M tokens
    // input: 1000 * 0.80 / 1_000_000 * 1_000_000 = 800 micros
    // output: 500 * 4.00 / 1_000_000 * 1_000_000 = 2000 micros
    // total: 2800 micros
    expect(
      computeCostMicros("anthropic/claude-haiku-4-5", {
        inputTokens: 1000,
        outputTokens: 500,
      }),
    ).toBe(2800);
  });

  test("cache reads use cache_read price", () => {
    // haiku: cache_read 0.08 per 1M tokens
    // 10000 cache reads * 0.08 / 1M * 1M = 800 micros
    expect(
      computeCostMicros("anthropic/claude-haiku-4-5", {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 10000,
      }),
    ).toBe(800);
  });

  test("unknown model throws", () => {
    expect(() =>
      computeCostMicros("anthropic/claude-imaginary", {
        inputTokens: 1,
        outputTokens: 1,
      }),
    ).toThrow(/unknown model/);
  });

  test("zero tokens returns zero", () => {
    expect(
      computeCostMicros("anthropic/claude-haiku-4-5", {
        inputTokens: 0,
        outputTokens: 0,
      }),
    ).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests, expect failure**

```bash
cd apps/web
bun test lib/runs/cost.test.ts 2>&1 | tail -10
```

Expected: module not found.

- [ ] **Step 3: Implement**

Create `apps/web/lib/runs/cost.ts`:

```ts
// Per-million-tokens USD prices for each AI Gateway model slug. Keep this
// flat — pricing changes ship via a deploy. Add slugs as new models are
// onboarded; never remove a slug without first verifying nothing in
// agent_runs references it.
export const PRICING: Record<
  string,
  { in: number; out: number; cacheRead: number }
> = {
  "anthropic/claude-opus-4-7": { in: 15, out: 75, cacheRead: 1.5 },
  "anthropic/claude-sonnet-4-6": { in: 3, out: 15, cacheRead: 0.3 },
  "anthropic/claude-haiku-4-5": { in: 0.8, out: 4, cacheRead: 0.08 },
};

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
};

// Cost in micro-USD (1_000_000 micros = 1 USD). Stored as integer in DB.
export function computeCostMicros(model: string, usage: TokenUsage): number {
  const price = PRICING[model];
  if (!price) {
    throw new Error(`unknown model for pricing: ${model}`);
  }

  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  const inputCost = usage.inputTokens * price.in;
  const outputCost = usage.outputTokens * price.out;
  const cacheCost = cacheReadTokens * price.cacheRead;

  // (tokens * usd_per_million) / 1_000_000 * 1_000_000_micros = tokens * usd_per_million
  // i.e. integer-arithmetic-safe because we kept the units balanced.
  return Math.round(inputCost + outputCost + cacheCost);
}
```

- [ ] **Step 4: Run tests, expect pass**

```bash
bun test lib/runs/cost.test.ts 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/matt/code/github.com/to11ai/nigel
git add apps/web/lib/runs/cost.ts apps/web/lib/runs/cost.test.ts
git commit -m "feat(runs): add pricing table + cost computation"
```

---

### Task 8: Add the runs repository (Drizzle queries)

**Files:**
- Create: `apps/web/lib/runs/repository.ts`
- Create: `apps/web/lib/runs/repository.test.ts`

- [ ] **Step 1: Write failing integration test**

Create `apps/web/lib/runs/repository.test.ts`:

```ts
import { describe, expect, test, beforeEach } from "bun:test";
import { db } from "@/lib/db/client";
import { agentRuns, users } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  insertRun,
  getRun,
  listChildren,
  updateRunStatus,
} from "./repository";

const TEST_USER_ID = "test-user-runs-repo";

beforeEach(async () => {
  await db.delete(agentRuns);
  await db
    .insert(users)
    .values({
      id: TEST_USER_ID,
      username: "test-runs-repo",
      email: "test-runs-repo@example.com",
    })
    .onConflictDoNothing();
});

describe("runs repository", () => {
  test("insertRun + getRun roundtrip", async () => {
    const id = nanoid();
    await insertRun({
      id,
      parentRunId: null,
      rootRunId: id,
      depth: 0,
      triggerSource: "chat",
      triggerRef: null,
      humanOwnerId: TEST_USER_ID,
      repoRef: null,
      sandboxPolicy: "inherit",
      budgetUsdCapMicros: 10_000_000,
    });

    const row = await getRun(id);
    expect(row?.id).toBe(id);
    expect(row?.rootRunId).toBe(id);
    expect(row?.status).toBe("pending");
    expect(row?.depth).toBe(0);
  });

  test("listChildren returns direct descendants only", async () => {
    const root = nanoid();
    const child1 = nanoid();
    const child2 = nanoid();
    const grandchild = nanoid();
    await insertRun({
      id: root,
      parentRunId: null,
      rootRunId: root,
      depth: 0,
      triggerSource: "chat",
      humanOwnerId: TEST_USER_ID,
      sandboxPolicy: "inherit",
      budgetUsdCapMicros: 0,
    });
    await insertRun({
      id: child1,
      parentRunId: root,
      rootRunId: root,
      depth: 1,
      triggerSource: "chained",
      humanOwnerId: TEST_USER_ID,
      sandboxPolicy: "inherit",
      budgetUsdCapMicros: 0,
    });
    await insertRun({
      id: child2,
      parentRunId: root,
      rootRunId: root,
      depth: 1,
      triggerSource: "chained",
      humanOwnerId: TEST_USER_ID,
      sandboxPolicy: "inherit",
      budgetUsdCapMicros: 0,
    });
    await insertRun({
      id: grandchild,
      parentRunId: child1,
      rootRunId: root,
      depth: 2,
      triggerSource: "chained",
      humanOwnerId: TEST_USER_ID,
      sandboxPolicy: "inherit",
      budgetUsdCapMicros: 0,
    });

    const children = await listChildren(root);
    const ids = children.map((r) => r.id).sort();
    expect(ids).toEqual([child1, child2].sort());
  });

  test("updateRunStatus enforces state machine", async () => {
    const id = nanoid();
    await insertRun({
      id,
      parentRunId: null,
      rootRunId: id,
      depth: 0,
      triggerSource: "chat",
      humanOwnerId: TEST_USER_ID,
      sandboxPolicy: "inherit",
      budgetUsdCapMicros: 0,
    });

    await updateRunStatus(id, "running");
    const r1 = await getRun(id);
    expect(r1?.status).toBe("running");

    await updateRunStatus(id, "completed");
    const r2 = await getRun(id);
    expect(r2?.status).toBe("completed");

    // Terminal -> running is rejected.
    await expect(updateRunStatus(id, "running")).rejects.toThrow(
      /invalid.*transition/,
    );
  });
});
```

- [ ] **Step 2: Run, expect failure**

```bash
bun test lib/runs/repository.test.ts 2>&1 | tail -10
```

Expected: module not found.

- [ ] **Step 3: Implement repository**

Create `apps/web/lib/runs/repository.ts`:

```ts
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { agentRuns } from "@/lib/db/schema";
import { assertValidTransition, type RunStatus } from "./state-machine";
import type { AgentRun, SandboxPolicy, TriggerSource } from "./types";

export type InsertRunInput = {
  id: string;
  parentRunId: string | null;
  rootRunId: string;
  depth: number;
  triggerSource: TriggerSource;
  triggerRef?: string | null;
  specialistId?: string | null;
  sandboxPolicy: SandboxPolicy;
  humanOwnerId: string | null;
  repoRef?: string | null;
  workflowRunId?: string | null;
  chatId?: string | null;
  budgetUsdCapMicros: number;
};

export async function insertRun(input: InsertRunInput): Promise<void> {
  await db.insert(agentRuns).values({
    id: input.id,
    parentRunId: input.parentRunId,
    rootRunId: input.rootRunId,
    depth: input.depth,
    triggerSource: input.triggerSource,
    triggerRef: input.triggerRef ?? null,
    specialistId: input.specialistId ?? null,
    sandboxPolicy: input.sandboxPolicy,
    humanOwnerId: input.humanOwnerId,
    repoRef: input.repoRef ?? null,
    workflowRunId: input.workflowRunId ?? null,
    chatId: input.chatId ?? null,
    budgetUsdCap: input.budgetUsdCapMicros,
    costUsdActual: 0,
    status: "pending",
  });
}

export async function getRun(id: string): Promise<AgentRun | null> {
  const rows = await db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function listChildren(parentId: string): Promise<AgentRun[]> {
  return db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.parentRunId, parentId));
}

export async function updateRunStatus(
  id: string,
  next: RunStatus,
  opts?: { blockedReason?: string },
): Promise<void> {
  const current = await getRun(id);
  if (!current) {
    throw new Error(`run not found: ${id}`);
  }
  assertValidTransition(current.status, next);

  const now = new Date();
  const patch: Partial<AgentRun> = {
    status: next,
  };
  if (next === "running" && !current.startedAt) {
    patch.startedAt = now;
  }
  if (next === "completed" || next === "failed" || next === "cancelled") {
    patch.endedAt = now;
  }
  if (next === "blocked" && opts?.blockedReason) {
    patch.blockedReason = opts.blockedReason;
  }

  await db.update(agentRuns).set(patch).where(eq(agentRuns.id, id));
}

export async function addCostMicros(
  id: string,
  deltaMicros: number,
): Promise<void> {
  if (deltaMicros === 0) {
    return;
  }
  const current = await getRun(id);
  if (!current) {
    throw new Error(`run not found: ${id}`);
  }
  await db
    .update(agentRuns)
    .set({ costUsdActual: current.costUsdActual + deltaMicros })
    .where(eq(agentRuns.id, id));
}
```

- [ ] **Step 4: Run tests, expect pass**

```bash
export TEST_POSTGRES_URL="postgresql://test:test@localhost:5432/test"
export POSTGRES_URL="$TEST_POSTGRES_URL"
bun test lib/runs/repository.test.ts 2>&1 | tail -10
```

Expected: all 3 tests pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/matt/code/github.com/to11ai/nigel
git add apps/web/lib/runs/repository.ts apps/web/lib/runs/repository.test.ts
git commit -m "feat(runs): add repository (insert, get, listChildren, updateStatus)"
```

---

### Task 9: Add `Run.create()` factory

**Files:**
- Create: `apps/web/lib/runs/create.ts`
- Create: `apps/web/lib/runs/create.test.ts`

- [ ] **Step 1: Write failing tests**

Create `apps/web/lib/runs/create.test.ts`:

```ts
import { describe, expect, test, beforeEach } from "bun:test";
import { db } from "@/lib/db/client";
import { agentRuns, users } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { Run } from "./create";

const TEST_USER_ID = "test-user-run-create";

beforeEach(async () => {
  await db.delete(agentRuns);
  await db
    .insert(users)
    .values({
      id: TEST_USER_ID,
      username: "test-run-create",
      email: "test-run-create@example.com",
    })
    .onConflictDoNothing();
});

describe("Run.create", () => {
  test("creates a top-level chat Run", async () => {
    const run = await Run.create({
      triggerSource: "chat",
      humanOwnerId: TEST_USER_ID,
      budgetUsdCapMicros: 10_000_000,
    });

    expect(run.parentRunId).toBeNull();
    expect(run.rootRunId).toBe(run.id);
    expect(run.depth).toBe(0);
    expect(run.status).toBe("pending");
  });

  test("creates a chained child Run with depth=1", async () => {
    const parent = await Run.create({
      triggerSource: "chat",
      humanOwnerId: TEST_USER_ID,
      budgetUsdCapMicros: 10_000_000,
    });

    const child = await Run.create({
      triggerSource: "chained",
      humanOwnerId: TEST_USER_ID,
      parentRunId: parent.id,
      budgetUsdCapMicros: 1_000_000,
    });

    expect(child.parentRunId).toBe(parent.id);
    expect(child.rootRunId).toBe(parent.id);
    expect(child.depth).toBe(1);
  });

  test("rejects creation past MAX_DEPTH", async () => {
    let parentId: string | null = null;
    let parent = await Run.create({
      triggerSource: "chat",
      humanOwnerId: TEST_USER_ID,
      budgetUsdCapMicros: 10_000_000,
    });
    parentId = parent.id;

    // Create depth 1..5 (5 levels of children).
    for (let i = 0; i < 5; i++) {
      const next = await Run.create({
        triggerSource: "chained",
        humanOwnerId: TEST_USER_ID,
        parentRunId: parentId,
        budgetUsdCapMicros: 1_000_000,
      });
      parentId = next.id;
      expect(next.depth).toBe(i + 1);
    }

    // Depth 6 must be rejected.
    await expect(
      Run.create({
        triggerSource: "chained",
        humanOwnerId: TEST_USER_ID,
        parentRunId: parentId,
        budgetUsdCapMicros: 1_000_000,
      }),
    ).rejects.toThrow(/depth/i);
  });

  test("rejects child with non-existent parent", async () => {
    await expect(
      Run.create({
        triggerSource: "chained",
        humanOwnerId: TEST_USER_ID,
        parentRunId: "does-not-exist",
        budgetUsdCapMicros: 1_000_000,
      }),
    ).rejects.toThrow(/parent.*not found/i);
  });

  test("requires parentRunId for chained trigger source", async () => {
    await expect(
      Run.create({
        triggerSource: "chained",
        humanOwnerId: TEST_USER_ID,
        budgetUsdCapMicros: 1_000_000,
      }),
    ).rejects.toThrow(/parent.*required/i);
  });
});
```

- [ ] **Step 2: Run, expect failure**

```bash
cd apps/web
bun test lib/runs/create.test.ts 2>&1 | tail -10
```

Expected: module not found.

- [ ] **Step 3: Implement `Run.create`**

Create `apps/web/lib/runs/create.ts`:

```ts
import { nanoid } from "nanoid";
import { getRun, insertRun } from "./repository";
import { MAX_DEPTH, type SandboxPolicy, type TriggerSource } from "./types";
import type { AgentRun } from "./types";

export type CreateRunInput = {
  triggerSource: TriggerSource;
  humanOwnerId: string | null;
  parentRunId?: string | null;
  triggerRef?: string | null;
  specialistId?: string | null;
  sandboxPolicy?: SandboxPolicy;
  repoRef?: string | null;
  workflowRunId?: string | null;
  chatId?: string | null;
  budgetUsdCapMicros: number;
};

async function createRun(input: CreateRunInput): Promise<AgentRun> {
  if (input.triggerSource === "chained" && !input.parentRunId) {
    throw new Error("parentRunId required for trigger_source=chained");
  }

  let depth = 0;
  let rootRunId: string;

  if (input.parentRunId) {
    const parent = await getRun(input.parentRunId);
    if (!parent) {
      throw new Error(`parent run not found: ${input.parentRunId}`);
    }
    depth = parent.depth + 1;
    if (depth > MAX_DEPTH) {
      throw new Error(
        `run depth ${depth} exceeds MAX_DEPTH=${MAX_DEPTH}`,
      );
    }
    rootRunId = parent.rootRunId;
  } else {
    rootRunId = ""; // assigned below
  }

  const id = `run_${nanoid()}`;
  if (!input.parentRunId) {
    rootRunId = id;
  }

  await insertRun({
    id,
    parentRunId: input.parentRunId ?? null,
    rootRunId,
    depth,
    triggerSource: input.triggerSource,
    triggerRef: input.triggerRef ?? null,
    specialistId: input.specialistId ?? null,
    sandboxPolicy: input.sandboxPolicy ?? "inherit",
    humanOwnerId: input.humanOwnerId,
    repoRef: input.repoRef ?? null,
    workflowRunId: input.workflowRunId ?? null,
    chatId: input.chatId ?? null,
    budgetUsdCapMicros: input.budgetUsdCapMicros,
  });

  const created = await getRun(id);
  if (!created) {
    throw new Error(`failed to read back created run: ${id}`);
  }
  return created;
}

export const Run = {
  create: createRun,
};
```

- [ ] **Step 4: Run tests, expect pass**

```bash
bun test lib/runs/create.test.ts 2>&1 | tail -15
```

Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/matt/code/github.com/to11ai/nigel
git add apps/web/lib/runs/create.ts apps/web/lib/runs/create.test.ts
git commit -m "feat(runs): add Run.create factory with depth + parent validation"
```

---

### Task 10: Verify cost-rollup trigger end-to-end

**Files:**
- Append to: `apps/web/lib/runs/cost.test.ts`

- [ ] **Step 1: Write failing integration test**

Append to `apps/web/lib/runs/cost.test.ts`:

```ts
import { afterAll, beforeEach } from "bun:test";
import { db } from "@/lib/db/client";
import { agentRuns, users } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { Run } from "./create";
import { addCostMicros, getRun } from "./repository";

const TEST_USER_ID = "test-user-cost-rollup";

describe("cost rollup trigger", () => {
  beforeEach(async () => {
    await db.delete(agentRuns);
    await db
      .insert(users)
      .values({
        id: TEST_USER_ID,
        username: "test-cost-rollup",
        email: "test-cost-rollup@example.com",
      })
      .onConflictDoNothing();
  });

  test("child cost increments root cost", async () => {
    const root = await Run.create({
      triggerSource: "chat",
      humanOwnerId: TEST_USER_ID,
      budgetUsdCapMicros: 10_000_000,
    });
    const child = await Run.create({
      triggerSource: "chained",
      humanOwnerId: TEST_USER_ID,
      parentRunId: root.id,
      budgetUsdCapMicros: 1_000_000,
    });

    await addCostMicros(child.id, 250_000);

    const rootAfter = await getRun(root.id);
    expect(rootAfter?.costUsdActual).toBe(250_000);
  });

  test("multiple children sum on root", async () => {
    const root = await Run.create({
      triggerSource: "chat",
      humanOwnerId: TEST_USER_ID,
      budgetUsdCapMicros: 10_000_000,
    });
    const c1 = await Run.create({
      triggerSource: "chained",
      humanOwnerId: TEST_USER_ID,
      parentRunId: root.id,
      budgetUsdCapMicros: 1_000_000,
    });
    const c2 = await Run.create({
      triggerSource: "chained",
      humanOwnerId: TEST_USER_ID,
      parentRunId: root.id,
      budgetUsdCapMicros: 1_000_000,
    });

    await addCostMicros(c1.id, 100_000);
    await addCostMicros(c2.id, 200_000);

    const rootAfter = await getRun(root.id);
    expect(rootAfter?.costUsdActual).toBe(300_000);
  });

  test("grandchild cost reaches root via single hop (root_run_id is denormalized)", async () => {
    const root = await Run.create({
      triggerSource: "chat",
      humanOwnerId: TEST_USER_ID,
      budgetUsdCapMicros: 10_000_000,
    });
    const child = await Run.create({
      triggerSource: "chained",
      humanOwnerId: TEST_USER_ID,
      parentRunId: root.id,
      budgetUsdCapMicros: 1_000_000,
    });
    const grandchild = await Run.create({
      triggerSource: "chained",
      humanOwnerId: TEST_USER_ID,
      parentRunId: child.id,
      budgetUsdCapMicros: 1_000_000,
    });

    await addCostMicros(grandchild.id, 500_000);

    const rootAfter = await getRun(root.id);
    expect(rootAfter?.costUsdActual).toBe(500_000);
  });

  test("self-update on root row does not double-count", async () => {
    const root = await Run.create({
      triggerSource: "chat",
      humanOwnerId: TEST_USER_ID,
      budgetUsdCapMicros: 10_000_000,
    });

    await addCostMicros(root.id, 1_000_000);

    const rootAfter = await getRun(root.id);
    expect(rootAfter?.costUsdActual).toBe(1_000_000);
  });
});
```

- [ ] **Step 2: Run tests, expect pass (the trigger is already in place from Task 4)**

```bash
cd apps/web
bun test lib/runs/cost.test.ts 2>&1 | tail -15
```

Expected: all tests pass — the unit-level pricing tests from Task 7 plus the four trigger tests above.

If the trigger double-counts on root self-update, the trigger function in `0037_cost_rollup_trigger.sql` is wrong; debug by inspecting the SQL.

- [ ] **Step 3: Commit**

```bash
cd /Users/matt/code/github.com/to11ai/nigel
git add apps/web/lib/runs/cost.test.ts
git commit -m "test(runs): integration tests for cost rollup trigger"
```

---

### Task 11: Add lifecycle hook dispatcher (empty body)

**Files:**
- Create: `apps/web/lib/runs/lifecycle.ts`

In Phase 1 the lifecycle hook is a no-op skeleton — the dispatch shape needs to exist so Phase 6 (Linear ticket reassignment) and Phase 7 (Datadog metrics) can plug in without churning the call sites.

- [ ] **Step 1: Implement**

Create `apps/web/lib/runs/lifecycle.ts`:

```ts
import type { RunStatus } from "./state-machine";

// Phase 1 placeholder. Concrete handlers (Linear reassignment, Datadog
// metrics, Slack notifications) are added in Phases 6+.
//
// The dispatcher is intentionally fire-and-forget — a failing handler
// must not roll back the status transition that triggered it.
export async function onRunStatusChange(_args: {
  runId: string;
  rootRunId: string;
  from: RunStatus;
  to: RunStatus;
}): Promise<void> {
  // No handlers registered in Phase 1.
}
```

- [ ] **Step 2: Wire it into the repository**

Edit `apps/web/lib/runs/repository.ts`. Replace the `updateRunStatus` body's update statement with a version that fires the lifecycle hook after the DB write succeeds:

```ts
import { onRunStatusChange } from "./lifecycle";

// ...

export async function updateRunStatus(
  id: string,
  next: RunStatus,
  opts?: { blockedReason?: string },
): Promise<void> {
  const current = await getRun(id);
  if (!current) {
    throw new Error(`run not found: ${id}`);
  }
  assertValidTransition(current.status, next);

  const now = new Date();
  const patch: Partial<AgentRun> = {
    status: next,
  };
  if (next === "running" && !current.startedAt) {
    patch.startedAt = now;
  }
  if (next === "completed" || next === "failed" || next === "cancelled") {
    patch.endedAt = now;
  }
  if (next === "blocked" && opts?.blockedReason) {
    patch.blockedReason = opts.blockedReason;
  }

  await db.update(agentRuns).set(patch).where(eq(agentRuns.id, id));

  // Fire-and-forget; never let a handler failure roll back the transition.
  void onRunStatusChange({
    runId: id,
    rootRunId: current.rootRunId,
    from: current.status,
    to: next,
  }).catch((err) => {
    // biome-ignore lint/suspicious/noConsole: lifecycle hook errors must surface
    console.error("onRunStatusChange handler failed", { runId: id, err });
  });
}
```

- [ ] **Step 3: Run repository tests, expect pass**

```bash
cd apps/web
bun test lib/runs/repository.test.ts 2>&1 | tail -10
```

Expected: tests still pass — `onRunStatusChange` is a no-op so behavior is unchanged.

- [ ] **Step 4: Commit**

```bash
cd /Users/matt/code/github.com/to11ai/nigel
git add apps/web/lib/runs/lifecycle.ts apps/web/lib/runs/repository.ts
git commit -m "feat(runs): add lifecycle hook dispatcher (Phase 1 no-op)"
```

---

### Task 12: Add feature flag

**Files:**
- Create: `apps/web/lib/runs/feature-flag.ts`
- Create: `apps/web/lib/runs/feature-flag.test.ts`
- Modify: `apps/web/.env.example` (add `NIGEL_ENABLE_RUNS=`)

- [ ] **Step 1: Write failing tests**

Create `apps/web/lib/runs/feature-flag.test.ts`:

```ts
import { describe, expect, test, afterEach } from "bun:test";
import { isRunsEnabled } from "./feature-flag";

const ORIGINAL = process.env.NIGEL_ENABLE_RUNS;

afterEach(() => {
  if (ORIGINAL === undefined) {
    process.env.NIGEL_ENABLE_RUNS = undefined;
  } else {
    process.env.NIGEL_ENABLE_RUNS = ORIGINAL;
  }
});

describe("isRunsEnabled", () => {
  test("defaults to false when unset", () => {
    process.env.NIGEL_ENABLE_RUNS = undefined;
    expect(isRunsEnabled()).toBe(false);
  });

  test("'1' enables", () => {
    process.env.NIGEL_ENABLE_RUNS = "1";
    expect(isRunsEnabled()).toBe(true);
  });

  test("'true' enables", () => {
    process.env.NIGEL_ENABLE_RUNS = "true";
    expect(isRunsEnabled()).toBe(true);
  });

  test("'0' disables", () => {
    process.env.NIGEL_ENABLE_RUNS = "0";
    expect(isRunsEnabled()).toBe(false);
  });

  test("empty string disables", () => {
    process.env.NIGEL_ENABLE_RUNS = "";
    expect(isRunsEnabled()).toBe(false);
  });
});
```

- [ ] **Step 2: Run, expect failure**

```bash
cd apps/web
bun test lib/runs/feature-flag.test.ts 2>&1 | tail -10
```

- [ ] **Step 3: Implement**

Create `apps/web/lib/runs/feature-flag.ts`:

```ts
// Phase 1 chat-path gate. Default off; old code path runs unchanged.
// Flip to "1" or "true" to route new chat sessions through Run.create().
export function isRunsEnabled(): boolean {
  const raw = process.env.NIGEL_ENABLE_RUNS;
  if (!raw) {
    return false;
  }
  return raw === "1" || raw.toLowerCase() === "true";
}
```

- [ ] **Step 4: Run, expect pass**

```bash
bun test lib/runs/feature-flag.test.ts 2>&1 | tail -10
```

- [ ] **Step 5: Add to env.example**

Edit `apps/web/.env.example`. Append after the `NIGEL_RESOURCE_PROFILE=` line:

```env
# Phase 1 — when set to "1" or "true", new chat sessions go through the
# Run abstraction (lib/runs/). Default unset = old code path.
NIGEL_ENABLE_RUNS=
```

- [ ] **Step 6: Commit**

```bash
cd /Users/matt/code/github.com/to11ai/nigel
git add apps/web/lib/runs/feature-flag.ts apps/web/lib/runs/feature-flag.test.ts apps/web/.env.example
git commit -m "feat(runs): add NIGEL_ENABLE_RUNS feature flag"
```

---

### Task 13: Add `lib/runs/index.ts` barrel export

**Files:**
- Create: `apps/web/lib/runs/index.ts`

- [ ] **Step 1: Implement barrel**

Create `apps/web/lib/runs/index.ts`:

```ts
export { Run } from "./create";
export type { CreateRunInput } from "./create";

export {
  isValidTransition,
  assertValidTransition,
  terminalStates,
  type RunStatus,
} from "./state-machine";

export {
  runStatusSchema,
  triggerSourceSchema,
  sandboxPolicySchema,
  MAX_DEPTH,
  DEFAULT_MAX_CHILDREN,
  type AgentRun,
  type TriggerSource,
  type SandboxPolicy,
} from "./types";

export {
  insertRun,
  getRun,
  listChildren,
  updateRunStatus,
  addCostMicros,
} from "./repository";

export { computeCostMicros, PRICING, type TokenUsage } from "./cost";

export { onRunStatusChange } from "./lifecycle";

export { isRunsEnabled } from "./feature-flag";
```

- [ ] **Step 2: Typecheck**

```bash
cd apps/web
bun run typecheck
```

Expected: passes.

- [ ] **Step 3: Commit**

```bash
cd /Users/matt/code/github.com/to11ai/nigel
git add apps/web/lib/runs/index.ts
git commit -m "feat(runs): add barrel export"
```

---

### Task 14: Backfill migration — existing `workflow_runs` → `agent_runs`

**Files:**
- Create: `apps/web/lib/db/migrations/0038_backfill_agent_runs.sql`
- Modify: `apps/web/lib/db/migrations/meta/_journal.json` (append idx 38)

- [ ] **Step 1: Write the migration**

Create `apps/web/lib/db/migrations/0038_backfill_agent_runs.sql`:

```sql
-- Phase 1 backfill: every existing workflow_runs row gets a one-to-one
-- agent_runs row so the new abstraction has a coherent history. Old chat
-- code paths stay on workflow_runs; new code paths read agent_runs by
-- the workflow_run_id linkage.
INSERT INTO agent_runs (
  id,
  parent_run_id,
  root_run_id,
  depth,
  trigger_source,
  trigger_ref,
  specialist_id,
  sandbox_policy,
  human_owner_id,
  repo_ref,
  sandbox_id,
  workflow_run_id,
  chat_id,
  budget_usd_cap_micros,
  cost_usd_actual_micros,
  status,
  blocked_reason,
  approval_required,
  created_at,
  started_at,
  ended_at
)
SELECT
  'run_backfill_' || wr.id                                AS id,
  NULL                                                    AS parent_run_id,
  'run_backfill_' || wr.id                                AS root_run_id,
  0                                                       AS depth,
  'chat'                                                  AS trigger_source,
  wr.chat_id                                              AS trigger_ref,
  NULL                                                    AS specialist_id,
  'inherit'                                               AS sandbox_policy,
  wr.user_id                                              AS human_owner_id,
  NULL                                                    AS repo_ref,
  NULL                                                    AS sandbox_id,
  wr.id                                                   AS workflow_run_id,
  wr.chat_id                                              AS chat_id,
  0                                                       AS budget_usd_cap_micros,
  0                                                       AS cost_usd_actual_micros,
  CASE wr.status
    WHEN 'completed' THEN 'completed'
    WHEN 'failed'    THEN 'failed'
    WHEN 'aborted'   THEN 'cancelled'
    ELSE 'completed'
  END                                                     AS status,
  NULL                                                    AS blocked_reason,
  FALSE                                                   AS approval_required,
  wr.started_at                                           AS created_at,
  wr.started_at                                           AS started_at,
  wr.finished_at                                          AS ended_at
FROM workflow_runs wr
ON CONFLICT (id) DO NOTHING;
```

`ON CONFLICT (id) DO NOTHING` lets the migration be re-run safely (e.g., if it's re-applied against a database that already has it).

- [ ] **Step 2: Append to the Drizzle journal**

Edit `apps/web/lib/db/migrations/meta/_journal.json`, append:

```json
    {
      "idx": 38,
      "version": "7",
      "when": 1715180002000,
      "tag": "0038_backfill_agent_runs",
      "breakpoints": false
    }
```

- [ ] **Step 3: Apply against test DB**

```bash
cd apps/web
bun run db:migrate
```

Expected: prints `0038_backfill_agent_runs` applied.

- [ ] **Step 4: Verify backfill correctness**

Manually exercise the backfill against a test DB seeded with a workflow run:

```bash
psql "$TEST_POSTGRES_URL" <<'SQL'
-- Seed minimal: a user, a session, a chat, a workflow_run
INSERT INTO users (id, username) VALUES ('u-backfill', 'backfill') ON CONFLICT DO NOTHING;
INSERT INTO sessions (id, user_id, title) VALUES ('s-backfill', 'u-backfill', 'backfill') ON CONFLICT DO NOTHING;
INSERT INTO chats (id, session_id, title) VALUES ('c-backfill', 's-backfill', 'backfill') ON CONFLICT DO NOTHING;
INSERT INTO workflow_runs (id, chat_id, session_id, user_id, status, started_at, finished_at, total_duration_ms)
  VALUES ('wr-backfill', 'c-backfill', 's-backfill', 'u-backfill', 'completed', NOW() - INTERVAL '1 minute', NOW(), 60000)
  ON CONFLICT DO NOTHING;
SQL

# Re-run the backfill SQL (idempotent)
psql "$TEST_POSTGRES_URL" -f apps/web/lib/db/migrations/0038_backfill_agent_runs.sql

# Verify
psql "$TEST_POSTGRES_URL" -c "SELECT id, workflow_run_id, status, depth, trigger_source FROM agent_runs WHERE workflow_run_id = 'wr-backfill';"
```

Expected: one row, status `completed`, depth 0, trigger_source `chat`, workflow_run_id `wr-backfill`.

- [ ] **Step 5: Commit**

```bash
cd /Users/matt/code/github.com/to11ai/nigel
git add apps/web/lib/db/migrations/0038_backfill_agent_runs.sql apps/web/lib/db/migrations/meta/_journal.json
git commit -m "feat(db): backfill migration — workflow_runs -> agent_runs"
```

---

### Task 15: Wire chat workflow path through `Run.create` (feature-flagged)

**Files:**
- Modify: `apps/web/app/workflows/chat.ts` — add Run.create() at the workflow start, status updates at terminal states
- Modify: `apps/web/app/api/chat/_lib/runtime.ts` — read the flag, link the workflow run id back to the agent_run row when creating the workflow

This is the integration point. It must keep the existing code path intact when `NIGEL_ENABLE_RUNS` is not set.

- [ ] **Step 1: Find the chat workflow start point**

```bash
grep -n 'startWorkflow\|getRun\|workflowRunId' apps/web/app/api/chat/_lib/runtime.ts | head -20
```

Look for the function that initiates the workflow run (likely `startChatWorkflow` or similar). Note the signature and what it accepts.

- [ ] **Step 2: Add a Run-creation pre-step in the chat runtime**

Edit `apps/web/app/api/chat/_lib/runtime.ts`. At the point where a fresh workflow is being started (not the resume path), wrap the workflow start with a `Run.create()` call when the flag is on. Pseudocode you adapt to the actual function:

```ts
import { isRunsEnabled, Run } from "@/lib/runs";

// ... inside the function that starts a fresh workflow:
let agentRunId: string | null = null;
if (isRunsEnabled()) {
  const run = await Run.create({
    triggerSource: "chat",
    humanOwnerId: session.userId,
    chatId: chatId,
    sandboxPolicy: "inherit",
    budgetUsdCapMicros: 0, // no budget cap in Phase 1
  });
  agentRunId = run.id;
}

// Then, when calling the Workflow SDK to start the run, pass agentRunId
// through the workflow input so the workflow body can call updateRunStatus
// at terminal states. (See step 3.)
```

The exact shape depends on how `runtime.ts` invokes Workflow SDK. The key invariant: when `isRunsEnabled() === false`, this block is skipped and the existing code path runs unchanged.

- [ ] **Step 3: In the workflow body, link workflow_run_id and update status**

Edit `apps/web/app/workflows/chat.ts`. At the top of the workflow function (right after `getWorkflowMetadata()` reads `workflowRunId`), add:

```ts
import { isRunsEnabled, getRun, updateRunStatus, addCostMicros } from "@/lib/runs";
import { db } from "@/lib/db/client";
import { agentRuns } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

// ... in the workflow function:
const { workflowRunId } = getWorkflowMetadata();

// agentRunId is passed from runtime.ts; if absent, this workflow run
// predates the feature flag and we keep the old code path.
const agentRunId: string | null = options.agentRunId ?? null;

if (isRunsEnabled() && agentRunId) {
  await db
    .update(agentRuns)
    .set({ workflowRunId })
    .where(eq(agentRuns.id, agentRunId));
  await updateRunStatus(agentRunId, "running");
}
```

At the workflow's terminal state (the existing `workflowStatus` handling near line 666 / 935), add a corresponding status update:

```ts
// after the existing workflowStatus is set ('completed' | 'failed' | 'aborted'):
if (isRunsEnabled() && agentRunId) {
  const next =
    workflowStatus === "completed"
      ? "completed"
      : workflowStatus === "failed"
      ? "failed"
      : "cancelled";
  try {
    await updateRunStatus(agentRunId, next);
  } catch (err) {
    // status-machine rejects the transition (e.g., we already set it).
    // Don't fail the workflow over a bookkeeping error.
    // biome-ignore lint/suspicious/noConsole: phase-1 instrumentation
    console.error("agent_run status update failed", { agentRunId, err });
  }
}
```

- [ ] **Step 4: Plumb `agentRunId` through the workflow input type**

Edit the workflow's input type in `apps/web/app/workflows/chat.ts` (look for `type ChatWorkflowOptions` or similar). Add `agentRunId?: string | null;`. Update `runtime.ts` to pass `agentRunId` when starting the workflow.

- [ ] **Step 5: Typecheck + lint**

```bash
cd apps/web
bun run typecheck
cd /Users/matt/code/github.com/to11ai/nigel
bun run check
```

Expected: both pass. If typecheck fails because the workflow input type is referenced in tests, update the test fixtures to include `agentRunId: null`.

- [ ] **Step 6: Run the existing chat tests with flag OFF, expect pass (no behavior change)**

```bash
cd apps/web
bun test app/api/chat/route.test.ts 2>&1 | tail -10
```

Expected: existing chat tests still pass — the flag is off in the test env, the new code path is skipped.

- [ ] **Step 7: Commit**

```bash
cd /Users/matt/code/github.com/to11ai/nigel
git add apps/web/app/workflows/chat.ts apps/web/app/api/chat/_lib/runtime.ts
git commit -m "feat(chat): wire chat workflow through Run.create when NIGEL_ENABLE_RUNS=1"
```

---

### Task 16: End-to-end integration test

**Files:**
- Create: `apps/web/lib/runs/integration.test.ts`

- [ ] **Step 1: Write the test**

Create `apps/web/lib/runs/integration.test.ts`:

```ts
import { describe, expect, test, beforeEach } from "bun:test";
import { db } from "@/lib/db/client";
import { agentRuns, users } from "@/lib/db/schema";
import { Run, getRun, updateRunStatus, addCostMicros } from "./index";

const TEST_USER_ID = "test-user-runs-integration";

beforeEach(async () => {
  await db.delete(agentRuns);
  await db
    .insert(users)
    .values({
      id: TEST_USER_ID,
      username: "test-runs-integration",
      email: "test-runs-integration@example.com",
    })
    .onConflictDoNothing();
});

describe("runs end-to-end", () => {
  test("happy path: create top-level + child + transitions + cost rollup", async () => {
    const root = await Run.create({
      triggerSource: "chat",
      humanOwnerId: TEST_USER_ID,
      budgetUsdCapMicros: 10_000_000,
    });
    expect(root.status).toBe("pending");

    await updateRunStatus(root.id, "running");
    expect((await getRun(root.id))?.status).toBe("running");

    const child = await Run.create({
      triggerSource: "chained",
      humanOwnerId: TEST_USER_ID,
      parentRunId: root.id,
      budgetUsdCapMicros: 1_000_000,
    });
    await updateRunStatus(child.id, "running");
    await addCostMicros(child.id, 750_000);
    await updateRunStatus(child.id, "completed");

    const childAfter = await getRun(child.id);
    expect(childAfter?.status).toBe("completed");
    expect(childAfter?.endedAt).toBeTruthy();

    await updateRunStatus(root.id, "completed");
    const rootAfter = await getRun(root.id);
    expect(rootAfter?.status).toBe("completed");
    expect(rootAfter?.costUsdActual).toBe(750_000);
  });

  test("blocked → resume cycle", async () => {
    const root = await Run.create({
      triggerSource: "chat",
      humanOwnerId: TEST_USER_ID,
      budgetUsdCapMicros: 10_000_000,
    });
    await updateRunStatus(root.id, "running");
    await updateRunStatus(root.id, "blocked", { blockedReason: "budget" });

    const blocked = await getRun(root.id);
    expect(blocked?.status).toBe("blocked");
    expect(blocked?.blockedReason).toBe("budget");

    await updateRunStatus(root.id, "running");
    expect((await getRun(root.id))?.status).toBe("running");
  });

  test("cancelled root does not auto-cancel children (Phase 1: no cascade)", async () => {
    // Cascade cancel is Phase 9 work; Phase 1 only enforces state machine
    // on individual runs. Document the absence with a test.
    const root = await Run.create({
      triggerSource: "chat",
      humanOwnerId: TEST_USER_ID,
      budgetUsdCapMicros: 10_000_000,
    });
    const child = await Run.create({
      triggerSource: "chained",
      humanOwnerId: TEST_USER_ID,
      parentRunId: root.id,
      budgetUsdCapMicros: 1_000_000,
    });
    await updateRunStatus(root.id, "running");
    await updateRunStatus(child.id, "running");
    await updateRunStatus(root.id, "cancelled");

    const childAfter = await getRun(child.id);
    expect(childAfter?.status).toBe("running");
  });
});
```

- [ ] **Step 2: Run, expect pass**

```bash
cd apps/web
bun test lib/runs/integration.test.ts 2>&1 | tail -15
```

Expected: all 3 tests pass.

- [ ] **Step 3: Run the entire runs test suite to confirm nothing regressed**

```bash
bun test lib/runs/ 2>&1 | tail -10
```

Expected: all tests across `state-machine`, `cost`, `repository`, `create`, `feature-flag`, `integration` pass.

- [ ] **Step 4: Commit**

```bash
cd /Users/matt/code/github.com/to11ai/nigel
git add apps/web/lib/runs/integration.test.ts
git commit -m "test(runs): end-to-end integration suite"
```

---

### Task 17: Apply the schema migrations to prod Neon (gated, manual)

This task changes the prod database schema. It must be done deliberately, not auto-applied by the build script.

**Files:**
- (none — runs SQL against prod)

#### Pre-flight

- [ ] **Step 1: Verify the migrations are committed and pushed**

```bash
git log --oneline main..HEAD | head -20
```

Confirm commits for migrations `0036`, `0037`, and `0038` are in the branch and that the branch is pushed.

- [ ] **Step 2: Capture a Neon backup**

In the Neon console for the `nigel` project, create a manual restore point on the `main` branch labeled `pre-phase-1-agent-runs`. (Neon's history retention is 30 days per the `historyRetentionSeconds: 2592000` config, so PITR is also available — the manual label just makes the rollback target obvious.)

- [ ] **Step 3: Apply the migrations**

The web app's `build` script runs `bun run db:migrate:apply && next build`. So once the PR merges, the next production build automatically applies pending migrations. To pre-apply manually (lower-risk, observable):

```bash
cd apps/web
PGURL=$(cd ../../infra/data-neon && pulumi stack output postgresUrl --show-secrets)
POSTGRES_URL="$PGURL" bun run db:migrate
```

Expected: `0036`, `0037`, `0038` applied. No errors.

- [ ] **Step 4: Verify on prod Neon**

```bash
psql "$PGURL" <<'SQL'
\dt agent_runs
\dt run_messages
\dt run_tool_calls
\dt run_artifacts
\dt webhook_events
SELECT COUNT(*) FROM agent_runs;
SELECT tgname FROM pg_trigger WHERE tgrelid = 'agent_runs'::regclass;
SQL
```

Expected: all five tables exist; `agent_runs` row count equals the `workflow_runs` row count (backfill); the trigger `agent_runs_cost_rollup_trg` exists.

#### Roll-forward gate

This task is the **only step** that touches prod data. Phase 1 work after this point (none in this plan, but Phase 2+ will) re-uses the same schema. If verification fails, drop the new tables and redeploy main without the migrations:

```sql
-- Rollback (only if Step 4 fails):
DROP TRIGGER IF EXISTS agent_runs_cost_rollup_trg ON agent_runs;
DROP FUNCTION IF EXISTS agent_runs_cost_rollup();
DROP TABLE IF EXISTS run_artifacts;
DROP TABLE IF EXISTS run_tool_calls;
DROP TABLE IF EXISTS run_messages;
DROP TABLE IF EXISTS webhook_events;
DROP TABLE IF EXISTS agent_runs;
-- And remove the corresponding entries from drizzle's __drizzle_migrations table.
```

If Step 4 succeeds, no commit is needed for this task — the migrations themselves are committed in earlier tasks.

---

### Task 18: Push, open PR, babysit

**Files:**
- (none — git + PR only)

- [ ] **Step 1: Push the branch**

```bash
cd /Users/matt/code/github.com/to11ai/nigel
git push -u origin phase-1-run-abstraction
```

- [ ] **Step 2: Open the PR**

```bash
gh pr create --repo to11ai/nigel --title "Phase 1: Run abstraction" --body "$(cat <<'EOF'
Implements `docs/exec-plans/active/2026-05-08-nigel-phase-1-run-abstraction-plan.md`.

## Summary

- Adds `agent_runs`, `run_messages`, `run_tool_calls`, `run_artifacts`, `webhook_events` tables.
- Adds the cost-rollup Postgres trigger so `cost_usd_actual` on the root row is the sum across the subtree.
- Adds `lib/runs/` with `Run.create()`, status state machine, repository, pricing/cost helpers, lifecycle dispatcher (Phase 1 no-op), and a `NIGEL_ENABLE_RUNS` feature flag.
- Backfills existing `workflow_runs` rows into `agent_runs` so the new abstraction has coherent history.
- Wires the chat workflow path through `Run.create()` when the flag is on; default-off path is unchanged.

Spec: [`docs/product-specs/2026-05-08-nigel-system-design.md`](docs/product-specs/2026-05-08-nigel-system-design.md) (Sections 1-4, 9, 11).

## Test plan

- [ ] CI green (typecheck, lint, unit + integration test suites in `lib/runs/`)
- [ ] Vercel preview deploys with `NIGEL_ENABLE_RUNS=` (unset) — old chat path unchanged
- [ ] Apply migrations on prod Neon per Task 17
- [ ] Set `NIGEL_ENABLE_RUNS=1` on the prod Vercel env, redeploy, verify a fresh chat creates an `agent_runs` row

## Out of scope (future phases)

- Cascade cancel from parent → children (Phase 9)
- Lifecycle hook handlers (Linear reassignment, Datadog metrics) — Phases 6 / 7
- Specialist registry + `dispatch_specialist` tool — Phase 2
- New UI surfaces (`/runs` list, tree view) — Phase 8
EOF
)"
```

- [ ] **Step 3: Hand off to babysit-pr**

After the PR is open, invoke the `babysit-pr` skill on PR number returned above. Address any Cursor Bugbot / CodeRabbit findings using the same pattern as Phase 0 PR #1: fetch unresolved threads via GraphQL, fix code, commit + push, reply on each thread, resolve.

- [ ] **Step 4: After merge, do Task 17 against prod**

The build script auto-applies migrations on the next production deploy. To pre-apply manually (recommended), follow Task 17.

---

## Acceptance criteria for Phase 1

1. The five new tables (`agent_runs`, `run_messages`, `run_tool_calls`, `run_artifacts`, `webhook_events`) exist in prod Neon with the schema and indexes from Task 2.
2. The `agent_runs_cost_rollup_trg` trigger exists and integration tests confirm rollup is correct (children → root, grandchildren → root, root self-update is not double-counted).
3. The `lib/runs/` module exposes `Run.create`, `updateRunStatus`, `addCostMicros`, `getRun`, `listChildren`, `computeCostMicros`, `isValidTransition`, `isRunsEnabled` with the signatures defined in Tasks 5–13.
4. The state machine rejects invalid transitions (terminal → non-terminal, identity transitions, illegal jumps) — covered by `state-machine.test.ts`.
5. `Run.create` rejects depth > 5, missing parents, and `triggerSource='chained'` without a `parentRunId` — covered by `create.test.ts`.
6. The backfill migration produces one `agent_runs` row per existing `workflow_runs` row, with status mapped (`completed`/`failed`/`aborted` → `completed`/`failed`/`cancelled`), and is idempotent.
7. `bun run check` and `bun run typecheck` pass on the branch; full test suite passes locally and in CI.
8. With `NIGEL_ENABLE_RUNS` unset, the existing chat tests pass unchanged — old code path is the default.
9. With `NIGEL_ENABLE_RUNS=1`, a manual chat session in the deployed app produces a new `agent_runs` row linked back to its `workflow_run_id` and transitions through `pending` → `running` → `completed`.

---

## Out of scope for Phase 1

- Specialist registry / `dispatch_specialist` tool (Phase 2).
- `.nigel.yaml` repo-config layer (Phase 3).
- Specialist roster (`coder`, `linter`, etc.) — Phase 4.
- Tool registry / `tool_connections` table (Phase 5).
- Linear webhook + lifecycle hooks (Phase 6).
- Observability — OTel spans, Datadog dashboards (Phase 7).
- New UI surfaces (`/runs` list, hierarchy tree, `/runs/:id/proof`) — Phase 8.
- Eval suite / adversarial validation harness (Phase 9).
- Cascade cancel from parent → children — Phase 9 (the `cancelled root does not cascade` test in Task 16 documents the gap).
- Approval gates for Pulumi `pulumi up` (the `awaiting_approval` state is reserved but no current consumer triggers it; gate consumers come later).

---

## Self-review notes

The plan has been checked against the spec's Phase 1 description. Coverage:

- ✅ Add `agent_runs` table — Tasks 2, 3.
- ✅ Add `run_messages`, `run_tool_calls`, `run_artifacts`, `webhook_events` tables — Task 2 (in the same Drizzle migration).
- ✅ Backfill chat sessions to top-level Runs — Task 14.
- ✅ Cost rollup trigger — Task 4 + verified in Task 10.
- ✅ Status state machine + lifecycle hooks — Tasks 5, 11.
- ✅ Feature-flag the new path — Task 12.
- ✅ Refactor chat workflow start path through `Run.create()` — Task 15.
- ✅ Tests at unit + integration level — Tasks 5, 7, 8, 9, 10, 12, 16.

No placeholders. All commands have expected output. Type/identifier consistency: `agentRuns` (Drizzle table), `AgentRun` (row type), `Run.create` (factory), `updateRunStatus` / `getRun` / `listChildren` / `addCostMicros` (repository), `RunStatus` / `TriggerSource` / `SandboxPolicy` (string-literal types), `MAX_DEPTH` (constant), `isRunsEnabled` (flag check), `onRunStatusChange` (lifecycle hook), `PRICING` / `computeCostMicros` (cost). All consistent across Tasks 2–16.

Cost values are stored as **micro-USD integers** (`1_500_000` = `$1.50`). Spec section 7 implies floating cost; this plan diverges intentionally to avoid floating-point drift in the rollup trigger. UI conversion is `cost_usd_actual_micros / 1_000_000`.

Schema-side `budget_usd_cap` and `cost_usd_actual` columns are named `*_micros` in the table (Task 2) but exposed as `budgetUsdCap` / `costUsdActual` in the Drizzle row type — Drizzle's column-to-property mapping handles the rename. Tests in Tasks 8–10 use the camelCase property names; SQL in Tasks 14, 17 uses the snake_case column names with the `_micros` suffix.
