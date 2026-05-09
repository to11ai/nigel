# Nigel Phase 3b-1 — Local-Stack Primitives Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the pure-data primitives that Phase 3b-2 (sandbox-side compose orchestration) will consume: a profile resolver, a `sandbox_snapshots` table, an invalidation-key helper, and a thin DB repository for snapshots. No sandbox runtime work, no docker-compose calls — that's all 3b-2.

**Architecture:** All work lives under a new module `apps/web/lib/local-stack/`. Inputs are pure: profile resolution takes a `ResolvedSpecialist` (already a Phase 2 type), an optional dispatch override, an optional check override, and the `RepoConfig.local_stack` block; the resolver decides which named profile applies. The invalidation-key helper takes a map of file-path → contents (caller reads from disk/sandbox elsewhere) and returns a stable map of file-path → sha256 hex string, plus a single `keys_hash` derived from a sorted JSON of the map. The `sandbox_snapshots` repository looks up + upserts rows by `(repo_full_name, profile, keys_hash)`.

**Tech Stack:** Drizzle ORM (Postgres), Zod-derived types from `lib/repo-config/types`, Bun's test runner, `node:crypto` for sha256.

---

## File Structure

- Create:
  - `apps/web/lib/db/migrations/0043_<auto-named>.sql` — generated `sandbox_snapshots` migration.
  - `apps/web/lib/local-stack/types.ts` — exported types: `Profile`, `ResolveProfileInput`, `InvalidationKeysInput`.
  - `apps/web/lib/local-stack/resolve-profile.ts` — `resolveProfile(input)`; throws `LocalStackProfileNotResolvedError`.
  - `apps/web/lib/local-stack/resolve-profile.test.ts`
  - `apps/web/lib/local-stack/invalidation-keys.ts` — `computeInvalidationKeys(files)` and `hashInvalidationKeys(keys)`.
  - `apps/web/lib/local-stack/invalidation-keys.test.ts`
  - `apps/web/lib/local-stack/repository.ts` — `getSandboxSnapshot`, `upsertSandboxSnapshot`.
  - `apps/web/lib/local-stack/repository.test.ts`
  - `apps/web/lib/local-stack/index.ts` — barrel export.
- Modify:
  - `apps/web/lib/db/schema.ts` — append `sandbox_snapshots` table definition immediately after `repo_configs` so primitives stay colocated.

Each file has one concern. Test files are colocated.

---

## Profile resolution semantics (locked)

```ts
resolveProfile({
  specialist: ResolvedSpecialist,
  dispatch?: { local_stack_profile?: string },
  check?: { local_stack_profile?: string },
  localStack: NonNullable<RepoConfig["local_stack"]> | null,
}): ResolvedProfile | null
```

Order:

