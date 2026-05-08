# Nigel Phase 2: Specialist Registry + Dispatch Primitive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the specialist registry (`specialists` table + code presets + resolver), the `dispatchSpecialist` / `dispatchSpecialistsParallel` primitives, and root-level budget-enforcement helpers, so Phase 4's specialist roster can plug in without churning core primitives. Ships one trivial scripted preset (`echo`) so dispatch can be exercised end-to-end without an LLM in the loop.

**Architecture:** A `specialists` table stores `kind='custom'` rows (admin-created roles with no code counterpart) and `kind='override'` rows (admin-tweaked partial fields applied on top of a code preset). A `lib/specialists/` module owns presets-as-code (`presets.ts`), the merge resolver (`resolver.ts`), Drizzle CRUD (`repository.ts`), and a barrel. A `lib/runs/dispatch.ts` exposes `dispatchSpecialist` (creates a child `Run`, validates depth/recurse/max-children/budget, executes the specialist if it's `scripted`) and `dispatchSpecialistsParallel` (Promise.all over child Runs). `lib/runs/budget.ts` exposes `checkRootBudget(rootRunId)` (throws + transitions root to `blocked` when `cost ≥ cap`) and `chargeRunCost(runId, micros)` (atomic increment via the existing `addCostMicros`). LLM-driven specialist execution is intentionally NOT in this phase — Phase 4 wires per-specialist Workflow SDK handlers.

**Tech Stack:** Drizzle ORM + Drizzle Kit, Postgres (Neon), Bun test runner, Workflow SDK (only the budget-check call site; no new step functions). Spec: [../../product-specs/2026-05-08-nigel-system-design.md](../../product-specs/2026-05-08-nigel-system-design.md) (Sections 2, 4, 11 — Phase 2 row).

---

## File structure

| File | Purpose |
|---|---|
| `apps/web/lib/db/schema.ts` (modify) | Add `specialists` table next to existing tables |
| `apps/web/lib/db/migrations/0041_specialists.sql` (new, generated) | Drizzle-generated DDL |
| `apps/web/lib/db/migrations/meta/_journal.json` (modify, auto) | Drizzle journal entry |
| `apps/web/lib/db/migrations/meta/0041_snapshot.json` (new, generated) | Drizzle snapshot |
| `apps/web/lib/specialists/types.ts` (new) | `Specialist` type, `SpecialistKind` enum, runtime-resolved `ResolvedSpecialist` shape |
| `apps/web/lib/specialists/presets.ts` (new) | `PRESETS` map; one `echo` scripted preset |
| `apps/web/lib/specialists/resolver.ts` (new) | `getSpecialist(name)` — code preset > override (merged) > custom |
| `apps/web/lib/specialists/resolver.test.ts` (new) | Unit + integration tests for resolver merge order |
| `apps/web/lib/specialists/repository.ts` (new) | Drizzle CRUD: `upsertCustomSpecialist`, `upsertOverride`, `deleteOverride`, `listSpecialists` |
| `apps/web/lib/specialists/repository.test.ts` (new) | Integration tests for CRUD against test Postgres |
| `apps/web/lib/specialists/index.ts` (new) | Barrel — re-exports the public surface |
| `apps/web/lib/runs/budget.ts` (new) | `checkRootBudget(rootRunId)` + `chargeRunCost(runId, micros)` |
| `apps/web/lib/runs/budget.test.ts` (new) | Integration tests for budget enforcement |
| `apps/web/lib/runs/dispatch.ts` (new) | `dispatchSpecialist`, `dispatchSpecialistsParallel` |
| `apps/web/lib/runs/dispatch.test.ts` (new) | Integration tests for dispatch (echo + validation + parallel + budget) |
| `apps/web/lib/runs/index.ts` (modify) | Re-export the new dispatch helpers |

---

## Prerequisites

- Phase 1 merged to `main`. The `agent_runs` table exists, the cost-rollup trigger is live, `Run.create` works, the `lib/runs/` module is in place. Verify with `git log --oneline -3` shows the Phase 1 squash-merge commit `73e4d1cd`.
- Local Postgres at `postgresql://test:test@localhost:5433/test` with Phase 1 migrations applied. (Already running from Phase 1 babysit work; verify with `psql ... -c '\dt agent_runs'`.)
- `bun install` clean on `main`; `bun run check` and `bun run typecheck` pass.

---

### Task 1: Branch + clean baseline

**Files:**
- (none — git only)

- [ ] **Step 1: Create the feature branch off main**

```bash
cd /Users/matt/code/github.com/to11ai/nigel
git checkout main
git pull origin main
git checkout -b phase-2-specialist-registry
```

- [ ] **Step 2: Verify clean baseline**

```bash
bun install
bun run typecheck
bun run check
POSTGRES_URL="postgresql://test:test@localhost:5433/test" bun test --cwd apps/web lib/runs/
```

Expected: install completes, typecheck + lint clean, runs tests (36 from Phase 1) all pass. If any fails, fix on `main` before starting Phase 2.

---

### Task 2: Add `specialists` schema (Drizzle)

**Files:**
- Modify: `apps/web/lib/db/schema.ts` — append `specialists` table after `agentRuns` block

- [ ] **Step 1: Append the schema block**

Edit `apps/web/lib/db/schema.ts`. After the `webhookEvents` block (the last Phase 1 table, around line ~445), insert:

```ts
// specialists — admin-managed registry. Two kinds:
//   - "custom": admin-created role with no code counterpart. All fields
//     populated.
//   - "override": admin tweak to a code preset (lib/specialists/presets.ts).
//     Only `fields` populated — non-null entries override the preset.
// Resolution order at runtime: code preset > override (merged) > custom.
// `name` must match the code preset's name when kind='override'.
export const specialists = pgTable(
  "specialists",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    kind: text("kind", { enum: ["custom", "override"] }).notNull(),

    systemPrompt: text("system_prompt"),
    model: text("model"),
    toolAllowlist: jsonb("tool_allowlist").$type<string[]>(),
    sandboxPolicy: text("sandbox_policy", {
      enum: ["inherit", "fresh", "fresh_clean"],
    }),
    mayRecurse: boolean("may_recurse"),
    maxChildren: integer("max_children"),
    budgetUsdDefaultMicros: bigint("budget_usd_default_micros", {
      mode: "number",
    }),
    needsLocalStack: boolean("needs_local_stack"),

    createdBy: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("specialists_name_idx").on(table.name),
    index("specialists_kind_idx").on(table.kind),
  ],
);
```

The columns are intentionally nullable (except `id`, `name`, `kind`, timestamps) so an `override` row can carry only the fields it changes. The `custom` kind requires the resolver to validate completeness at read time (Task 6).

- [ ] **Step 2: Verify schema typechecks**

```bash
bun run typecheck
```

Expected: passes. `bigint`, `boolean`, `index`, `integer`, `jsonb`, `pgTable`, `text`, `timestamp`, `uniqueIndex` are already imported from prior phases.

- [ ] **Step 3: Commit**

```bash
git add apps/web/lib/db/schema.ts
git commit -m "feat(db): add specialists schema (Phase 2)"
```

---

### Task 3: Generate the Drizzle migration

**Files:**
- Create: `apps/web/lib/db/migrations/0041_<name>.sql`
- Modify: `apps/web/lib/db/migrations/meta/_journal.json` (auto)
- Create: `apps/web/lib/db/migrations/meta/0041_snapshot.json` (auto)

- [ ] **Step 1: Generate**

```bash
cd /Users/matt/code/github.com/to11ai/nigel/apps/web
bun run db:generate
```

Expected: `0041_<random_name>.sql` created with `CREATE TABLE "specialists"` and the two indexes.

- [ ] **Step 2: Apply against local test DB**

```bash
POSTGRES_URL="postgresql://test:test@localhost:5433/test" bun run db:migrate
```

Expected: migration applied. Verify:

```bash
psql "postgresql://test:test@localhost:5433/test" -c "\d specialists" | head -25
```

Expected: table exists with the listed columns; `specialists_name_idx` (unique) and `specialists_kind_idx` indexes present.

- [ ] **Step 3: Commit**

```bash
cd /Users/matt/code/github.com/to11ai/nigel
git add apps/web/lib/db/migrations/
git commit -m "feat(db): generate 0041 migration for specialists"
```

---

### Task 4: Specialist types module

**Files:**
- Create: `apps/web/lib/specialists/types.ts`

- [ ] **Step 1: Implement**

Create `apps/web/lib/specialists/types.ts`:

```ts
import type { InferSelectModel } from "drizzle-orm";
import type { specialists } from "@/lib/db/schema";
import type { SandboxPolicy } from "@/lib/runs/types";

export type SpecialistKind = "preset" | "custom" | "override" | "scripted";

// A fully-resolved specialist as the dispatch path consumes it.
// Code presets and DB-resolved customs both produce this shape.
export type ResolvedSpecialist = {
  name: string;
  kind: SpecialistKind;
  systemPrompt: string | null;
  model: string | null;
  toolAllowlist: readonly string[];
  sandboxPolicy: SandboxPolicy;
  mayRecurse: boolean;
  maxChildren: number;
  budgetUsdDefaultMicros: number;
  needsLocalStack: boolean;
  // Only populated for kind='scripted' (Phase 2 supports just this case).
  // Returns the specialist's output as a string; throws on failure.
  script?: (task: string) => Promise<string>;
};

// A preset as defined in lib/specialists/presets.ts.
export type CodePreset = ResolvedSpecialist & {
  kind: "preset" | "scripted";
};

// Drizzle-derived row type for the specialists table.
export type SpecialistRow = InferSelectModel<typeof specialists>;

// Override fields that can be applied on top of a code preset.
// Mirrors the nullable columns in `specialists`.
export type SpecialistOverrideFields = {
  systemPrompt?: string | null;
  model?: string | null;
  toolAllowlist?: readonly string[] | null;
  sandboxPolicy?: SandboxPolicy | null;
  mayRecurse?: boolean | null;
  maxChildren?: number | null;
  budgetUsdDefaultMicros?: number | null;
  needsLocalStack?: boolean | null;
};
```

- [ ] **Step 2: Typecheck + commit**

```bash
bun run typecheck
git add apps/web/lib/specialists/types.ts
git commit -m "feat(specialists): add types module"
```

---

### Task 5: Presets file

**Files:**
- Create: `apps/web/lib/specialists/presets.ts`

- [ ] **Step 1: Implement**

Create `apps/web/lib/specialists/presets.ts`:

```ts
import type { CodePreset } from "./types";

// Phase 2 ships exactly one scripted preset so dispatch can be exercised
// end-to-end without an LLM in the loop. The full roster (planner, coder,
// linter, reviewer, etc.) lands in Phase 4.
const echoPreset: CodePreset = {
  name: "echo",
  kind: "scripted",
  systemPrompt: null,
  model: null,
  toolAllowlist: [],
  sandboxPolicy: "fresh",
  mayRecurse: false,
  maxChildren: 0,
  budgetUsdDefaultMicros: 0,
  needsLocalStack: false,
  script: async (task: string) => `echo: ${task}`,
};

// Map of preset name → preset definition. Names must be unique. The
// resolver validates that no DB `override` row references a name absent
// from this map.
export const PRESETS: Readonly<Record<string, CodePreset>> = Object.freeze({
  [echoPreset.name]: echoPreset,
});

export function getPresetNames(): readonly string[] {
  return Object.keys(PRESETS);
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
bun run typecheck
git add apps/web/lib/specialists/presets.ts
git commit -m "feat(specialists): add presets file with echo scripted preset"
```

---

### Task 6: Resolver

**Files:**
- Create: `apps/web/lib/specialists/resolver.ts`
- Create: `apps/web/lib/specialists/resolver.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/web/lib/specialists/resolver.test.ts`:

```ts
import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "@/lib/db/client";
import { specialists } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { getSpecialist } from "./resolver";

beforeEach(async () => {
  await db.delete(specialists);
});

describe("getSpecialist", () => {
  test("returns the code preset when no override or custom row exists", async () => {
    const echo = await getSpecialist("echo");
    expect(echo).not.toBeNull();
    expect(echo?.name).toBe("echo");
    expect(echo?.kind).toBe("scripted");
    expect(echo?.script).toBeDefined();
  });

  test("override row merges partial fields onto the code preset", async () => {
    await db.insert(specialists).values({
      id: nanoid(),
      name: "echo",
      kind: "override",
      sandboxPolicy: "inherit",
      maxChildren: 7,
    });

    const echo = await getSpecialist("echo");
    expect(echo?.sandboxPolicy).toBe("inherit"); // overridden
    expect(echo?.maxChildren).toBe(7); // overridden
    expect(echo?.mayRecurse).toBe(false); // from preset (not overridden)
    expect(echo?.script).toBeDefined(); // script preserved from preset
  });

  test("custom row is returned for names not in PRESETS", async () => {
    await db.insert(specialists).values({
      id: nanoid(),
      name: "my-custom-role",
      kind: "custom",
      systemPrompt: "Be helpful.",
      model: "anthropic/claude-haiku-4-5",
      toolAllowlist: ["file", "search"],
      sandboxPolicy: "inherit",
      mayRecurse: false,
      maxChildren: 3,
      budgetUsdDefaultMicros: 1_000_000,
      needsLocalStack: false,
    });

    const role = await getSpecialist("my-custom-role");
    expect(role?.name).toBe("my-custom-role");
    expect(role?.kind).toBe("custom");
    expect(role?.systemPrompt).toBe("Be helpful.");
    expect(role?.toolAllowlist).toEqual(["file", "search"]);
    expect(role?.script).toBeUndefined();
  });

  test("returns null for an unknown name", async () => {
    const result = await getSpecialist("not-a-real-thing");
    expect(result).toBeNull();
  });

  test("rejects an override row with no matching code preset", async () => {
    await db.insert(specialists).values({
      id: nanoid(),
      name: "no-such-preset",
      kind: "override",
      sandboxPolicy: "fresh",
    });

    await expect(getSpecialist("no-such-preset")).rejects.toThrow(
      /override.*no matching preset/i,
    );
  });

  test("rejects a custom row missing required fields", async () => {
    await db.insert(specialists).values({
      id: nanoid(),
      name: "incomplete-custom",
      kind: "custom",
      // missing systemPrompt, model, toolAllowlist, etc.
    });

    await expect(getSpecialist("incomplete-custom")).rejects.toThrow(
      /custom.*incomplete/i,
    );
  });
});
```

- [ ] **Step 2: Run, expect failure**

```bash
cd /Users/matt/code/github.com/to11ai/nigel/apps/web
POSTGRES_URL="postgresql://test:test@localhost:5433/test" bun test lib/specialists/resolver.test.ts 2>&1 | tail -10
```

Expected: module not found.

- [ ] **Step 3: Implement the resolver**

Create `apps/web/lib/specialists/resolver.ts`:

```ts
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { specialists } from "@/lib/db/schema";
import { PRESETS } from "./presets";
import type {
  CodePreset,
  ResolvedSpecialist,
  SpecialistRow,
} from "./types";

export async function getSpecialist(
  name: string,
): Promise<ResolvedSpecialist | null> {
  const preset = PRESETS[name];
  const rows = await db
    .select()
    .from(specialists)
    .where(eq(specialists.name, name))
    .limit(1);
  const row = rows[0] ?? null;

  if (!row && !preset) {
    return null;
  }

  if (preset && (!row || row.kind === "override")) {
    return mergePreset(preset, row);
  }

  if (!preset && row?.kind === "custom") {
    return rowToCustom(row);
  }

  if (!preset && row?.kind === "override") {
    throw new Error(
      `specialist override has no matching preset in code: ${name}`,
    );
  }

  // Preset exists + row is custom (kind mismatch — shouldn't happen, but
  // surface loudly).
  throw new Error(
    `specialist row has unexpected kind for preset name '${name}': ${row?.kind}`,
  );
}

function mergePreset(
  preset: CodePreset,
  row: SpecialistRow | null,
): ResolvedSpecialist {
  if (!row) {
    return { ...preset };
  }
  return {
    name: preset.name,
    kind: preset.kind,
    systemPrompt: row.systemPrompt ?? preset.systemPrompt,
    model: row.model ?? preset.model,
    toolAllowlist: (row.toolAllowlist ?? preset.toolAllowlist) as readonly string[],
    sandboxPolicy: row.sandboxPolicy ?? preset.sandboxPolicy,
    mayRecurse: row.mayRecurse ?? preset.mayRecurse,
    maxChildren: row.maxChildren ?? preset.maxChildren,
    budgetUsdDefaultMicros:
      row.budgetUsdDefaultMicros ?? preset.budgetUsdDefaultMicros,
    needsLocalStack: row.needsLocalStack ?? preset.needsLocalStack,
    script: preset.script,
  };
}

function rowToCustom(row: SpecialistRow): ResolvedSpecialist {
  const required = {
    systemPrompt: row.systemPrompt,
    model: row.model,
    toolAllowlist: row.toolAllowlist,
    sandboxPolicy: row.sandboxPolicy,
    mayRecurse: row.mayRecurse,
    maxChildren: row.maxChildren,
    budgetUsdDefaultMicros: row.budgetUsdDefaultMicros,
    needsLocalStack: row.needsLocalStack,
  };
  for (const [k, v] of Object.entries(required)) {
    if (v === null || v === undefined) {
      throw new Error(
        `custom specialist '${row.name}' is incomplete — missing field: ${k}`,
      );
    }
  }
  return {
    name: row.name,
    kind: "custom",
    systemPrompt: row.systemPrompt as string,
    model: row.model,
    toolAllowlist: row.toolAllowlist as readonly string[],
    sandboxPolicy: row.sandboxPolicy as ResolvedSpecialist["sandboxPolicy"],
    mayRecurse: row.mayRecurse as boolean,
    maxChildren: row.maxChildren as number,
    budgetUsdDefaultMicros: row.budgetUsdDefaultMicros as number,
    needsLocalStack: row.needsLocalStack as boolean,
  };
}
```

- [ ] **Step 4: Run tests, expect pass**

```bash
POSTGRES_URL="postgresql://test:test@localhost:5433/test" bun test lib/specialists/resolver.test.ts 2>&1 | tail -10
```

Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/matt/code/github.com/to11ai/nigel
git add apps/web/lib/specialists/resolver.ts apps/web/lib/specialists/resolver.test.ts
git commit -m "feat(specialists): add resolver (preset > override > custom)"
```

---

### Task 7: Repository (CRUD)

**Files:**
- Create: `apps/web/lib/specialists/repository.ts`
- Create: `apps/web/lib/specialists/repository.test.ts`

- [ ] **Step 1: Write tests**

Create `apps/web/lib/specialists/repository.test.ts`:

```ts
import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "@/lib/db/client";
import { specialists } from "@/lib/db/schema";
import {
  deleteOverride,
  listSpecialists,
  upsertCustomSpecialist,
  upsertOverride,
} from "./repository";

beforeEach(async () => {
  await db.delete(specialists);
});

describe("specialists repository", () => {
  test("upsertCustomSpecialist creates and updates", async () => {
    const created = await upsertCustomSpecialist({
      name: "my-role",
      systemPrompt: "Be helpful",
      model: "anthropic/claude-haiku-4-5",
      toolAllowlist: ["file"],
      sandboxPolicy: "inherit",
      mayRecurse: false,
      maxChildren: 3,
      budgetUsdDefaultMicros: 1_000_000,
      needsLocalStack: false,
    });
    expect(created.kind).toBe("custom");
    expect(created.systemPrompt).toBe("Be helpful");

    const updated = await upsertCustomSpecialist({
      name: "my-role",
      systemPrompt: "Be very helpful",
      model: "anthropic/claude-haiku-4-5",
      toolAllowlist: ["file", "search"],
      sandboxPolicy: "inherit",
      mayRecurse: false,
      maxChildren: 5,
      budgetUsdDefaultMicros: 2_000_000,
      needsLocalStack: false,
    });
    expect(updated.systemPrompt).toBe("Be very helpful");
    expect(updated.maxChildren).toBe(5);
    expect(updated.id).toBe(created.id);
  });

  test("upsertOverride creates and updates partial overrides", async () => {
    const v1 = await upsertOverride("echo", { sandboxPolicy: "inherit" });
    expect(v1.kind).toBe("override");
    expect(v1.sandboxPolicy).toBe("inherit");

    const v2 = await upsertOverride("echo", {
      sandboxPolicy: "fresh_clean",
      maxChildren: 9,
    });
    expect(v2.id).toBe(v1.id);
    expect(v2.sandboxPolicy).toBe("fresh_clean");
    expect(v2.maxChildren).toBe(9);
  });

  test("deleteOverride removes the row", async () => {
    await upsertOverride("echo", { sandboxPolicy: "inherit" });
    await deleteOverride("echo");
    const all = await listSpecialists();
    expect(all.find((s) => s.name === "echo")).toBeUndefined();
  });

  test("listSpecialists returns rows in name order", async () => {
    await upsertOverride("echo", { sandboxPolicy: "inherit" });
    await upsertCustomSpecialist({
      name: "alpha",
      systemPrompt: "x",
      model: "anthropic/claude-haiku-4-5",
      toolAllowlist: [],
      sandboxPolicy: "fresh",
      mayRecurse: false,
      maxChildren: 0,
      budgetUsdDefaultMicros: 0,
      needsLocalStack: false,
    });
    const rows = await listSpecialists();
    expect(rows.map((r) => r.name)).toEqual(["alpha", "echo"]);
  });
});
```

- [ ] **Step 2: Run, expect failure**

```bash
cd /Users/matt/code/github.com/to11ai/nigel/apps/web
POSTGRES_URL="postgresql://test:test@localhost:5433/test" bun test lib/specialists/repository.test.ts 2>&1 | tail -10
```

Expected: module not found.

- [ ] **Step 3: Implement**

Create `apps/web/lib/specialists/repository.ts`:

```ts
import { asc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db/client";
import { specialists } from "@/lib/db/schema";
import type { SpecialistOverrideFields, SpecialistRow } from "./types";

export type CustomSpecialistInput = {
  name: string;
  systemPrompt: string;
  model: string;
  toolAllowlist: readonly string[];
  sandboxPolicy: "inherit" | "fresh" | "fresh_clean";
  mayRecurse: boolean;
  maxChildren: number;
  budgetUsdDefaultMicros: number;
  needsLocalStack: boolean;
  createdBy?: string | null;
};

export async function upsertCustomSpecialist(
  input: CustomSpecialistInput,
): Promise<SpecialistRow> {
  const existing = await db
    .select()
    .from(specialists)
    .where(eq(specialists.name, input.name))
    .limit(1);
  const row = existing[0];
  const now = new Date();

  if (row) {
    if (row.kind !== "custom") {
      throw new Error(
        `specialist '${input.name}' exists with kind='${row.kind}', expected 'custom'`,
      );
    }
    const updated = await db
      .update(specialists)
      .set({
        systemPrompt: input.systemPrompt,
        model: input.model,
        toolAllowlist: [...input.toolAllowlist],
        sandboxPolicy: input.sandboxPolicy,
        mayRecurse: input.mayRecurse,
        maxChildren: input.maxChildren,
        budgetUsdDefaultMicros: input.budgetUsdDefaultMicros,
        needsLocalStack: input.needsLocalStack,
        updatedAt: now,
      })
      .where(eq(specialists.id, row.id))
      .returning();
    return updated[0];
  }

  const inserted = await db
    .insert(specialists)
    .values({
      id: nanoid(),
      name: input.name,
      kind: "custom",
      systemPrompt: input.systemPrompt,
      model: input.model,
      toolAllowlist: [...input.toolAllowlist],
      sandboxPolicy: input.sandboxPolicy,
      mayRecurse: input.mayRecurse,
      maxChildren: input.maxChildren,
      budgetUsdDefaultMicros: input.budgetUsdDefaultMicros,
      needsLocalStack: input.needsLocalStack,
      createdBy: input.createdBy ?? null,
    })
    .returning();
  return inserted[0];
}

export async function upsertOverride(
  name: string,
  fields: SpecialistOverrideFields,
): Promise<SpecialistRow> {
  const existing = await db
    .select()
    .from(specialists)
    .where(eq(specialists.name, name))
    .limit(1);
  const row = existing[0];
  const now = new Date();

  if (row) {
    if (row.kind !== "override") {
      throw new Error(
        `specialist '${name}' exists with kind='${row.kind}', expected 'override'`,
      );
    }
    const updated = await db
      .update(specialists)
      .set({
        ...normalizeOverrideFields(fields),
        updatedAt: now,
      })
      .where(eq(specialists.id, row.id))
      .returning();
    return updated[0];
  }

  const inserted = await db
    .insert(specialists)
    .values({
      id: nanoid(),
      name,
      kind: "override",
      ...normalizeOverrideFields(fields),
    })
    .returning();
  return inserted[0];
}

export async function deleteOverride(name: string): Promise<void> {
  await db
    .delete(specialists)
    .where(eq(specialists.name, name));
}

export async function listSpecialists(): Promise<SpecialistRow[]> {
  return db.select().from(specialists).orderBy(asc(specialists.name));
}

function normalizeOverrideFields(
  fields: SpecialistOverrideFields,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (fields.systemPrompt !== undefined) out.systemPrompt = fields.systemPrompt;
  if (fields.model !== undefined) out.model = fields.model;
  if (fields.toolAllowlist !== undefined) {
    out.toolAllowlist = fields.toolAllowlist
      ? [...fields.toolAllowlist]
      : null;
  }
  if (fields.sandboxPolicy !== undefined) out.sandboxPolicy = fields.sandboxPolicy;
  if (fields.mayRecurse !== undefined) out.mayRecurse = fields.mayRecurse;
  if (fields.maxChildren !== undefined) out.maxChildren = fields.maxChildren;
  if (fields.budgetUsdDefaultMicros !== undefined) {
    out.budgetUsdDefaultMicros = fields.budgetUsdDefaultMicros;
  }
  if (fields.needsLocalStack !== undefined) {
    out.needsLocalStack = fields.needsLocalStack;
  }
  return out;
}
```

- [ ] **Step 4: Run tests, expect pass**

```bash
POSTGRES_URL="postgresql://test:test@localhost:5433/test" bun test lib/specialists/repository.test.ts 2>&1 | tail -10
```

Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/matt/code/github.com/to11ai/nigel
git add apps/web/lib/specialists/repository.ts apps/web/lib/specialists/repository.test.ts
git commit -m "feat(specialists): add repository (upsert custom/override, delete, list)"
```

---

### Task 8: Specialists barrel

**Files:**
- Create: `apps/web/lib/specialists/index.ts`

- [ ] **Step 1: Implement**

Create `apps/web/lib/specialists/index.ts`:

```ts
export { PRESETS, getPresetNames } from "./presets";
export { getSpecialist } from "./resolver";
export {
  type CustomSpecialistInput,
  deleteOverride,
  listSpecialists,
  upsertCustomSpecialist,
  upsertOverride,
} from "./repository";
export type {
  CodePreset,
  ResolvedSpecialist,
  SpecialistKind,
  SpecialistOverrideFields,
  SpecialistRow,
} from "./types";
```

- [ ] **Step 2: Typecheck + commit**

```bash
bun run typecheck
git add apps/web/lib/specialists/index.ts
git commit -m "feat(specialists): add barrel export"
```

---

### Task 9: Budget enforcement helpers

**Files:**
- Create: `apps/web/lib/runs/budget.ts`
- Create: `apps/web/lib/runs/budget.test.ts`

- [ ] **Step 1: Write tests**

Create `apps/web/lib/runs/budget.test.ts`:

```ts
import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "@/lib/db/client";
import { agentRuns, users } from "@/lib/db/schema";
import { Run } from "./create";
import { addCostMicros, getRun } from "./repository";
import { checkRootBudget } from "./budget";

const TEST_USER_ID = "test-user-budget";

beforeEach(async () => {
  await db.delete(agentRuns);
  await db
    .insert(users)
    .values({
      id: TEST_USER_ID,
      username: "test-budget",
      email: "test-budget@example.com",
    })
    .onConflictDoNothing();
});

describe("checkRootBudget", () => {
  test("passes when cost is below cap", async () => {
    const root = await Run.create({
      triggerSource: "chat",
      humanOwnerId: TEST_USER_ID,
      budgetUsdCapMicros: 1_000_000,
    });
    await addCostMicros(root.id, 500_000);
    await expect(checkRootBudget(root.id)).resolves.toBeUndefined();
  });

  test("transitions root to blocked when cost ≥ cap", async () => {
    const root = await Run.create({
      triggerSource: "chat",
      humanOwnerId: TEST_USER_ID,
      budgetUsdCapMicros: 1_000_000,
    });
    // Move root to running so the blocked transition is valid.
    const { updateRunStatus } = await import("./repository");
    await updateRunStatus(root.id, "running");

    await addCostMicros(root.id, 1_000_000);
    await expect(checkRootBudget(root.id)).rejects.toThrow(/budget exhausted/i);

    const blocked = await getRun(root.id);
    expect(blocked?.status).toBe("blocked");
    expect(blocked?.blockedReason).toMatch(/budget exhausted/i);
  });

  test("zero-cap budget passes (treated as unbounded)", async () => {
    const root = await Run.create({
      triggerSource: "chat",
      humanOwnerId: TEST_USER_ID,
      budgetUsdCapMicros: 0,
    });
    await addCostMicros(root.id, 1_000_000_000);
    await expect(checkRootBudget(root.id)).resolves.toBeUndefined();
  });

  test("idempotent on a root that's already blocked", async () => {
    const root = await Run.create({
      triggerSource: "chat",
      humanOwnerId: TEST_USER_ID,
      budgetUsdCapMicros: 1_000_000,
    });
    const { updateRunStatus } = await import("./repository");
    await updateRunStatus(root.id, "running");
    await addCostMicros(root.id, 1_000_000);

    // First call transitions to blocked + throws.
    await expect(checkRootBudget(root.id)).rejects.toThrow(/budget exhausted/i);
    // Second call sees the already-blocked root, throws same error, no transition.
    await expect(checkRootBudget(root.id)).rejects.toThrow(/budget exhausted/i);

    const blocked = await getRun(root.id);
    expect(blocked?.status).toBe("blocked");
  });
});
```

- [ ] **Step 2: Run, expect failure**

```bash
cd /Users/matt/code/github.com/to11ai/nigel/apps/web
POSTGRES_URL="postgresql://test:test@localhost:5433/test" bun test lib/runs/budget.test.ts 2>&1 | tail -10
```

Expected: module not found.

- [ ] **Step 3: Implement**

Create `apps/web/lib/runs/budget.ts`:

```ts
import { getRun, updateRunStatus } from "./repository";

export class BudgetExhaustedError extends Error {
  constructor(rootRunId: string) {
    super(`budget exhausted on root run ${rootRunId}`);
    this.name = "BudgetExhaustedError";
  }
}

// Throws if the root Run's accumulated cost has reached or exceeded its cap.
// As a side effect, transitions the root to `blocked` (with reason "budget
// exhausted") on first hit. budgetUsdCapMicros=0 is treated as unbounded.
export async function checkRootBudget(rootRunId: string): Promise<void> {
  const root = await getRun(rootRunId);
  if (!root) {
    throw new Error(`root run not found: ${rootRunId}`);
  }
  if (root.budgetUsdCapMicros === 0) {
    return;
  }
  if (root.costUsdActualMicros < root.budgetUsdCapMicros) {
    return;
  }

  if (root.status === "running") {
    await updateRunStatus(root.id, "blocked", {
      blockedReason: "budget exhausted",
    });
  }
  throw new BudgetExhaustedError(root.id);
}
```

- [ ] **Step 4: Run tests, expect pass**

```bash
POSTGRES_URL="postgresql://test:test@localhost:5433/test" bun test lib/runs/budget.test.ts 2>&1 | tail -10
```

Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/matt/code/github.com/to11ai/nigel
git add apps/web/lib/runs/budget.ts apps/web/lib/runs/budget.test.ts
git commit -m "feat(runs): add budget enforcement helpers"
```

---

### Task 10: dispatchSpecialist + dispatchSpecialistsParallel

**Files:**
- Create: `apps/web/lib/runs/dispatch.ts`
- Create: `apps/web/lib/runs/dispatch.test.ts`
- Modify: `apps/web/lib/runs/index.ts` — re-export the new helpers

- [ ] **Step 1: Write tests**

Create `apps/web/lib/runs/dispatch.test.ts`:

```ts
import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "@/lib/db/client";
import { agentRuns, specialists, users } from "@/lib/db/schema";
import { nanoid } from "nanoid";
import { Run } from "./create";
import {
  dispatchSpecialist,
  dispatchSpecialistsParallel,
  SpecialistDispatchError,
} from "./dispatch";
import { addCostMicros, getRun, updateRunStatus } from "./repository";

const TEST_USER_ID = "test-user-dispatch";

beforeEach(async () => {
  await db.delete(agentRuns);
  await db.delete(specialists);
  await db
    .insert(users)
    .values({
      id: TEST_USER_ID,
      username: "test-dispatch",
      email: "test-dispatch@example.com",
    })
    .onConflictDoNothing();
});

describe("dispatchSpecialist", () => {
  test("scripted echo runs end-to-end", async () => {
    const parent = await Run.create({
      triggerSource: "chat",
      humanOwnerId: TEST_USER_ID,
      budgetUsdCapMicros: 1_000_000,
    });
    await updateRunStatus(parent.id, "running");

    const { childRun, output } = await dispatchSpecialist({
      parentRunId: parent.id,
      specialistName: "echo",
      task: "hello world",
    });

    expect(output).toBe("echo: hello world");
    expect(childRun.parentRunId).toBe(parent.id);
    expect(childRun.rootRunId).toBe(parent.id);
    expect(childRun.depth).toBe(1);
    expect(childRun.specialistId).toBe("echo");
    const refreshed = await getRun(childRun.id);
    expect(refreshed?.status).toBe("completed");
  });

  test("rejects unknown specialist", async () => {
    const parent = await Run.create({
      triggerSource: "chat",
      humanOwnerId: TEST_USER_ID,
      budgetUsdCapMicros: 1_000_000,
    });
    await expect(
      dispatchSpecialist({
        parentRunId: parent.id,
        specialistName: "no-such-specialist",
        task: "x",
      }),
    ).rejects.toThrow(SpecialistDispatchError);
  });

  test("rejects when parent budget exhausted", async () => {
    const parent = await Run.create({
      triggerSource: "chat",
      humanOwnerId: TEST_USER_ID,
      budgetUsdCapMicros: 1_000_000,
    });
    await updateRunStatus(parent.id, "running");
    await addCostMicros(parent.id, 1_000_000);

    await expect(
      dispatchSpecialist({
        parentRunId: parent.id,
        specialistName: "echo",
        task: "x",
      }),
    ).rejects.toThrow(/budget exhausted/i);
  });

  test("rejects when depth would exceed MAX_DEPTH", async () => {
    let parent = await Run.create({
      triggerSource: "chat",
      humanOwnerId: TEST_USER_ID,
      budgetUsdCapMicros: 1_000_000,
    });
    let parentId = parent.id;
    for (let i = 0; i < 5; i++) {
      const child = await Run.create({
        triggerSource: "chained",
        humanOwnerId: TEST_USER_ID,
        parentRunId: parentId,
        budgetUsdCapMicros: 100_000,
      });
      parentId = child.id;
    }

    await expect(
      dispatchSpecialist({
        parentRunId: parentId,
        specialistName: "echo",
        task: "x",
      }),
    ).rejects.toThrow(/depth/i);
  });

  test("returns a string-typed output", async () => {
    const parent = await Run.create({
      triggerSource: "chat",
      humanOwnerId: TEST_USER_ID,
      budgetUsdCapMicros: 1_000_000,
    });
    const result = await dispatchSpecialist({
      parentRunId: parent.id,
      specialistName: "echo",
      task: "test",
    });
    expect(typeof result.output).toBe("string");
  });
});

describe("dispatchSpecialistsParallel", () => {
  test("dispatches multiple specialists in parallel", async () => {
    const parent = await Run.create({
      triggerSource: "chat",
      humanOwnerId: TEST_USER_ID,
      budgetUsdCapMicros: 10_000_000,
    });
    await updateRunStatus(parent.id, "running");

    const results = await dispatchSpecialistsParallel([
      { parentRunId: parent.id, specialistName: "echo", task: "first" },
      { parentRunId: parent.id, specialistName: "echo", task: "second" },
      { parentRunId: parent.id, specialistName: "echo", task: "third" },
    ]);

    expect(results.map((r) => r.output)).toEqual([
      "echo: first",
      "echo: second",
      "echo: third",
    ]);
    const children = results.map((r) => r.childRun.id);
    expect(new Set(children).size).toBe(3); // distinct children
  });

  test("propagates first failure (Promise.all semantics)", async () => {
    const parent = await Run.create({
      triggerSource: "chat",
      humanOwnerId: TEST_USER_ID,
      budgetUsdCapMicros: 10_000_000,
    });
    await expect(
      dispatchSpecialistsParallel([
        { parentRunId: parent.id, specialistName: "echo", task: "ok" },
        { parentRunId: parent.id, specialistName: "missing", task: "fail" },
      ]),
    ).rejects.toThrow(SpecialistDispatchError);
  });
});
```

- [ ] **Step 2: Run, expect failure**

```bash
cd /Users/matt/code/github.com/to11ai/nigel/apps/web
POSTGRES_URL="postgresql://test:test@localhost:5433/test" bun test lib/runs/dispatch.test.ts 2>&1 | tail -10
```

Expected: module not found.

- [ ] **Step 3: Implement dispatch**

Create `apps/web/lib/runs/dispatch.ts`:

```ts
import { eq, and } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { agentRuns } from "@/lib/db/schema";
import { getSpecialist } from "@/lib/specialists";
import type { ResolvedSpecialist } from "@/lib/specialists";
import { checkRootBudget } from "./budget";
import { Run } from "./create";
import {
  addCostMicros,
  getRun,
  listChildren,
  updateRunStatus,
} from "./repository";
import type { AgentRun, SandboxPolicy } from "./types";

export class SpecialistDispatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpecialistDispatchError";
  }
}

