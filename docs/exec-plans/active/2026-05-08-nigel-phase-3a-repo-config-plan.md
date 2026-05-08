# Nigel Phase 3a — Repo Config Primitive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land a pure-data `RepoConfig` primitive: Zod schema for `.nigel.yaml`, a `repo_configs` DB fallback table, an auto-detect path that sniffs `package.json` + `turbo.json`, a Turbo-derived command map, and a `loadRepoConfig` resolver that composes all three layers. No sandbox runtime work — that lands in Phase 3b.

**Architecture:** All work lives under `apps/web/lib/repo-config/`. The resolver is pure: callers pass the YAML text (read elsewhere), package.json contents, and turbo.json contents — the resolver does not touch the filesystem or the sandbox. DB access is isolated to a small repository module (`repository.ts`). Turbo derivation is pure logic that takes parsed inputs and returns a derived command map. This keeps every piece unit-testable without a sandbox or workflow harness.

**Tech Stack:** Drizzle ORM (Postgres), Zod for schema validation, `js-yaml` for YAML parsing (already in the workspace dep tree from upstream), Bun's test runner.

---

## File Structure

- Create:
  - `apps/web/lib/db/migrations/0042_<auto-named>.sql` — generated `repo_configs` migration.
  - `apps/web/lib/repo-config/types.ts` — Zod schema + inferred `RepoConfig` type + helper input types (`PackageJsonLike`, `TurboJsonLike`).
  - `apps/web/lib/repo-config/parse.ts` — `parseNigelYaml(text: string): RepoConfig` (parse + Zod validate; throws `RepoConfigParseError` on failure).
  - `apps/web/lib/repo-config/parse.test.ts`
  - `apps/web/lib/repo-config/auto-detect.ts` — `autoDetectRepoConfig({ packageJson, turboJson, monorepoWorkspaces })` returns a `RepoConfig` from sniffing.
  - `apps/web/lib/repo-config/auto-detect.test.ts`
  - `apps/web/lib/repo-config/turbo-derive.ts` — `applyTurboDerivation(config: RepoConfig, { turboJsonPresent }): RepoConfig` filling `checks.*.command` and `dev_server.command` from turbo task map.
  - `apps/web/lib/repo-config/turbo-derive.test.ts`
  - `apps/web/lib/repo-config/repository.ts` — Drizzle CRUD for `repo_configs`: `getRepoConfigRow(repoFullName)`, `upsertRepoConfigRow(repoFullName, config, source)`.
  - `apps/web/lib/repo-config/repository.test.ts`
  - `apps/web/lib/repo-config/resolver.ts` — `loadRepoConfig({ repoFullName, yamlText, packageJson, turboJson })` composing all layers.
  - `apps/web/lib/repo-config/resolver.test.ts`
  - `apps/web/lib/repo-config/index.ts` — barrel export.
- Modify:
  - `apps/web/lib/db/schema.ts` — append `repo_configs` table definition (NOT in any unrelated section; place it after `specialists` so related primitives are colocated).
  - `apps/web/package.json` — add `js-yaml` + `@types/js-yaml` if not already present.

Each file has one concern. Test files are colocated with the module they test.

---

## Resolution semantics (locked)

`loadRepoConfig({ repoFullName, yamlText, packageJson, turboJson })`:

1. If `yamlText` is non-null: parse + validate → run Turbo derivation → return `{ source: "file", config }`.
2. Otherwise, query `repo_configs` table by `repoFullName`:
   - If row exists: return `{ source: row.source, config: row.config_json }` (the row already had derivation applied at write-time; do **not** re-apply).
3. Otherwise: run auto-detect from `packageJson` + `turboJson` → run Turbo derivation → upsert into `repo_configs` with `source='inferred'` → return `{ source: "inferred", config, warning: "no .nigel.yaml found — inferred config used. Commit .nigel.yaml for canonical setup." }`.

The function is pure aside from the DB read/write at layers 2-3. Sandbox file reads are the caller's responsibility.

---

## Schema (Zod)

The Zod schema mirrors the spec's YAML example. Required vs. optional:

- `version`: literal `1`. Required.
- `setup`: array of strings. Optional, default `[]`.
- `dev_server`: optional object `{ command, port, ready_check, ready_timeout_seconds }`. Each field optional; turbo-derive may fill `command`.
- `turbo`: optional object `{ enabled, remote_cache_token, affected, task_map }`. `task_map` keys are constrained to `lint | format | type_check | unit_test | e2e_test | dev`.
- `checks`: object keyed by `lint | format | type_check | unit_test | e2e_test`, each value `{ command?: string, local_stack_profile?: string, needs?: string[] }`. All checks optional; turbo-derive fills missing commands.
- `local_stack`: optional object — declared in schema but **not used** by Phase 3a logic (Phase 3b consumes it). Keep the shape so files validate.
- `routes_for_visual_prover`: optional array of `{ path, auth: 'none' | 'required' }`.
- `frontend_globs`: optional array of strings.
- `monorepo`: optional `{ workspaces: string[], default_workspace?: string }`.

`RepoConfig = z.infer<typeof RepoConfigSchema>`.

`local_stack_profile: 'none'` is a valid string value; the Phase 3b resolver will treat it as a sentinel. Phase 3a does not need to enumerate it.