1. If `specialist.needsLocalStack === false` → return `null` (no stack needed for this run).
2. If `localStack === null` → throw `LocalStackProfileNotResolvedError` (specialist needs a stack but the repo doesn't define one).
3. If `dispatch?.local_stack_profile === "none"` → return `null` (per-call opt-out).
4. If `dispatch?.local_stack_profile` set → look up in `localStack.profiles`; throw if missing.
5. Else if `check?.local_stack_profile === "none"` → return `null`.
6. Else if `check?.local_stack_profile` set → look up in `localStack.profiles`; throw if missing.
7. Else → return `localStack.profiles[localStack.default_profile]` (the schema's `.refine` already guarantees this exists).

The `"none"` sentinel is per-spec line 518.

`ResolvedProfile`:

```ts
export type ResolvedProfile = {
  name: string;             // the profile key in localStack.profiles
  description: string | null;
  postUp: PostUpStep[];     // mirrors the schema's PostUpStep type
};
```

`LocalStackProfileNotResolvedError` carries: `specialistName`, `chain` (array of where we looked) so callers can produce a clear error message.

---

## Invalidation-key helper

```ts
computeInvalidationKeys(
  files: Record<string, string | Buffer | null>,
): Record<string, string>;
```

- For each `(path, contents)` entry: if `contents === null`, omit the entry. Otherwise compute `sha256(contents)` as lowercase hex and insert.
- Returns a new object with the same paths (minus nulls) mapped to hex digests.

```ts
hashInvalidationKeys(keys: Record<string, string>): string;
```

- Stably hash the key map: sort keys lexicographically, JSON-stringify into `[[path1, hash1], [path2, hash2], ...]`, sha256 of that string as lowercase hex.
- Used as the lookup column on `sandbox_snapshots`.

The caller decides which files matter (compose file, lockfile, migrations, seed scripts) — the helper is content-blind.

---

## DB schema

```ts
export const sandboxSnapshots = pgTable(
  "sandbox_snapshots",
  {
    id: text("id").primaryKey(),
    repoFullName: text("repo_full_name").notNull(),
    branchOrSha: text("branch_or_sha").notNull(),
    profile: text("profile").notNull(),
    baseSnapshotId: text("base_snapshot_id"),  // upstream Vercel Sandbox snapshot id; nullable until 3b-2 wires real captures
    invalidationKeys: jsonb("invalidation_keys")
      .$type<Record<string, string>>()
      .notNull(),
    keysHash: text("keys_hash").notNull(),
    builtAt: timestamp("built_at").defaultNow().notNull(),
    ttlUntil: timestamp("ttl_until"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
  },
  (table) => [
    uniqueIndex("sandbox_snapshots_lookup_idx").on(
      table.repoFullName,
      table.profile,
      table.keysHash,
    ),
    index("sandbox_snapshots_built_at_idx").on(table.builtAt),
  ],
);
```

`(repo_full_name, profile, keys_hash)` is unique — that's the cache lookup key. `branch_or_sha` and `size_bytes` are recorded for diagnostics; the cache lookup ignores branch.

---

## Tasks

### Task 1: Add `sandbox_snapshots` table + migration

**Files:**
- Modify: `apps/web/lib/db/schema.ts` (append after `repoConfigs`)
- Generate: `apps/web/lib/db/migrations/0043_*.sql`

- [ ] **Step 1: Append to `schema.ts`**

```ts
// sandbox_snapshots — cache of local-stack bootstrap states. A row records
// the upstream Vercel Sandbox snapshot id captured after `compose up` +
// post-up scripts ran successfully, keyed by repo + profile + a hash over
// the files that, if changed, force a fresh bootstrap (compose file,
// lockfile, migration files, seed scripts). The set of files contributing
// to `invalidation_keys` is the caller's choice; the cache lookup compares
// the full hash, not individual entries.
export const sandboxSnapshots = pgTable(
  "sandbox_snapshots",
  {
    id: text("id").primaryKey(),
    repoFullName: text("repo_full_name").notNull(),
    branchOrSha: text("branch_or_sha").notNull(),
    profile: text("profile").notNull(),
    baseSnapshotId: text("base_snapshot_id"),
    invalidationKeys: jsonb("invalidation_keys")
      .$type<Record<string, string>>()
      .notNull(),
    keysHash: text("keys_hash").notNull(),
    builtAt: timestamp("built_at").defaultNow().notNull(),
    ttlUntil: timestamp("ttl_until"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
  },
  (table) => [
    uniqueIndex("sandbox_snapshots_lookup_idx").on(
      table.repoFullName,
      table.profile,
      table.keysHash,
    ),
    index("sandbox_snapshots_built_at_idx").on(table.builtAt),
  ],
);
```

`bigint` and `index` are already imported.

- [ ] **Step 2: Generate the migration**

Run: `bun run --cwd apps/web db:generate`
Expected: a new `0043_*.sql` plus updated `meta/0043_snapshot.json` and `meta/_journal.json`.

- [ ] **Step 3: Inspect**

Read the new SQL. Confirm:
- `CREATE TABLE "sandbox_snapshots"` with all 10 columns.
- `CREATE UNIQUE INDEX "sandbox_snapshots_lookup_idx"` on (repo_full_name, profile, keys_hash).
- `CREATE INDEX "sandbox_snapshots_built_at_idx"` on built_at.
- No alters or drops elsewhere.

- [ ] **Step 4: Commit**

```bash
git add apps/web/lib/db/schema.ts apps/web/lib/db/migrations/0043_*.sql apps/web/lib/db/migrations/meta/0043_snapshot.json apps/web/lib/db/migrations/meta/_journal.json
git commit -m "feat(db): add sandbox_snapshots table (Phase 3b-1)"
```

---

### Task 2: Local-stack types

**Files:**
- Create: `apps/web/lib/local-stack/types.ts`

- [ ] **Step 1: Implementation**

```ts
import type { RepoConfig } from "@/lib/repo-config";

// A `post_up` step in resolved form. Mirrors the Zod-inferred schema
// shape but flattened to a discriminated union for ergonomics.
export type PostUpStep =
  | { kind: "shell"; cmd: string }
  | {
      kind: "shell";
      cmd: string;
      timeoutSeconds?: number;
      retry?: number;
    };

// A profile after the resolver has picked one. The `name` is the profile's
// key in `local_stack.profiles`; callers use it for logs/snapshots.
export type ResolvedProfile = {
  name: string;
  description: string | null;
  postUp: ResolvedPostUpStep[];
};

export type ResolvedPostUpStep = {
  cmd: string;
  timeoutSeconds: number | null;
  retry: number | null;
};

// The local_stack block from a fully-validated RepoConfig. Non-null.
export type RepoLocalStack = NonNullable<RepoConfig["local_stack"]>;
```

`PostUpStep` (the union form) is exported but the resolver's actual return type uses `ResolvedPostUpStep` (always-shaped object). This avoids a discriminated-union API for callers who don't need it.

- [ ] **Step 2: Commit**

No tests for a pure-types module.

```bash
git add apps/web/lib/local-stack/types.ts
git commit -m "feat(local-stack): add types module"
```

---

### Task 3: Profile resolver

**Files:**
- Create: `apps/web/lib/local-stack/resolve-profile.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/lib/local-stack/resolve-profile.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { ResolvedSpecialist } from "@/lib/specialists";
import {
  LocalStackProfileNotResolvedError,
  resolveProfile,
} from "./resolve-profile";
import type { RepoLocalStack } from "./types";

const specialistNoStack = (): ResolvedSpecialist => ({
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
});

const specialistNeedsStack = (): ResolvedSpecialist => ({
  ...specialistNoStack(),
  name: "e2e-tester",
  needsLocalStack: true,
});

const sampleStack = (): RepoLocalStack => ({
  compose_file: "docker-compose.yaml",
  wait_for: [],
  teardown_on_exit: true,
  profiles: {
    bare: { description: "minimal", post_up: [] },
    onboarded: {
      description: "default users",
      post_up: ["bun run db:seed"],
    },
  },
  default_profile: "bare",
});

describe("resolveProfile", () => {
  test("returns null when specialist does not need a stack", () => {
    expect(
      resolveProfile({
        specialist: specialistNoStack(),
        localStack: sampleStack(),
      }),
    ).toBeNull();
  });

  test("returns null when specialist does not need a stack even if no local_stack defined", () => {
    expect(
      resolveProfile({
        specialist: specialistNoStack(),
        localStack: null,
      }),
    ).toBeNull();
  });

  test("throws when specialist needs a stack but repo has no local_stack", () => {
    expect(() =>
      resolveProfile({
        specialist: specialistNeedsStack(),
        localStack: null,
      }),
    ).toThrow(LocalStackProfileNotResolvedError);
  });

  test("dispatch override wins over check and default", () => {
    const profile = resolveProfile({
      specialist: specialistNeedsStack(),
      dispatch: { local_stack_profile: "onboarded" },
      check: { local_stack_profile: "bare" },
      localStack: sampleStack(),
    });
    expect(profile?.name).toBe("onboarded");
  });

  test("dispatch 'none' opts out", () => {
    expect(
      resolveProfile({
        specialist: specialistNeedsStack(),
        dispatch: { local_stack_profile: "none" },
        localStack: sampleStack(),
      }),
    ).toBeNull();
  });

  test("check override wins over default when no dispatch override", () => {
    const profile = resolveProfile({
      specialist: specialistNeedsStack(),
      check: { local_stack_profile: "onboarded" },
      localStack: sampleStack(),
    });
    expect(profile?.name).toBe("onboarded");
  });

  test("check 'none' opts out", () => {
    expect(
      resolveProfile({
        specialist: specialistNeedsStack(),
        check: { local_stack_profile: "none" },
        localStack: sampleStack(),
      }),
    ).toBeNull();
  });

  test("falls back to default_profile when no overrides", () => {
    const profile = resolveProfile({
      specialist: specialistNeedsStack(),
      localStack: sampleStack(),
    });
    expect(profile?.name).toBe("bare");
  });

  test("throws when dispatch references an unknown profile", () => {
    expect(() =>
      resolveProfile({
        specialist: specialistNeedsStack(),
        dispatch: { local_stack_profile: "missing" },
        localStack: sampleStack(),
      }),
    ).toThrow(LocalStackProfileNotResolvedError);
  });

  test("throws when check references an unknown profile", () => {
    expect(() =>
      resolveProfile({
        specialist: specialistNeedsStack(),
        check: { local_stack_profile: "missing" },
        localStack: sampleStack(),
      }),
    ).toThrow(LocalStackProfileNotResolvedError);
  });

  test("normalizes post_up entries (string and object) into ResolvedPostUpStep[]", () => {
    const stack: RepoLocalStack = {
      ...sampleStack(),
      profiles: {
        full: {
          description: "full",
          post_up: [
            "bun run db:migrate",
            { cmd: "bun run db:seed", timeout_seconds: 30, retry: 2 },
          ],
        },
      },
      default_profile: "full",
    };
    const profile = resolveProfile({
      specialist: specialistNeedsStack(),
      localStack: stack,
    });
    expect(profile?.postUp).toEqual([
      { cmd: "bun run db:migrate", timeoutSeconds: null, retry: null },
      { cmd: "bun run db:seed", timeoutSeconds: 30, retry: 2 },
    ]);
  });
});
```

- [ ] **Step 2: Verify it fails**

Run: `cd apps/web && POSTGRES_URL=postgresql://test:test@localhost:5433/test bun test lib/local-stack/resolve-profile.test.ts`
Expected: module-not-found.

- [ ] **Step 3: Implement `resolve-profile.ts`**

```ts
import type { ResolvedSpecialist } from "@/lib/specialists";
import type {
  RepoLocalStack,
  ResolvedPostUpStep,
  ResolvedProfile,
} from "./types";

export type ResolveProfileInput = {
  specialist: ResolvedSpecialist;
  dispatch?: { local_stack_profile?: string };
  check?: { local_stack_profile?: string };
  localStack: RepoLocalStack | null;
};

export class LocalStackProfileNotResolvedError extends Error {
  readonly specialistName: string;
  readonly chain: string[];
  constructor(specialistName: string, chain: string[], reason: string) {
    super(
      `local stack profile not resolved for specialist '${specialistName}': ${reason} (tried: ${chain.join(" -> ")})`,
    );
    this.name = "LocalStackProfileNotResolvedError";
    this.specialistName = specialistName;
    this.chain = chain;
  }
}

const NONE = "none";

export function resolveProfile(
  input: ResolveProfileInput,
): ResolvedProfile | null {
  const { specialist, dispatch, check, localStack } = input;

  if (!specialist.needsLocalStack) return null;

  if (localStack === null) {
    throw new LocalStackProfileNotResolvedError(
      specialist.name,
      ["repo.local_stack"],
      "specialist requires a local stack but the repo's RepoConfig has no `local_stack` block",
    );
  }

  if (dispatch?.local_stack_profile === NONE) return null;
  if (dispatch?.local_stack_profile) {
    return lookupOrThrow(dispatch.local_stack_profile, localStack, specialist, [
      "dispatch.local_stack_profile",
    ]);
  }

  if (check?.local_stack_profile === NONE) return null;
  if (check?.local_stack_profile) {
    return lookupOrThrow(check.local_stack_profile, localStack, specialist, [
      "check.local_stack_profile",
    ]);
  }

  // The schema's .refine guarantees default_profile points at a real key,
  // but treat a missing entry as a thrown error rather than silently
  // returning null in case the localStack came from somewhere other than a
  // validated parse.
  return lookupOrThrow(
    localStack.default_profile,
    localStack,
    specialist,
    ["repo.default_profile"],
  );
}

function lookupOrThrow(
  name: string,
  localStack: RepoLocalStack,
  specialist: ResolvedSpecialist,
  chain: string[],
): ResolvedProfile {
  const entry = localStack.profiles[name];
  if (!entry) {
    throw new LocalStackProfileNotResolvedError(
      specialist.name,
      chain,
      `profile '${name}' not found in repo.local_stack.profiles`,
    );
  }
  return {
    name,
    description: entry.description ?? null,
    postUp: entry.post_up.map(normalizePostUp),
  };
}

function normalizePostUp(
  step: RepoLocalStack["profiles"][string]["post_up"][number],
): ResolvedPostUpStep {
  if (typeof step === "string") {
    return { cmd: step, timeoutSeconds: null, retry: null };
  }
  return {
    cmd: step.cmd,
    timeoutSeconds: step.timeout_seconds ?? null,
    retry: step.retry ?? null,
  };
}
```

- [ ] **Step 4: Run, verify pass**

Run: `cd apps/web && POSTGRES_URL=postgresql://test:test@localhost:5433/test bun test lib/local-stack/resolve-profile.test.ts`
Expected: 11/11 pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/local-stack/resolve-profile.ts apps/web/lib/local-stack/resolve-profile.test.ts
git commit -m "feat(local-stack): add profile resolver"
```

---

### Task 4: Invalidation-key helpers

**Files:**
- Create: `apps/web/lib/local-stack/invalidation-keys.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/lib/local-stack/invalidation-keys.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  computeInvalidationKeys,
  hashInvalidationKeys,
} from "./invalidation-keys";

describe("computeInvalidationKeys", () => {
  test("returns sha256 hex per file", () => {
    const out = computeInvalidationKeys({
      "docker-compose.yaml": "version: '3'\n",
      "package-lock.json": "{}",
    });
    expect(out["docker-compose.yaml"]).toMatch(/^[0-9a-f]{64}$/);
    expect(out["package-lock.json"]).toMatch(/^[0-9a-f]{64}$/);
  });

  test("omits null entries", () => {
    const out = computeInvalidationKeys({
      "docker-compose.yaml": "x",
      "missing.txt": null,
    });
    expect(out).not.toHaveProperty("missing.txt");
    expect(out["docker-compose.yaml"]).toMatch(/^[0-9a-f]{64}$/);
  });

  test("buffer and string with same bytes hash to the same value", () => {
    const out = computeInvalidationKeys({
      a: "hello",
      b: Buffer.from("hello", "utf-8"),
    });
    expect(out.a).toBe(out.b);
  });

  test("identical content at same path produces stable digest", () => {
    const a = computeInvalidationKeys({ x: "hello" });
    const b = computeInvalidationKeys({ x: "hello" });
    expect(a.x).toBe(b.x);
  });

  test("different content produces different digest", () => {
    const a = computeInvalidationKeys({ x: "hello" });
    const b = computeInvalidationKeys({ x: "world" });
    expect(a.x).not.toBe(b.x);
  });
});

describe("hashInvalidationKeys", () => {
  test("returns sha256 hex", () => {
    expect(hashInvalidationKeys({ "a.txt": "abc" })).toMatch(/^[0-9a-f]{64}$/);
  });

  test("is order-independent (sorts keys before hashing)", () => {
    const a = hashInvalidationKeys({
      "a.txt": "h1",
      "b.txt": "h2",
      "c.txt": "h3",
    });
    const b = hashInvalidationKeys({
      "c.txt": "h3",
      "a.txt": "h1",
      "b.txt": "h2",
    });
    expect(a).toBe(b);
  });

  test("differs when any key or value changes", () => {
    const base = hashInvalidationKeys({ "a.txt": "x" });
    expect(base).not.toBe(hashInvalidationKeys({ "a.txt": "y" }));
    expect(base).not.toBe(hashInvalidationKeys({ "b.txt": "x" }));
  });

  test("differs when an entry is added", () => {
    const a = hashInvalidationKeys({ "a.txt": "x" });
    const b = hashInvalidationKeys({ "a.txt": "x", "b.txt": "y" });
    expect(a).not.toBe(b);
  });

  test("empty map has a stable hash", () => {
    expect(hashInvalidationKeys({})).toMatch(/^[0-9a-f]{64}$/);
    expect(hashInvalidationKeys({})).toBe(hashInvalidationKeys({}));
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `cd apps/web && POSTGRES_URL=postgresql://test:test@localhost:5433/test bun test lib/local-stack/invalidation-keys.test.ts`
Expected: module-not-found.

- [ ] **Step 3: Implement `invalidation-keys.ts`**

```ts
import { createHash } from "node:crypto";

export function computeInvalidationKeys(
  files: Record<string, string | Buffer | null>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, contents] of Object.entries(files)) {
    if (contents === null) continue;
    const buf =
      typeof contents === "string" ? Buffer.from(contents, "utf-8") : contents;
    out[path] = createHash("sha256").update(buf).digest("hex");
  }
  return out;
}

export function hashInvalidationKeys(
  keys: Record<string, string>,
): string {
  const sorted = Object.keys(keys)
    .sort()
    .map((k) => [k, keys[k]] as const);
  return createHash("sha256")
    .update(JSON.stringify(sorted))
    .digest("hex");
}
```

- [ ] **Step 4: Run, verify pass**

Run: `cd apps/web && POSTGRES_URL=postgresql://test:test@localhost:5433/test bun test lib/local-stack/invalidation-keys.test.ts`
Expected: 10/10 pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/local-stack/invalidation-keys.ts apps/web/lib/local-stack/invalidation-keys.test.ts
git commit -m "feat(local-stack): add invalidation-key helpers"
```

---

### Task 5: Snapshot repository

**Files:**
- Create: `apps/web/lib/local-stack/repository.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/lib/local-stack/repository.test.ts`:

```ts
import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "@/lib/db/client";
import { sandboxSnapshots } from "@/lib/db/schema";
import {
  getSandboxSnapshot,
  upsertSandboxSnapshot,
} from "./repository";

beforeEach(async () => {
  await db.delete(sandboxSnapshots);
});

const sampleKeys = { "docker-compose.yaml": "abc", "bun.lock": "def" };
const sampleHash = "deadbeef".repeat(8); // 64 hex chars

describe("sandbox_snapshots repository", () => {
  test("getSandboxSnapshot returns null when no row", async () => {
    const row = await getSandboxSnapshot({
      repoFullName: "acme/widget",
      profile: "bare",
      keysHash: sampleHash,
    });
    expect(row).toBeNull();
  });

  test("upsert creates a new row", async () => {
    const row = await upsertSandboxSnapshot({
      repoFullName: "acme/widget",
      branchOrSha: "abc123",
      profile: "bare",
      baseSnapshotId: "vsbx-1",
      invalidationKeys: sampleKeys,
      keysHash: sampleHash,
      sizeBytes: 1024,
    });
    expect(row.repoFullName).toBe("acme/widget");
    expect(row.profile).toBe("bare");
    expect(row.keysHash).toBe(sampleHash);
    expect(row.baseSnapshotId).toBe("vsbx-1");
  });

  test("upsert updates the row in place when (repo, profile, keys_hash) collides", async () => {
    const a = await upsertSandboxSnapshot({
      repoFullName: "acme/widget",
      branchOrSha: "abc",
      profile: "bare",
      baseSnapshotId: "vsbx-1",
      invalidationKeys: sampleKeys,
      keysHash: sampleHash,
      sizeBytes: 100,
    });
    const b = await upsertSandboxSnapshot({
      repoFullName: "acme/widget",
      branchOrSha: "def",
      profile: "bare",
      baseSnapshotId: "vsbx-2",
      invalidationKeys: sampleKeys,
      keysHash: sampleHash,
      sizeBytes: 200,
    });
    expect(b.id).toBe(a.id);
    expect(b.baseSnapshotId).toBe("vsbx-2");
    expect(b.branchOrSha).toBe("def");
    expect(b.sizeBytes).toBe(200);
  });

  test("rows with different keys_hash are independent", async () => {
    const hashA = "a".repeat(64);
    const hashB = "b".repeat(64);
    await upsertSandboxSnapshot({
      repoFullName: "acme/widget",
      branchOrSha: "x",
      profile: "bare",
      baseSnapshotId: "vsbx-1",
      invalidationKeys: { f: "1" },
      keysHash: hashA,
    });
    await upsertSandboxSnapshot({
      repoFullName: "acme/widget",
      branchOrSha: "x",
      profile: "bare",
      baseSnapshotId: "vsbx-2",
      invalidationKeys: { f: "2" },
      keysHash: hashB,
    });
    const a = await getSandboxSnapshot({
      repoFullName: "acme/widget",
      profile: "bare",
      keysHash: hashA,
    });
    const b = await getSandboxSnapshot({
      repoFullName: "acme/widget",
      profile: "bare",
      keysHash: hashB,
    });
    expect(a?.baseSnapshotId).toBe("vsbx-1");
    expect(b?.baseSnapshotId).toBe("vsbx-2");
  });

  test("getSandboxSnapshot scopes by profile", async () => {
    await upsertSandboxSnapshot({
      repoFullName: "acme/widget",
      branchOrSha: "x",
      profile: "bare",
      baseSnapshotId: "vsbx-bare",
      invalidationKeys: { f: "1" },
      keysHash: sampleHash,
    });
    const other = await getSandboxSnapshot({
      repoFullName: "acme/widget",
      profile: "onboarded",
      keysHash: sampleHash,
    });
    expect(other).toBeNull();
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `cd apps/web && POSTGRES_URL=postgresql://test:test@localhost:5433/test bun test lib/local-stack/repository.test.ts`
Expected: module-not-found.

- [ ] **Step 3: Implement `repository.ts`**

```ts
import { and, eq } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db/client";
import { sandboxSnapshots } from "@/lib/db/schema";

export type SandboxSnapshotRow = InferSelectModel<typeof sandboxSnapshots>;

export type GetSandboxSnapshotInput = {
  repoFullName: string;
  profile: string;
  keysHash: string;
};

export async function getSandboxSnapshot(
  input: GetSandboxSnapshotInput,
): Promise<SandboxSnapshotRow | null> {
  const rows = await db
    .select()
    .from(sandboxSnapshots)
    .where(
      and(
        eq(sandboxSnapshots.repoFullName, input.repoFullName),
        eq(sandboxSnapshots.profile, input.profile),
        eq(sandboxSnapshots.keysHash, input.keysHash),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export type UpsertSandboxSnapshotInput = {
  repoFullName: string;
  branchOrSha: string;
  profile: string;
  baseSnapshotId: string | null;
  invalidationKeys: Record<string, string>;
  keysHash: string;
  ttlUntil?: Date | null;
  sizeBytes?: number | null;
};

export async function upsertSandboxSnapshot(
  input: UpsertSandboxSnapshotInput,
): Promise<SandboxSnapshotRow> {
  const inserted = await db
    .insert(sandboxSnapshots)
    .values({
      id: nanoid(),
      repoFullName: input.repoFullName,
      branchOrSha: input.branchOrSha,
      profile: input.profile,
      baseSnapshotId: input.baseSnapshotId,
      invalidationKeys: input.invalidationKeys,
      keysHash: input.keysHash,
      ttlUntil: input.ttlUntil ?? null,
      sizeBytes: input.sizeBytes ?? null,
    })
    .onConflictDoUpdate({
      target: [
        sandboxSnapshots.repoFullName,
        sandboxSnapshots.profile,
        sandboxSnapshots.keysHash,
      ],
      set: {
        branchOrSha: input.branchOrSha,
        baseSnapshotId: input.baseSnapshotId,
        invalidationKeys: input.invalidationKeys,
        ttlUntil: input.ttlUntil ?? null,
        sizeBytes: input.sizeBytes ?? null,
        builtAt: new Date(),
      },
    })
    .returning();
  return inserted[0];
}
```

The `onConflictDoUpdate` target matches the unique index on `(repoFullName, profile, keysHash)` — atomic upsert, no TOCTOU window.

- [ ] **Step 4: Run, verify pass**

Run: `cd apps/web && POSTGRES_URL=postgresql://test:test@localhost:5433/test bun test lib/local-stack/repository.test.ts`
Expected: 5/5 pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/local-stack/repository.ts apps/web/lib/local-stack/repository.test.ts
git commit -m "feat(local-stack): add sandbox_snapshots repository"
```

---

### Task 6: Barrel export + final checks

**Files:**
- Create: `apps/web/lib/local-stack/index.ts`

- [ ] **Step 1: Implementation**

```ts
export {
  computeInvalidationKeys,
  hashInvalidationKeys,
} from "./invalidation-keys";
export {
  type GetSandboxSnapshotInput,
  getSandboxSnapshot,
  type SandboxSnapshotRow,
  type UpsertSandboxSnapshotInput,
  upsertSandboxSnapshot,
} from "./repository";
export {
  LocalStackProfileNotResolvedError,
  type ResolveProfileInput,
  resolveProfile,
} from "./resolve-profile";
export type {
  PostUpStep,
  RepoLocalStack,
  ResolvedPostUpStep,
  ResolvedProfile,
} from "./types";
```

(Adjust ordering if Ultracite complains.)

- [ ] **Step 2: Run the full local-stack test suite**

```bash
cd apps/web
POSTGRES_URL=postgresql://test:test@localhost:5433/test bun test lib/local-stack/
```

Expected count: 11 (resolver) + 10 (invalidation) + 5 (repository) = 26.

- [ ] **Step 3: Run the broader regression suite**

```bash
cd apps/web
POSTGRES_URL=postgresql://test:test@localhost:5433/test bun test lib/runs/ lib/specialists/ lib/repo-config/ lib/local-stack/
```

Expected: previous totals + 26 new = ~127.

- [ ] **Step 4: Quality gates**

```bash
cd /Users/matt/code/github.com/to11ai/nigel
bun run check
bunx turbo typecheck --filter=web
```

Both must pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/local-stack/index.ts
git commit -m "feat(local-stack): add barrel export"
```

---

### Task 7: Open PR + babysit

**Files:** none

- [ ] **Step 1: Push**

```bash
git push -u origin phase-3b-1-local-stack-primitives
```

- [ ] **Step 2: Create PR**

If `gh pr create` fails with the GraphQL permissions error from PR #7, use REST:

```bash
gh api repos/to11ai/nigel/pulls -f title="Phase 3b-1: local-stack primitives (profile resolver + sandbox_snapshots)" -f head=phase-3b-1-local-stack-primitives -f base=main -f body="See docs/exec-plans/active/2026-05-08-nigel-phase-3b-1-local-stack-primitives-plan.md"
```

Then update the PR body via `gh api -X PATCH` with full markdown.

- [ ] **Step 3: Hand off to babysit-pr**

Address any Cursor Bugbot / Greptile findings using the same pattern as Phase 0/1/2/3a PRs.