export type DispatchSpecialistInput = {
  parentRunId: string;
  specialistName: string;
  task: string;
  sandboxPolicyOverride?: SandboxPolicy;
  budgetUsdMicros?: number;
};

export type DispatchSpecialistResult = {
  childRun: AgentRun;
  output: string;
};

export async function dispatchSpecialist(
  input: DispatchSpecialistInput,
): Promise<DispatchSpecialistResult> {
  const parent = await getRun(input.parentRunId);
  if (!parent) {
    throw new SpecialistDispatchError(
      `parent run not found: ${input.parentRunId}`,
    );
  }

  // Budget check at the boundary — fail before doing anything.
  await checkRootBudget(parent.rootRunId);

  const specialist = await getSpecialist(input.specialistName);
  if (!specialist) {
    throw new SpecialistDispatchError(
      `unknown specialist: ${input.specialistName}`,
    );
  }

  // Recurse permission: a parent specialist with mayRecurse=false cannot
  // dispatch children. Top-level chat (no specialist) can always dispatch.
  if (parent.specialistId) {
    const parentSpecialist = await getSpecialist(parent.specialistId);
    if (parentSpecialist && !parentSpecialist.mayRecurse) {
      throw new SpecialistDispatchError(
        `parent specialist '${parent.specialistId}' does not allow recursion`,
      );
    }
    // Per-specialist max-children cap.
    const siblings = await listChildren(parent.id);
    if (
      parentSpecialist &&
      parentSpecialist.maxChildren > 0 &&
      siblings.length >= parentSpecialist.maxChildren
    ) {
      throw new SpecialistDispatchError(
        `parent specialist '${parent.specialistId}' has reached max_children=${parentSpecialist.maxChildren}`,
      );
    }
  }

  // Run.create handles depth > MAX_DEPTH and parent existence.
  const childRun = await Run.create({
    triggerSource: "chained",
    humanOwnerId: parent.humanOwnerId,
    parentRunId: parent.id,
    specialistId: specialist.name,
    sandboxPolicy: input.sandboxPolicyOverride ?? specialist.sandboxPolicy,
    repoRef: parent.repoRef,
    chatId: parent.chatId,
    budgetUsdCapMicros:
      input.budgetUsdMicros ?? specialist.budgetUsdDefaultMicros,
  });

  // Phase 2 only supports scripted execution end-to-end. LLM-driven
  // specialists (kind='preset' or 'custom' with a model+systemPrompt) are
  // wired in Phase 4.
  if (specialist.kind === "scripted" && specialist.script) {
    await updateRunStatus(childRun.id, "running");
    try {
      const output = await specialist.script(input.task);
      await updateRunStatus(childRun.id, "completed");
      // Refresh the row so callers see the post-update status.
      const refreshed = (await getRun(childRun.id)) ?? childRun;
      return { childRun: refreshed, output };
    } catch (err) {
      await updateRunStatus(childRun.id, "failed").catch(() => undefined);
      throw err;
    }
  }

  // Phase 4 wires LLM-based specialists; until then, fail loudly so the
  // caller knows to wait for that phase rather than getting a stuck Run.
  await updateRunStatus(childRun.id, "failed").catch(() => undefined);
  throw new SpecialistDispatchError(
    `specialist '${specialist.name}' (kind=${specialist.kind}) cannot execute in Phase 2; LLM-based dispatch lands in Phase 4`,
  );
}