---

## Turbo derivation rules

`applyTurboDerivation(config, { turboJsonPresent })`:

- `turbo.enabled` defaults to `true` if `turboJsonPresent` and not explicitly set, else `false`.
- If `turbo.enabled` is `false`: return `config` unchanged.
- For each check (`lint`, `format`, `type_check`, `unit_test`, `e2e_test`): if `command` is unset, derive `turbo run <task>` where `<task>` = `turbo.task_map?.[checkName]` ?? default per spec table. For `e2e_test` the default appends `--filter=<monorepo.default_workspace>` if present.
- For `dev_server.command`: if unset and `turbo.enabled`, derive `turbo run <dev-task> --filter=<monorepo.default_workspace>` (with `<dev-task>` = `turbo.task_map?.dev` ?? `"dev"`).
- Explicit values always win — derivation only fills `undefined`.

Defaults table (from spec line 497-503):

| Check | Default task |
|---|---|
| lint | `lint` |
| format | `format:check` |
| type_check | `check-types` |
| unit_test | `test:unit` |
| e2e_test | `test:e2e` |
| dev | `dev` |

---

## Auto-detect rules

`autoDetectRepoConfig({ packageJson, turboJson })`:

- `version: 1`.
- `setup`: if `packageJson` has `lockfileVersion` indicator (or just default to `["bun install --frozen-lockfile"]` since the project is a bun workspace).
- `monorepo.workspaces`: from `packageJson.workspaces` (string array form) if present.
- `monorepo.default_workspace`: first workspace if any.
- `turbo.enabled`: `!!turboJson`.
- `checks`: empty object — Turbo derivation fills it if turbo is on; otherwise checks remain empty (caller can still run with no checks defined).
- `local_stack`: undefined.
- `routes_for_visual_prover`: undefined.
- `frontend_globs`: undefined.

Result is then run through `applyTurboDerivation`.

---

## DB schema

```ts
export const repoConfigs = pgTable(
  "repo_configs",
  {
    id: text("id").primaryKey(),
    repoFullName: text("repo_full_name").notNull(),
    configJson: jsonb("config_json").$type<RepoConfig>().notNull(),
    source: text("source", { enum: ["file", "db", "inferred"] }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("repo_configs_repo_full_name_idx").on(table.repoFullName),
  ],
);
```

`source` has three valid values matching the resolver layers. The unique index on `repo_full_name` enforces one row per repo.

---

## Tasks

### Task 1: Add `repo_configs` table to schema and generate migration

**Files:**
- Modify: `apps/web/lib/db/schema.ts` (append after `specialists`)
- Generate: `apps/web/lib/db/migrations/0042_<name>.sql`

- [ ] **Step 1: Append the table definition to `schema.ts`**

```ts
// repo_configs — DB fallback for repos without a .nigel.yaml committed.
// Populated either by admin via UI ('db' source) or auto-inferred from
// package.json / turbo.json on first encounter ('inferred' source).
// The resolver always prefers a checked-in `.nigel.yaml` over either DB row.
export const repoConfigs = pgTable(
  "repo_configs",
  {
    id: text("id").primaryKey(),
    repoFullName: text("repo_full_name").notNull(),
    configJson: jsonb("config_json").$type<unknown>().notNull(),
    source: text("source", { enum: ["file", "db", "inferred"] }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("repo_configs_repo_full_name_idx").on(table.repoFullName),
  ],
);
```

`config_json` is typed as `unknown` at the schema layer because the canonical `RepoConfig` Zod type lives in `lib/repo-config/types.ts`. Repository functions cast through Zod-validated parse on read.

- [ ] **Step 2: Generate the migration**

Run: `bun run --cwd apps/web db:generate`
Expected: a new `apps/web/lib/db/migrations/0042_*.sql` plus updated `meta/_journal.json` and `meta/0042_snapshot.json`.

- [ ] **Step 3: Verify the SQL contains `CREATE TABLE "repo_configs"` and the unique index**

Run: `cat apps/web/lib/db/migrations/0042_*.sql` (only the new file)
Expected: the table create + unique index on `repo_full_name`. No accidental drops or alters of unrelated tables.

- [ ] **Step 4: Commit**

```bash
git add apps/web/lib/db/schema.ts apps/web/lib/db/migrations/0042_*.sql apps/web/lib/db/migrations/meta/0042_snapshot.json apps/web/lib/db/migrations/meta/_journal.json
git commit -m "feat(db): add repo_configs table (Phase 3a)"
```

---

### Task 2: Add Zod schema and types