export async function dispatchSpecialistsParallel(
  inputs: DispatchSpecialistInput[],
): Promise<DispatchSpecialistResult[]> {
  return Promise.all(inputs.map((i) => dispatchSpecialist(i)));
}
```

- [ ] **Step 4: Re-export from runs barrel**

Edit `apps/web/lib/runs/index.ts`. Append:

```ts
export {
  type DispatchSpecialistInput,
  type DispatchSpecialistResult,
  dispatchSpecialist,
  dispatchSpecialistsParallel,
  SpecialistDispatchError,
} from "./dispatch";

export { BudgetExhaustedError, checkRootBudget } from "./budget";
```

- [ ] **Step 5: Run tests, expect pass**

```bash
POSTGRES_URL="postgresql://test:test@localhost:5433/test" bun test lib/runs/dispatch.test.ts 2>&1 | tail -10
```

Expected: 7 tests pass.

- [ ] **Step 6: Commit**

```bash
cd /Users/matt/code/github.com/to11ai/nigel
git add apps/web/lib/runs/dispatch.ts apps/web/lib/runs/dispatch.test.ts apps/web/lib/runs/index.ts
git commit -m "feat(runs): add dispatchSpecialist + parallel dispatch with budget enforcement"
```

---

### Task 11: Final lint + typecheck + push

**Files:**
- (none — verification + push)

- [ ] **Step 1: Run all checks**

```bash
cd /Users/matt/code/github.com/to11ai/nigel
bun run check
bun run typecheck
POSTGRES_URL="postgresql://test:test@localhost:5433/test" bun test --cwd apps/web lib/
```

Expected: all pass. The runs + specialists test suites should report (Phase 1 36 + Phase 2 ~21) tests passing.

If `bun run check` reports formatting issues, run `bun run fix`, review the changes (`git diff`), and commit them with `style: apply ultracite fix after Phase 2`.

- [ ] **Step 2: Push the branch**

```bash
git push -u origin phase-2-specialist-registry
```

- [ ] **Step 3: Open PR**

```bash
gh pr create --repo to11ai/nigel --title "Phase 2: specialist registry + dispatch primitive" --body "$(cat <<'EOF'
Implements `docs/exec-plans/active/2026-05-08-nigel-phase-2-specialist-registry-plan.md`.

## Summary

- Adds the `specialists` table (migration `0041`) with `kind ∈ {custom, override}`. Code presets live in `lib/specialists/presets.ts`; admin overrides + customs live in the table.
- Adds `lib/specialists/`: types, presets (one `echo` scripted preset for Phase 2 e2e), resolver (preset > override > custom merge), repository CRUD, barrel.
- Adds `lib/runs/budget.ts` with `checkRootBudget` (transitions root to `blocked` + throws `BudgetExhaustedError` on cap) and the existing `addCostMicros` re-export.
- Adds `lib/runs/dispatch.ts` with `dispatchSpecialist` (validates depth, recurse permission, max-children, budget; runs scripted specialists end-to-end) and `dispatchSpecialistsParallel` (Promise.all over child Runs).

## Out of scope (Phase 4)

- LLM-driven specialist execution (`kind='preset'|'custom'` with `model`+`systemPrompt`). Phase 2 throws `SpecialistDispatchError` for those — the registry + dispatch primitive is in place but Workflow SDK handlers per specialist are Phase 4 work.
- Wiring `dispatchSpecialist` as an AI SDK tool exposed to the chat agent — Phase 4's planner role is the first consumer.
- Specialist roster (`coder`, `linter`, `reviewer`, etc.) — Phase 4 ships these one at a time.