**Files:**
- Create: `apps/web/lib/repo-config/types.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/lib/repo-config/types.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { RepoConfigSchema } from "./types";

describe("RepoConfigSchema", () => {
  test("accepts a minimal config", () => {
    const parsed = RepoConfigSchema.parse({ version: 1 });
    expect(parsed.version).toBe(1);
  });

  test("accepts the full spec example", () => {
    const parsed = RepoConfigSchema.parse({
      version: 1,
      setup: ["bun install --frozen-lockfile"],
      dev_server: { command: "bun run dev", port: 3000 },
      turbo: { enabled: true, affected: true, task_map: { lint: "lint" } },
      checks: {
        lint: { command: "bun run lint" },
        e2e_test: { command: "bun run test:e2e", local_stack_profile: "bare", needs: ["dev_server"] },
      },
      local_stack: {
        compose_file: "docker-compose.yaml",
        wait_for: [{ service: "db", cmd: "pg_isready -h db" }],
        profiles: { bare: { description: "x", post_up: ["bun run db:migrate"] } },
        default_profile: "bare",
      },
      routes_for_visual_prover: [{ path: "/", auth: "none" }],
      frontend_globs: ["apps/web/**/*.tsx"],
      monorepo: { workspaces: ["apps/web"], default_workspace: "apps/web" },
    });
    expect(parsed.checks?.e2e_test?.local_stack_profile).toBe("bare");
  });

  test("rejects unknown version", () => {
    expect(() => RepoConfigSchema.parse({ version: 2 })).toThrow();
  });

  test("rejects unknown check key", () => {
    expect(() =>
      RepoConfigSchema.parse({ version: 1, checks: { bogus: { command: "x" } } }),
    ).toThrow();
  });

  test("accepts post_up entries as either string or object", () => {
    const parsed = RepoConfigSchema.parse({
      version: 1,
      local_stack: {
        compose_file: "docker-compose.yaml",
        profiles: {
          full: {
            description: "full",
            post_up: ["bun run db:migrate", { cmd: "bun run db:warm-cache", timeout_seconds: 30, retry: 2 }],
          },
        },
        default_profile: "full",
      },
    });
    expect(parsed.local_stack?.profiles.full?.post_up).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run the test (should fail — module doesn't exist)**

Run: `cd apps/web && POSTGRES_URL=postgresql://test:test@localhost:5433/test bun test lib/repo-config/types.test.ts`
Expected: `Cannot find module './types'`.

- [ ] **Step 3: Implement `types.ts`**

```ts
import { z } from "zod";

const PostUpStepSchema = z.union([
  z.string(),
  z.object({
    cmd: z.string(),
    timeout_seconds: z.number().int().positive().optional(),
    retry: z.number().int().nonnegative().optional(),
  }),
]);

const ProfileSchema = z.object({
  description: z.string().optional(),
  post_up: z.array(PostUpStepSchema).optional().default([]),
});

const LocalStackSchema = z.object({
  compose_file: z.string(),
  wait_for: z
    .array(z.object({ service: z.string(), cmd: z.string() }))
    .optional()
    .default([]),
  env_file: z.string().optional(),
  startup_timeout_seconds: z.number().int().positive().optional(),
  teardown_on_exit: z.boolean().optional().default(true),
  profiles: z.record(z.string(), ProfileSchema),
  default_profile: z.string(),
});

const CheckSchema = z.object({
  command: z.string().optional(),
  local_stack_profile: z.string().optional(),
  needs: z.array(z.string()).optional(),
});

const TurboSchema = z.object({
  enabled: z.boolean().optional(),
  remote_cache_token: z.string().optional(),
  affected: z.boolean().optional().default(false),
  task_map: z
    .object({
      lint: z.string().optional(),
      format: z.string().optional(),
      type_check: z.string().optional(),
      unit_test: z.string().optional(),
      e2e_test: z.string().optional(),
      dev: z.string().optional(),
    })
    .optional(),
});

export const RepoConfigSchema = z.object({
  version: z.literal(1),
  setup: z.array(z.string()).optional().default([]),
  dev_server: z
    .object({
      command: z.string().optional(),
      port: z.number().int().positive().optional(),
      ready_check: z.string().optional(),
      ready_timeout_seconds: z.number().int().positive().optional(),
    })
    .optional(),
  turbo: TurboSchema.optional(),
  checks: z
    .object({
      lint: CheckSchema.optional(),
      format: CheckSchema.optional(),
      type_check: CheckSchema.optional(),
      unit_test: CheckSchema.optional(),
      e2e_test: CheckSchema.optional(),
    })
    .strict()
    .optional(),
  local_stack: LocalStackSchema.optional(),
  routes_for_visual_prover: z
    .array(z.object({ path: z.string(), auth: z.enum(["none", "required"]) }))
    .optional(),
  frontend_globs: z.array(z.string()).optional(),
  monorepo: z
    .object({
      workspaces: z.array(z.string()),
      default_workspace: z.string().optional(),
    })
    .optional(),
});

export type RepoConfig = z.infer<typeof RepoConfigSchema>;

export type PackageJsonLike = {
  name?: string;
  workspaces?: string[] | { packages?: string[] };
};

export type TurboJsonLike = {
  tasks?: Record<string, unknown>;
};

export type RepoConfigSource = "file" | "db" | "inferred";

export type LoadRepoConfigResult =
  | { source: "file"; config: RepoConfig }
  | { source: "db"; config: RepoConfig }
  | { source: "inferred"; config: RepoConfig; warning: string };
```

`checks` uses `.strict()` so unknown check keys are rejected (test #4 above relies on this).

- [ ] **Step 4: Run the test, verify it passes**

Run: `cd apps/web && POSTGRES_URL=postgresql://test:test@localhost:5433/test bun test lib/repo-config/types.test.ts`
Expected: 5/5 pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/repo-config/types.ts apps/web/lib/repo-config/types.test.ts
git commit -m "feat(repo-config): add Zod schema for .nigel.yaml"
```

---

### Task 3: Add YAML parser

**Files:**
- Create: `apps/web/lib/repo-config/parse.ts`
- Modify: `apps/web/package.json` (only if `js-yaml` is missing)

- [ ] **Step 1: Verify `js-yaml` is installed**

Run: `cd apps/web && bun pm ls js-yaml 2>&1 | head -5`
If absent, run: `cd apps/web && bun add js-yaml && bun add -d @types/js-yaml`
Expected: `js-yaml` resolves to a version (any 4.x).

- [ ] **Step 2: Write the failing test**

Create `apps/web/lib/repo-config/parse.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { parseNigelYaml, RepoConfigParseError } from "./parse";

describe("parseNigelYaml", () => {
  test("parses a minimal yaml document", () => {
    const config = parseNigelYaml("version: 1\n");
    expect(config.version).toBe(1);
  });

  test("parses the spec example", () => {
    const yaml = `
version: 1
setup:
  - "bun install --frozen-lockfile"
turbo:
  enabled: true
checks:
  lint: { command: "bun run lint" }
`;
    const config = parseNigelYaml(yaml);
    expect(config.checks?.lint?.command).toBe("bun run lint");
    expect(config.turbo?.enabled).toBe(true);
  });

  test("throws RepoConfigParseError on malformed yaml", () => {
    expect(() => parseNigelYaml("version: 1\n  bad: indent")).toThrow(
      RepoConfigParseError,
    );
  });

  test("throws RepoConfigParseError when schema validation fails", () => {
    expect(() => parseNigelYaml("version: 2\n")).toThrow(RepoConfigParseError);
  });

  test("throws RepoConfigParseError when document is not an object", () => {
    expect(() => parseNigelYaml("- 1\n- 2\n")).toThrow(RepoConfigParseError);
  });
});
```

- [ ] **Step 3: Run, verify it fails**

Run: `cd apps/web && POSTGRES_URL=postgresql://test:test@localhost:5433/test bun test lib/repo-config/parse.test.ts`
Expected: `Cannot find module './parse'`.

- [ ] **Step 4: Implement `parse.ts`**

```ts
import yaml from "js-yaml";
import { RepoConfigSchema, type RepoConfig } from "./types";

export class RepoConfigParseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RepoConfigParseError";
  }
}

export function parseNigelYaml(text: string): RepoConfig {
  let raw: unknown;
  try {
    raw = yaml.load(text);
  } catch (err) {
    throw new RepoConfigParseError(
      `failed to parse .nigel.yaml: ${(err as Error).message}`,
      { cause: err },
    );
  }
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
    throw new RepoConfigParseError(
      `.nigel.yaml must be a YAML mapping at the top level`,
    );
  }
  const parsed = RepoConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new RepoConfigParseError(
      `.nigel.yaml failed schema validation: ${parsed.error.message}`,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}
```

- [ ] **Step 5: Run, verify it passes**

Run: `cd apps/web && POSTGRES_URL=postgresql://test:test@localhost:5433/test bun test lib/repo-config/parse.test.ts`
Expected: 5/5 pass.

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/repo-config/parse.ts apps/web/lib/repo-config/parse.test.ts
# Only add package.json/lock if js-yaml was newly added
git diff --cached --quiet apps/web/package.json || git add apps/web/package.json bun.lock
git commit -m "feat(repo-config): add parseNigelYaml with Zod validation"
```

---

### Task 4: Add Turbo derivation

**Files:**
- Create: `apps/web/lib/repo-config/turbo-derive.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/lib/repo-config/turbo-derive.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { applyTurboDerivation } from "./turbo-derive";
import type { RepoConfig } from "./types";

const base = (overrides: Partial<RepoConfig> = {}): RepoConfig =>
  ({ version: 1, setup: [], ...overrides }) as RepoConfig;

describe("applyTurboDerivation", () => {
  test("returns config unchanged when turbo is disabled and no turbo.json", () => {
    const config = base({ checks: { lint: {} } });
    const out = applyTurboDerivation(config, { turboJsonPresent: false });
    expect(out.checks?.lint?.command).toBeUndefined();
  });

  test("auto-enables turbo when turbo.json is present and not explicitly disabled", () => {
    const config = base({ checks: { lint: {} } });
    const out = applyTurboDerivation(config, { turboJsonPresent: true });
    expect(out.checks?.lint?.command).toBe("turbo run lint");
  });

  test("respects explicit turbo.enabled=false even when turbo.json is present", () => {
    const config = base({ turbo: { enabled: false }, checks: { lint: {} } });
    const out = applyTurboDerivation(config, { turboJsonPresent: true });
    expect(out.checks?.lint?.command).toBeUndefined();
  });

  test("derives all five check defaults", () => {
    const config = base({
      checks: {
        lint: {},
        format: {},
        type_check: {},
        unit_test: {},
        e2e_test: {},
      },
    });
    const out = applyTurboDerivation(config, { turboJsonPresent: true });
    expect(out.checks?.lint?.command).toBe("turbo run lint");
    expect(out.checks?.format?.command).toBe("turbo run format:check");
    expect(out.checks?.type_check?.command).toBe("turbo run check-types");
    expect(out.checks?.unit_test?.command).toBe("turbo run test:unit");
    expect(out.checks?.e2e_test?.command).toBe("turbo run test:e2e");
  });

  test("appends --filter=<default_workspace> to e2e_test and dev_server", () => {
    const config = base({
      checks: { e2e_test: {} },
      dev_server: {},
      monorepo: { workspaces: ["apps/web"], default_workspace: "apps/web" },
    });
    const out = applyTurboDerivation(config, { turboJsonPresent: true });
    expect(out.checks?.e2e_test?.command).toBe("turbo run test:e2e --filter=apps/web");
    expect(out.dev_server?.command).toBe("turbo run dev --filter=apps/web");
  });

  test("explicit command overrides derivation", () => {
    const config = base({
      checks: { lint: { command: "custom-lint" } },
    });
    const out = applyTurboDerivation(config, { turboJsonPresent: true });
    expect(out.checks?.lint?.command).toBe("custom-lint");
  });

  test("turbo.task_map overrides default task names", () => {
    const config = base({
      turbo: { task_map: { lint: "lint:strict" } },
      checks: { lint: {} },
    });
    const out = applyTurboDerivation(config, { turboJsonPresent: true });
    expect(out.checks?.lint?.command).toBe("turbo run lint:strict");
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `cd apps/web && POSTGRES_URL=postgresql://test:test@localhost:5433/test bun test lib/repo-config/turbo-derive.test.ts`
Expected: module not found.

- [ ] **Step 3: Implement `turbo-derive.ts`**

```ts
import type { RepoConfig } from "./types";

const DEFAULT_TASKS = {
  lint: "lint",
  format: "format:check",
  type_check: "check-types",
  unit_test: "test:unit",
  e2e_test: "test:e2e",
  dev: "dev",
} as const;

type CheckKey = "lint" | "format" | "type_check" | "unit_test" | "e2e_test";

export function applyTurboDerivation(
  config: RepoConfig,
  { turboJsonPresent }: { turboJsonPresent: boolean },
): RepoConfig {
  const turboEnabled = config.turbo?.enabled ?? turboJsonPresent;
  if (!turboEnabled) return config;

  const taskMap = config.turbo?.task_map ?? {};
  const defaultWorkspace = config.monorepo?.default_workspace;

  const deriveCommand = (key: CheckKey): string => {
    const task = taskMap[key] ?? DEFAULT_TASKS[key];
    if (key === "e2e_test" && defaultWorkspace) {
      return `turbo run ${task} --filter=${defaultWorkspace}`;
    }
    return `turbo run ${task}`;
  };

  const checks = { ...config.checks };
  for (const key of ["lint", "format", "type_check", "unit_test", "e2e_test"] as CheckKey[]) {
    const existing = checks[key];
    if (existing && existing.command === undefined) {
      checks[key] = { ...existing, command: deriveCommand(key) };
    }
  }

  let devServer = config.dev_server;
  if (devServer && devServer.command === undefined) {
    const devTask = taskMap.dev ?? DEFAULT_TASKS.dev;
    const filter = defaultWorkspace ? ` --filter=${defaultWorkspace}` : "";
    devServer = { ...devServer, command: `turbo run ${devTask}${filter}` };
  }

  return {
    ...config,
    checks,
    ...(devServer ? { dev_server: devServer } : {}),
  };
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `cd apps/web && POSTGRES_URL=postgresql://test:test@localhost:5433/test bun test lib/repo-config/turbo-derive.test.ts`
Expected: 7/7 pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/repo-config/turbo-derive.ts apps/web/lib/repo-config/turbo-derive.test.ts
git commit -m "feat(repo-config): add Turbo command derivation"
```

---

### Task 5: Add auto-detect

**Files:**
- Create: `apps/web/lib/repo-config/auto-detect.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/lib/repo-config/auto-detect.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { autoDetectRepoConfig } from "./auto-detect";

describe("autoDetectRepoConfig", () => {
  test("returns minimal config when no inputs provided", () => {
    const out = autoDetectRepoConfig({ packageJson: null, turboJson: null });
    expect(out.version).toBe(1);
    expect(out.turbo).toBeUndefined();
    expect(out.monorepo).toBeUndefined();
  });

  test("enables turbo when turbo.json present", () => {
    const out = autoDetectRepoConfig({ packageJson: null, turboJson: { tasks: {} } });
    expect(out.turbo?.enabled).toBe(true);
  });

  test("infers monorepo from package.json workspaces array", () => {
    const out = autoDetectRepoConfig({
      packageJson: { workspaces: ["apps/web", "apps/api"] },
      turboJson: null,
    });
    expect(out.monorepo?.workspaces).toEqual(["apps/web", "apps/api"]);
    expect(out.monorepo?.default_workspace).toBe("apps/web");
  });

  test("infers monorepo from package.json workspaces.packages object form", () => {
    const out = autoDetectRepoConfig({
      packageJson: { workspaces: { packages: ["packages/*"] } },
      turboJson: null,
    });
    expect(out.monorepo?.workspaces).toEqual(["packages/*"]);
  });

  test("derives commands when both turbo.json and workspaces are present", () => {
    const out = autoDetectRepoConfig({
      packageJson: { workspaces: ["apps/web"] },
      turboJson: { tasks: {} },
    });
    expect(out.checks?.lint?.command).toBe("turbo run lint");
    expect(out.checks?.e2e_test?.command).toBe("turbo run test:e2e --filter=apps/web");
  });

  test("default setup is bun install", () => {
    const out = autoDetectRepoConfig({ packageJson: null, turboJson: null });
    expect(out.setup).toEqual(["bun install --frozen-lockfile"]);
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `cd apps/web && POSTGRES_URL=postgresql://test:test@localhost:5433/test bun test lib/repo-config/auto-detect.test.ts`
Expected: module not found.

- [ ] **Step 3: Implement `auto-detect.ts`**

```ts
import { applyTurboDerivation } from "./turbo-derive";
import type { PackageJsonLike, RepoConfig, TurboJsonLike } from "./types";

export type AutoDetectInput = {
  packageJson: PackageJsonLike | null;
  turboJson: TurboJsonLike | null;
};

export function autoDetectRepoConfig({
  packageJson,
  turboJson,
}: AutoDetectInput): RepoConfig {
  const workspaces = extractWorkspaces(packageJson);
  const monorepo =
    workspaces.length > 0
      ? { workspaces, default_workspace: workspaces[0] }
      : undefined;

  const turboJsonPresent = !!turboJson;

  // Pre-fill empty checks so the derivation can fill commands. If turbo is
  // off there will be no commands and the caller can decide what to do.
  const checks = turboJsonPresent
    ? { lint: {}, format: {}, type_check: {}, unit_test: {}, e2e_test: {} }
    : undefined;

  const base: RepoConfig = {
    version: 1,
    setup: ["bun install --frozen-lockfile"],
    ...(monorepo ? { monorepo } : {}),
    ...(turboJsonPresent ? { turbo: { enabled: true, affected: false } } : {}),
    ...(checks ? { checks } : {}),
  };

  return applyTurboDerivation(base, { turboJsonPresent });
}

function extractWorkspaces(pkg: PackageJsonLike | null): string[] {
  if (!pkg?.workspaces) return [];
  if (Array.isArray(pkg.workspaces)) return pkg.workspaces;
  if (Array.isArray(pkg.workspaces.packages)) return pkg.workspaces.packages;
  return [];
}
```

- [ ] **Step 4: Run, verify pass**

Run: `cd apps/web && POSTGRES_URL=postgresql://test:test@localhost:5433/test bun test lib/repo-config/auto-detect.test.ts`
Expected: 6/6 pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/repo-config/auto-detect.ts apps/web/lib/repo-config/auto-detect.test.ts
git commit -m "feat(repo-config): add auto-detect from package.json + turbo.json"
```

---

### Task 6: Add DB repository

**Files:**
- Create: `apps/web/lib/repo-config/repository.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/lib/repo-config/repository.test.ts`:

```ts
import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "@/lib/db/client";
import { repoConfigs } from "@/lib/db/schema";
import { getRepoConfigRow, upsertRepoConfigRow } from "./repository";
import type { RepoConfig } from "./types";

const sample: RepoConfig = {
  version: 1,
  setup: ["bun install"],
};

beforeEach(async () => {
  await db.delete(repoConfigs);
});

describe("repo_configs repository", () => {
  test("upsertRepoConfigRow creates a new row", async () => {
    const row = await upsertRepoConfigRow("acme/widget", sample, "db");
    expect(row.repoFullName).toBe("acme/widget");
    expect(row.source).toBe("db");
  });

  test("upsertRepoConfigRow updates the existing row in place", async () => {
    const a = await upsertRepoConfigRow("acme/widget", sample, "inferred");
    const b = await upsertRepoConfigRow(
      "acme/widget",
      { ...sample, setup: ["echo updated"] },
      "db",
    );
    expect(b.id).toBe(a.id);
    expect(b.source).toBe("db");
    expect((b.configJson as RepoConfig).setup).toEqual(["echo updated"]);
  });

  test("getRepoConfigRow returns the row when present", async () => {
    await upsertRepoConfigRow("acme/widget", sample, "db");
    const row = await getRepoConfigRow("acme/widget");
    expect(row?.repoFullName).toBe("acme/widget");
  });

  test("getRepoConfigRow returns null when absent", async () => {
    const row = await getRepoConfigRow("does/not-exist");
    expect(row).toBeNull();
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `cd apps/web && POSTGRES_URL=postgresql://test:test@localhost:5433/test bun test lib/repo-config/repository.test.ts`
Expected: module not found.

- [ ] **Step 3: Implement `repository.ts`**

```ts
import { eq } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db/client";
import { repoConfigs } from "@/lib/db/schema";
import type { RepoConfig, RepoConfigSource } from "./types";

export type RepoConfigRow = InferSelectModel<typeof repoConfigs>;

export async function getRepoConfigRow(
  repoFullName: string,
): Promise<RepoConfigRow | null> {
  const rows = await db
    .select()
    .from(repoConfigs)
    .where(eq(repoConfigs.repoFullName, repoFullName))
    .limit(1);
  return rows[0] ?? null;
}

export async function upsertRepoConfigRow(
  repoFullName: string,
  config: RepoConfig,
  source: RepoConfigSource,
): Promise<RepoConfigRow> {
  const existing = await getRepoConfigRow(repoFullName);
  const now = new Date();

  if (existing) {
    const updated = await db
      .update(repoConfigs)
      .set({ configJson: config, source, updatedAt: now })
      .where(eq(repoConfigs.id, existing.id))
      .returning();
    return updated[0];
  }

  const inserted = await db
    .insert(repoConfigs)
    .values({
      id: nanoid(),
      repoFullName,
      configJson: config,
      source,
    })
    .returning();
  return inserted[0];
}
```

- [ ] **Step 4: Run, verify pass**

Run: `cd apps/web && POSTGRES_URL=postgresql://test:test@localhost:5433/test bun test lib/repo-config/repository.test.ts`
Expected: 4/4 pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/repo-config/repository.ts apps/web/lib/repo-config/repository.test.ts
git commit -m "feat(repo-config): add Drizzle repository for repo_configs"
```

---

### Task 7: Add resolver

**Files:**
- Create: `apps/web/lib/repo-config/resolver.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/lib/repo-config/resolver.test.ts`:

```ts
import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "@/lib/db/client";
import { repoConfigs } from "@/lib/db/schema";
import { upsertRepoConfigRow } from "./repository";
import { loadRepoConfig } from "./resolver";

beforeEach(async () => {
  await db.delete(repoConfigs);
});

describe("loadRepoConfig", () => {
  test("file source: parses yaml when provided", async () => {
    const out = await loadRepoConfig({
      repoFullName: "acme/widget",
      yamlText: "version: 1\nsetup: ['bun install']\n",
      packageJson: null,
      turboJson: null,
    });
    expect(out.source).toBe("file");
    expect(out.config.version).toBe(1);
  });

  test("file source: applies Turbo derivation", async () => {
    const out = await loadRepoConfig({
      repoFullName: "acme/widget",
      yamlText: "version: 1\nchecks:\n  lint: {}\n",
      packageJson: null,
      turboJson: { tasks: {} },
    });
    expect(out.source).toBe("file");
    if (out.source !== "file") throw new Error();
    expect(out.config.checks?.lint?.command).toBe("turbo run lint");
  });

  test("db source: returns the persisted row when no yaml", async () => {
    await upsertRepoConfigRow(
      "acme/widget",
      { version: 1, setup: ["echo persisted"] },
      "db",
    );
    const out = await loadRepoConfig({
      repoFullName: "acme/widget",
      yamlText: null,
      packageJson: null,
      turboJson: null,
    });
    expect(out.source).toBe("db");
    expect(out.config.setup).toEqual(["echo persisted"]);
  });

  test("inferred source: persists the auto-detected config and returns warning", async () => {
    const out = await loadRepoConfig({
      repoFullName: "acme/widget",
      yamlText: null,
      packageJson: { workspaces: ["apps/web"] },
      turboJson: { tasks: {} },
    });
    expect(out.source).toBe("inferred");
    if (out.source !== "inferred") throw new Error();
    expect(out.warning).toMatch(/no \.nigel\.yaml/i);
    expect(out.config.checks?.lint?.command).toBe("turbo run lint");
    // Verify persistence
    const out2 = await loadRepoConfig({
      repoFullName: "acme/widget",
      yamlText: null,
      packageJson: { workspaces: ["apps/web"] },
      turboJson: { tasks: {} },
    });
    expect(out2.source).toBe("db"); // second call hits DB row, not auto-detect
  });

  test("file source wins over an existing db row", async () => {
    await upsertRepoConfigRow(
      "acme/widget",
      { version: 1, setup: ["echo persisted"] },
      "db",
    );
    const out = await loadRepoConfig({
      repoFullName: "acme/widget",
      yamlText: "version: 1\nsetup: ['echo file']\n",
      packageJson: null,
      turboJson: null,
    });
    expect(out.source).toBe("file");
    expect(out.config.setup).toEqual(["echo file"]);
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `cd apps/web && POSTGRES_URL=postgresql://test:test@localhost:5433/test bun test lib/repo-config/resolver.test.ts`
Expected: module not found.

- [ ] **Step 3: Implement `resolver.ts`**

```ts
import { autoDetectRepoConfig } from "./auto-detect";
import { parseNigelYaml } from "./parse";
import { getRepoConfigRow, upsertRepoConfigRow } from "./repository";
import { applyTurboDerivation } from "./turbo-derive";
import type {
  LoadRepoConfigResult,
  PackageJsonLike,
  RepoConfig,
  TurboJsonLike,
} from "./types";

export type LoadRepoConfigInput = {
  repoFullName: string;
  yamlText: string | null;
  packageJson: PackageJsonLike | null;
  turboJson: TurboJsonLike | null;
};

const INFERRED_WARNING =
  "no .nigel.yaml found — inferred config used. Commit .nigel.yaml for canonical setup.";

export async function loadRepoConfig(
  input: LoadRepoConfigInput,
): Promise<LoadRepoConfigResult> {
  if (input.yamlText !== null) {
    const parsed = parseNigelYaml(input.yamlText);
    const derived = applyTurboDerivation(parsed, {
      turboJsonPresent: !!input.turboJson,
    });
    return { source: "file", config: derived };
  }

  const row = await getRepoConfigRow(input.repoFullName);
  if (row) {
    // Stored config has derivation already applied at write-time.
    return { source: row.source, config: row.configJson as RepoConfig };
  }

  const inferred = autoDetectRepoConfig({
    packageJson: input.packageJson,
    turboJson: input.turboJson,
  });
  await upsertRepoConfigRow(input.repoFullName, inferred, "inferred");
  return { source: "inferred", config: inferred, warning: INFERRED_WARNING };
}
```

The cast `row.configJson as RepoConfig` is acceptable because the only writer is `upsertRepoConfigRow`, which only accepts `RepoConfig`. We don't re-validate stored rows on read; if that becomes a concern, add a `safeParse` here in a later phase.

The `row.source` returned can be `'file'` only if a previous run upserted with that source — this primitive doesn't currently produce that case (file source skips the DB), so in practice DB rows are `'db'` or `'inferred'`. The type allows `'file'` for forward-compatibility with admin UI workflows that may insert checked-in file copies.

- [ ] **Step 4: Run, verify pass**

Run: `cd apps/web && POSTGRES_URL=postgresql://test:test@localhost:5433/test bun test lib/repo-config/resolver.test.ts`
Expected: 5/5 pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/repo-config/resolver.ts apps/web/lib/repo-config/resolver.test.ts
git commit -m "feat(repo-config): add loadRepoConfig with file > db > inferred resolution"
```

---

### Task 8: Add barrel export

**Files:**
- Create: `apps/web/lib/repo-config/index.ts`

- [ ] **Step 1: Write the file**

```ts
export { autoDetectRepoConfig } from "./auto-detect";
export type { AutoDetectInput } from "./auto-detect";
export { parseNigelYaml, RepoConfigParseError } from "./parse";
export {
  getRepoConfigRow,
  upsertRepoConfigRow,
  type RepoConfigRow,
} from "./repository";
export { loadRepoConfig, type LoadRepoConfigInput } from "./resolver";
export { applyTurboDerivation } from "./turbo-derive";
export {
  RepoConfigSchema,
  type LoadRepoConfigResult,
  type PackageJsonLike,
  type RepoConfig,
  type RepoConfigSource,
  type TurboJsonLike,
} from "./types";
```

- [ ] **Step 2: Run the full module test suite**

Run: `cd apps/web && POSTGRES_URL=postgresql://test:test@localhost:5433/test bun test lib/repo-config/`
Expected: 27 tests pass (5 types + 5 parse + 7 turbo + 6 auto-detect + 4 repository + 5 resolver = 32 — recount and update if new tests added).

- [ ] **Step 3: Run full quality gate**

Run: `cd /Users/matt/code/github.com/to11ai/nigel && bun run check && bunx turbo typecheck --filter=web`
Expected: 0 errors / 0 warnings; typecheck passes.

- [ ] **Step 4: Commit**

```bash
git add apps/web/lib/repo-config/index.ts
git commit -m "feat(repo-config): add barrel export"
```

---

### Task 9: Open PR

**Files:** none

- [ ] **Step 1: Push branch**

```bash
git push -u origin phase-3a-repo-config
```

- [ ] **Step 2: Open PR**

```bash
gh pr create --title "Phase 3a: repo config primitive (.nigel.yaml + repo_configs)" --body "$(cat <<'EOF'
## Summary

Phase 3a of the Nigel build-out: the pure-data half of repo configuration.

- Zod schema for `.nigel.yaml` covering setup, dev_server, turbo, checks, local_stack, monorepo, routes_for_visual_prover, frontend_globs.
- `parseNigelYaml(text)` with `RepoConfigParseError` for malformed YAML or schema violations.
- `applyTurboDerivation(config, { turboJsonPresent })` filling `checks.*.command` and `dev_server.command` from a per-check task map; explicit values win.
- `autoDetectRepoConfig({ packageJson, turboJson })` for repos without a `.nigel.yaml`.
- `repo_configs` table (migration 0042) with `(repo_full_name, config_json, source)` plus a unique index.
- `loadRepoConfig({ repoFullName, yamlText, packageJson, turboJson })` composing file > DB > inferred; the inferred branch persists the result so a second call returns from DB.

No sandbox runtime work in this PR — the resolver does not read from disk; callers pass in the YAML text. `local_stack` execution and `sandbox_snapshots` land in Phase 3b.

## Test plan

- [ ] `bun run ci` passes (lint + format + typecheck + tests).
- [ ] All 32 new repo-config tests pass against the test Postgres.
- [ ] Migration 0042 generates and applies cleanly.
- [ ] Vercel preview deploys (auto-applies migration on its branch DB).
EOF
)"
```

- [ ] **Step 3: Note the PR number**

The `gh pr create` output will print the PR URL. Record the number for Step 4.

- [ ] **Step 4: Hand off to babysit-pr**

After the PR opens, invoke `/babysit-pr` on the PR number. Address any Cursor Bugbot / Greptile findings using the same pattern as Phase 0/1/2 PRs (fix → reply → resolve thread).