## Test plan

- [ ] CI green (typecheck + lint + ~21 new tests across `lib/specialists/` and `lib/runs/dispatch.test.ts`/`budget.test.ts`)
- [ ] After merge, prod build's `db:migrate:apply` step applies migration 0041 against Neon
- [ ] No production behavior change — Phase 1's flag-off chat path remains the default
EOF
)"
```

- [ ] **Step 4: Hand off to babysit-pr**

After the PR is open, invoke `/babysit-pr` on the PR number. Address any Cursor Bugbot / Greptile findings using the same pattern as Phase 0/1 PRs.

---

## Acceptance criteria for Phase 2

1. The `specialists` table exists in prod Neon with the schema and indexes from Task 2.
2. `lib/specialists/` exposes `getSpecialist`, `upsertCustomSpecialist`, `upsertOverride`, `deleteOverride`, `listSpecialists`, `PRESETS`, `getPresetNames` with the signatures defined in Tasks 4–8.
3. `getSpecialist('echo')` returns the scripted preset; `getSpecialist('echo')` after an override row exists returns the merged result; `getSpecialist('unknown')` returns `null`; `getSpecialist` for an override with no matching preset throws.
4. `lib/runs/budget.ts` exposes `checkRootBudget` and `BudgetExhaustedError`. `checkRootBudget` is a no-op when cap is 0 (unbounded), passes when cost < cap, and transitions root to `blocked` + throws when cost ≥ cap.
5. `lib/runs/dispatch.ts` exposes `dispatchSpecialist` and `dispatchSpecialistsParallel` and `SpecialistDispatchError`. The echo preset runs end-to-end in tests; depth/recurse/max-children/budget checks reject as expected.
6. `bun run check` and `bun run typecheck` pass on the branch; full test suite passes locally and in CI.
7. No regression in Phase 1 — runs tests still pass; flag-off chat tests still pass.

---

## Self-review notes

Spec coverage (Phase 2 row in Section 11):

- ✅ `specialists` table → Tasks 2, 3.
- ✅ Presets file in code → Task 5.
- ✅ Resolver (preset > override > custom) → Task 6.
- ✅ `dispatch_specialist` primitive → Task 10 (`dispatchSpecialist`).
- ✅ Parallel dispatch → Task 10 (`dispatchSpecialistsParallel`).
- ✅ Budget enforcement at boundaries → Task 9 (`checkRootBudget` is the boundary; called at the entry of `dispatchSpecialist`).
- ✅ `needs_local_stack` field → Task 2 (column), Task 4 (type), Task 5 (preset), Task 6 (resolver merge), Task 7 (repository).

No placeholders. All commands and code blocks are concrete. Type/identifier consistency:

- `Specialist` (DB row, via `SpecialistRow`) vs `ResolvedSpecialist` (runtime resolved) vs `CodePreset` (preset-only constraint) — distinct names with clear purpose.
- `kind` enum values: `'preset' | 'custom' | 'override' | 'scripted'` in code (`SpecialistKind`); only `'custom'` and `'override'` are valid DB values per the column's `enum` constraint. `'preset'` and `'scripted'` are code-side kinds.
- Cost columns are micro-USD `bigint` (mode:'number'), consistent with Phase 1.
- `dispatchSpecialist` returns `{ childRun, output: string }`; `dispatchSpecialistsParallel` returns `Array<{ childRun, output: string }>`.

LLM-driven dispatch is intentionally a hard error (`SpecialistDispatchError`) in Phase 2 — better to fail loudly than to silently leave a child Run stuck in `running` for a feature that lands in Phase 4.
