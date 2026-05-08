# Nigel Phase 0: Fork + Rebrand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the `to11ai/nigel` repository as a clean fork of `vercel-labs/open-agents` with branding swapped to Nigel, GitHub-only auth (Vercel OAuth removed), env vars renamed, upstream tracking documented, and a verified-working dev environment — ready for Phase 1's `Run` abstraction.

**Architecture:** A bare fork of upstream is created on GitHub, cloned into the working directory (preserving the already-written spec and this plan), then a sequence of localized renames swap branding. Vercel OAuth is removed from Better Auth config + UI + env example so only the GitHub provider is wired. Each rename is its own commit so upstream merges later can resolve conflicts surgically. After code changes, two Pulumi projects (`infra/data-neon`, `infra/vercel`) are added to mirror the `to11ai/platform/infra/{data-neon,vercel}` pattern — prod-only, no staging — provisioning Neon Postgres and the Vercel app linked to the GitHub repo. The dev server is started after each major group of edits to catch regressions early; the Vercel preview deploy is the deploy-side verification.

**Tech Stack:** Bun, Next.js (App Router), Better Auth, Drizzle, Postgres, Workflow SDK, Vercel Sandbox, Turbo, Biome (via Ultracite). Spec: [../../product-specs/2026-05-08-nigel-system-design.md](../../product-specs/2026-05-08-nigel-system-design.md).

---

## File structure (what this plan touches)

The fork inherits upstream's full tree. This plan renames or modifies only the files below; everything else stays identical to upstream.

| File | Why touched |
|---|---|
| `package.json` (root) | Rename `"name": "open-agents"` → `"name": "nigel"`; add `infra/*` to workspaces |
| `packages/agent/package.json` | Rename `@open-agents/agent` → `@nigel/agent` |
| `packages/sandbox/package.json` | Rename `@open-agents/sandbox` → `@nigel/sandbox` |
| `packages/shared/package.json` | Rename `@open-agents/shared` → `@nigel/shared` |
| All TS/TSX files importing `@open-agents/*` | Update imports to `@nigel/*` |
| `apps/web/app/layout.tsx` | Site title, description, theme localStorage key, metadataBase fallback URL |
| `apps/web/lib/auth/config.ts` | Remove Vercel social provider, drop Vercel mapping helper |
| `apps/web/.env.example` | Drop `NEXT_PUBLIC_VERCEL_APP_CLIENT_ID` + `VERCEL_APP_CLIENT_SECRET`; rename `OPEN_AGENTS_RESOURCE_PROFILE` → `NIGEL_RESOURCE_PROFILE` |
| `apps/web/lib/deployment/resource-profile.ts` | Rename env var read; rename functions/types `OpenAgents…` → `Nigel…` |
| `apps/web/lib/sandbox/config.ts` | Update import from renamed `resource-profile.ts` |
| `apps/web/components/auth/*` (Vercel sign-in button location) | Remove the "Continue with Vercel" UI affordance |
| `apps/web/app/deploy-your-own/page.tsx` | Update copy from "Open Agents" → "Nigel" |
| `apps/web/components/landing/github-link.tsx` | Update repo link to `to11ai/nigel` |
| `README.md` (root) | Replace upstream README with Nigel-specific README |
| `apps/web/README.md` | Same |
| `UPSTREAM.md` (new) | Records upstream repo URL + fork SHA + sync instructions |
| `infra/data-neon/{Pulumi.yaml,Pulumi.prod.yaml,index.ts,package.json,tsconfig.json,.gitignore,README.md}` (new) | Pulumi project provisioning Neon Postgres for prod |
| `infra/vercel/{Pulumi.yaml,Pulumi.prod.yaml,index.ts,package.json,tsconfig.json,.gitignore,README.md}` (new) | Pulumi project provisioning the Vercel app, custom domain, and POSTGRES_URL/BETTER_AUTH_SECRET + GitHub App env vars (applied in Task 18) |
| `infra/aws-dns/{Pulumi.yaml,Pulumi.prod.yaml,index.ts,package.json,tsconfig.json,.gitignore,README.md}` (new) | Pulumi project provisioning the Route53 hosted zone for `nigel.to11.ai` and the `app.nigel.to11.ai` CNAME (Task 15) |
| `docs/product-specs/2026-05-08-nigel-system-design.md` (existing) | Preserved across the clone, no edits |
| `docs/exec-plans/active/2026-05-08-nigel-phase-0-fork-and-rebrand-plan.md` (this file) | Preserved across the clone, no edits |
| `.agents/skills/**` and other upstream agent docs | Left untouched in Phase 0 — addressed when Phase 4's specialist roster arrives |

---

## Prerequisites

The engineer running this plan must have:

- `gh` CLI authenticated against an account with permission to create repos in the `to11ai` GitHub org.
- `bun` installed locally (version per upstream's `package.json` — currently `bun@1.2.14`).
- A reachable Postgres database (local or cloud) for the dev server smoke tests. Neon Postgres or local Postgres both work.
- A GitHub App created (or to be created) for sign-in. If not yet created, smoke-test sign-in is deferred to after the GitHub App exists.

If any prerequisite is missing, stop and resolve before starting Task 1.

---

### Task 1: Create the GitHub fork

**Files:**
- (no local files — pure GitHub state change)

- [ ] **Step 1: Verify gh auth + org access**

Run:

```bash
gh auth status
gh api /orgs/to11ai --jq '.login'
```

Expected output: authenticated as a user with `to11ai` membership; second command prints `to11ai`.

- [ ] **Step 2: Create the fork in the to11ai org as `nigel`**

Run:

```bash
gh repo fork vercel-labs/open-agents \
  --org to11ai \
  --fork-name nigel \
  --clone=false
```

Expected output: `✓ Created fork to11ai/nigel`. If the fork already exists, gh prints a notice and exits 0 — this is acceptable (idempotent).

- [ ] **Step 3: Verify fork exists and capture upstream SHA**

Run:

```bash
gh repo view to11ai/nigel --json url,parent --jq '{url, parent: .parent.nameWithOwner}'
gh api repos/vercel-labs/open-agents/commits/main --jq '.sha' > /tmp/upstream-sha.txt
cat /tmp/upstream-sha.txt
```

Expected: prints `{"url":"https://github.com/to11ai/nigel","parent":"vercel-labs/open-agents"}` and a 40-char SHA. Save the SHA — Task 3 records it in `UPSTREAM.md`.

---

### Task 2: Clone fork into working dir, preserving spec + plan

**Files:**
- Backup, clone, restore: `/Users/matt/code/github.com/to11ai/nigel/`

The working directory currently contains only the spec and this plan (no `.git`). `git clone` refuses non-empty targets, so we move the docs out, clone, move them back.

- [ ] **Step 1: Verify working dir contents are exactly the docs**

Run:

```bash
cd /Users/matt/code/github.com/to11ai/nigel
ls -A
find docs -type f
```

Expected: `ls -A` shows only `docs`. `find docs -type f` shows exactly two files:
- `docs/product-specs/2026-05-08-nigel-system-design.md`
- `docs/exec-plans/active/2026-05-08-nigel-phase-0-fork-and-rebrand-plan.md`

If anything else is present, stop and reconcile before proceeding.

- [ ] **Step 2: Backup the docs**

Run:

```bash
mkdir -p /tmp/nigel-bootstrap
cp -R /Users/matt/code/github.com/to11ai/nigel/docs /tmp/nigel-bootstrap/
ls -R /tmp/nigel-bootstrap/docs
```

Expected: tree printed shows the two markdown files inside `/tmp/nigel-bootstrap/docs/...`.

- [ ] **Step 3: Remove the working dir and clone fork into it**

Run:

```bash
rm -rf /Users/matt/code/github.com/to11ai/nigel
git clone git@github.com:to11ai/nigel.git /Users/matt/code/github.com/to11ai/nigel
cd /Users/matt/code/github.com/to11ai/nigel
git log -1 --oneline
```

Expected: clone succeeds, `git log` shows the most recent upstream commit (mirrored into the fork). If clone fails, fall back to HTTPS: `git clone https://github.com/to11ai/nigel.git ...`.

- [ ] **Step 4: Restore docs from backup**

Run:

```bash
mkdir -p docs/product-specs docs/exec-plans/active
cp /tmp/nigel-bootstrap/docs/product-specs/2026-05-08-nigel-system-design.md docs/product-specs/
cp /tmp/nigel-bootstrap/docs/exec-plans/active/2026-05-08-nigel-phase-0-fork-and-rebrand-plan.md docs/exec-plans/active/
ls docs/product-specs docs/exec-plans/active
```

Expected: each directory contains its respective markdown file.

- [ ] **Step 5: Stage docs and commit**

Run:

```bash
git checkout -b phase-0-fork-and-rebrand
git add docs/product-specs/2026-05-08-nigel-system-design.md docs/exec-plans/active/2026-05-08-nigel-phase-0-fork-and-rebrand-plan.md
git status
git commit -m "docs: add Nigel system design spec and Phase 0 plan"
```

Expected: clean status afterward. If any other untracked files appear, stop and investigate — this should be exactly two new files.

---

### Task 3: Add upstream remote + record upstream SHA

**Files:**
- Create: `UPSTREAM.md`

- [ ] **Step 1: Add upstream remote and fetch**

Run:

```bash
git remote add upstream https://github.com/vercel-labs/open-agents.git
git fetch upstream
git remote -v
```

Expected: `git remote -v` prints both `origin` (to11ai/nigel) and `upstream` (vercel-labs/open-agents) with fetch and push entries each.

- [ ] **Step 2: Create `UPSTREAM.md` with the captured SHA**

Use the SHA captured in Task 1 Step 3. Replace `<SHA>` below with the actual value (e.g., `a1b2c3d…`). Read with: `cat /tmp/upstream-sha.txt`.

Create `UPSTREAM.md`:

```markdown
# Upstream tracking

Nigel is a fork of [vercel-labs/open-agents](https://github.com/vercel-labs/open-agents).

## Fork base

- Upstream: `vercel-labs/open-agents`
- Forked from commit: `<SHA>`
- Fork date: 2026-05-08

## Sync workflow

To pull changes from upstream:

```sh
git fetch upstream
git checkout main
git merge upstream/main
# resolve conflicts (most divergence is in apps/web routes and Drizzle schema)
git push origin main
```

When syncing, also update this file's "Last synced commit" entry below.

## Sync history

| Date | Upstream SHA | Notes |
|------|--------------|-------|
| 2026-05-08 | `<SHA>` | Initial fork |
```

- [ ] **Step 3: Substitute the actual SHA into the file**

Run:

```bash
SHA=$(cat /tmp/upstream-sha.txt)
sed -i.bak "s|<SHA>|$SHA|g" UPSTREAM.md
rm UPSTREAM.md.bak
grep -c '<SHA>' UPSTREAM.md
cat UPSTREAM.md
```

Expected: `grep -c '<SHA>' UPSTREAM.md` prints `0` (no placeholders left). The printed file shows the real SHA in two places (the "Forked from commit" line and the sync history table).

- [ ] **Step 4: Commit**

Run:

```bash
git add UPSTREAM.md
git commit -m "docs: track upstream open-agents SHA in UPSTREAM.md"
```

---

### Task 4: Pre-rename smoke test (verify upstream code runs unchanged)

This task is the regression baseline. Get the dev server running on the unchanged fork before any rename so any post-rename failure is unambiguously caused by the rename.

**Files:**
- Create: `apps/web/.env` (gitignored, local only)

- [ ] **Step 1: Install dependencies**

Run:

```bash
bun install
```

Expected: install completes without errors. Note any deprecation warnings for follow-up but do not address now.

- [ ] **Step 2: Create local `.env` for the web app**

Copy the upstream example as the starting point:

```bash
cp apps/web/.env.example apps/web/.env
```

Then edit `apps/web/.env` and fill the minimum-required values for the dev server to boot:

- `POSTGRES_URL` — your local Postgres URL.
- `BETTER_AUTH_SECRET` — generate with `openssl rand -base64 32` and paste.

Leave Vercel and GitHub OAuth values blank for now; they are validated at sign-in time, not boot time.

- [ ] **Step 3: Start the dev server**

Run:

```bash
bun run web
```

Expected: server starts on port 3000. Open `http://localhost:3000` in a browser and verify the landing page renders. Do not attempt sign-in — there is no GitHub App yet.

- [ ] **Step 4: Stop the dev server**

Press `Ctrl-C`. No commit yet — `.env` is gitignored.

---

### Task 5: Rename root workspace `package.json` to `nigel`

**Files:**
- Modify: `package.json` (root)

- [ ] **Step 1: Read current name field**

Run:

```bash
grep -n '"name"' package.json | head -1
```

Expected: `2:  "name": "open-agents",`

- [ ] **Step 2: Rename to nigel**

Edit `package.json`. Change:

```json
  "name": "open-agents",
```

to:

```json
  "name": "nigel",
```

- [ ] **Step 3: Verify**

Run:

```bash
grep '"name"' package.json | head -1
```

Expected: `  "name": "nigel",`

- [ ] **Step 4: Commit**

Run:

```bash
git add package.json
git commit -m "rebrand: rename root package to nigel"
```

---

### Task 6: Rename workspace packages `@open-agents/*` → `@nigel/*`

Three workspace packages get renamed. Each rename is one commit so a future upstream merge can isolate changes per package.

**Files:**
- Modify: `packages/agent/package.json`, `packages/sandbox/package.json`, `packages/shared/package.json`
- Modify: every TS/TSX file importing from `@open-agents/{agent,sandbox,shared}`

- [ ] **Step 1: Rename `@open-agents/agent` → `@nigel/agent`**

Edit `packages/agent/package.json`. Change:

```json
  "name": "@open-agents/agent",
```

to:

```json
  "name": "@nigel/agent",
```

- [ ] **Step 2: Update all imports of `@open-agents/agent`**

Find them:

```bash
grep -rl '@open-agents/agent' --include='*.ts' --include='*.tsx' --include='*.json' .
```

Then replace across the listed files (do not include matches inside `packages/agent/package.json` — that one was edited above, but the package's own files may contain self-imports if any):

```bash
grep -rl '@open-agents/agent' --include='*.ts' --include='*.tsx' --include='*.json' . \
  | xargs sed -i.bak 's|@open-agents/agent|@nigel/agent|g'
find . -name '*.bak' -delete
```

Expected: no matches remain. Verify:

```bash
grep -rn '@open-agents/agent' --include='*.ts' --include='*.tsx' --include='*.json' . | head
```

Expected: empty output.

- [ ] **Step 3: Run install + typecheck to confirm renames are coherent**

Run:

```bash
bun install
bun run typecheck
```

Expected: install succeeds (it should re-link the renamed workspace package). Typecheck passes. If typecheck fails with "cannot find module `@nigel/agent`", run `bun install` again — workspace symlinks may need a refresh.

- [ ] **Step 4: Commit**

Run:

```bash
git add -A
git commit -m "rebrand: rename @open-agents/agent to @nigel/agent"
```

- [ ] **Step 5: Repeat for `@open-agents/sandbox` → `@nigel/sandbox`**

Edit `packages/sandbox/package.json`:

```json
  "name": "@nigel/sandbox",
```

Update imports:

```bash
grep -rl '@open-agents/sandbox' --include='*.ts' --include='*.tsx' --include='*.json' . \
  | xargs sed -i.bak 's|@open-agents/sandbox|@nigel/sandbox|g'
find . -name '*.bak' -delete
grep -rn '@open-agents/sandbox' --include='*.ts' --include='*.tsx' --include='*.json' . | head
```

Expected: empty output from grep.

Run:

```bash
bun install
bun run typecheck
```

Expected: passes.

Commit:

```bash
git add -A
git commit -m "rebrand: rename @open-agents/sandbox to @nigel/sandbox"
```

- [ ] **Step 6: Repeat for `@open-agents/shared` → `@nigel/shared`**

Edit `packages/shared/package.json`:

```json
  "name": "@nigel/shared",
```

Update imports:

```bash
grep -rl '@open-agents/shared' --include='*.ts' --include='*.tsx' --include='*.json' . \
  | xargs sed -i.bak 's|@open-agents/shared|@nigel/shared|g'
find . -name '*.bak' -delete
grep -rn '@open-agents/shared' --include='*.ts' --include='*.tsx' --include='*.json' . | head
```

Expected: empty output.

Run:

```bash
bun install
bun run typecheck
```

Expected: passes.

Commit:

```bash
git add -A
git commit -m "rebrand: rename @open-agents/shared to @nigel/shared"
```

- [ ] **Step 7: Sweep for stragglers**

Some upstream files (`AGENTS.md`, `CLAUDE.md`, skill markdown) reference `@open-agents/*` in prose. Find them:

```bash
grep -rn '@open-agents' . | grep -v node_modules | grep -v .git
```

Expected: any remaining matches are inside markdown / agent skill files. Do **not** modify those in Phase 0 — they are addressed in Phase 4 when the specialist roster ships. They have no compile-time effect.

---

### Task 7: Rebrand site title, description, and theme storage key

**Files:**
- Modify: `apps/web/app/layout.tsx`

- [ ] **Step 1: Read current layout**

Run:

```bash
grep -n -E '(open-agents|Open Agents|metadataBase|themeInitializationScript|storageKey)' apps/web/app/layout.tsx
```

Expected: lines for `themeInitializationScript`'s `storageKey` (currently `"open-agents-theme"`), `metadataBase` fallback URL (currently `https://open-agents.dev`), `metadata.title.default` and `template` (currently `"Open Agents"` / `"%s | Open Agents"`), and the `description` string mentioning "AI SDK, Gateway, Sandbox, and Workflow SDK".

- [ ] **Step 2: Apply renames**

Edit `apps/web/app/layout.tsx`:

Change:

```ts
  const storageKey = "open-agents-theme";
```

to:

```ts
  const storageKey = "nigel-theme";
```

Change:

```ts
    : new URL("https://open-agents.dev");
```

to:

```ts
    : new URL("https://app.nigel.to11.ai");
```

(If a different production URL is preferred, substitute it. The exact URL is not load-bearing for Phase 0 — it is the metadataBase fallback only.)

Change:

```ts
  title: {
    default: "Open Agents",
    template: "%s | Open Agents",
  },
  description:
    "Spawn coding agents that run infinitely in the cloud. Powered by AI SDK, Gateway, Sandbox, and Workflow SDK.",
```

to:

```ts
  title: {
    default: "Nigel",
    template: "%s | Nigel",
  },
  description:
    "Hierarchical coding agents triggered by Linear tickets, chat, and chained dispatch. Powered by AI Gateway, Vercel Sandbox, and Workflow SDK.",
```

- [ ] **Step 3: Verify**

Run:

```bash
grep -n -E '(open-agents|Open Agents)' apps/web/app/layout.tsx || echo "clean"
```

Expected: prints `clean`.

- [ ] **Step 4: Commit**

Run:

```bash
git add apps/web/app/layout.tsx
git commit -m "rebrand: site title, description, and theme storage key to Nigel"
```

---

### Task 8: Rename `OPEN_AGENTS_RESOURCE_PROFILE` env var

**Files:**
- Modify: `apps/web/lib/deployment/resource-profile.ts`
- Modify: `apps/web/lib/sandbox/config.ts` (consumer of the renamed exports)
- Modify: `apps/web/.env.example`
- Modify: `apps/web/SANDBOX-LIFECYCLE.md` (mentions the env var in docs)
- Modify: `README.md` (mentions the env var in docs — overwritten in Task 11; rename here just to keep this commit cohesive)

- [ ] **Step 1: Read current resource-profile module**

Run:

```bash
cat apps/web/lib/deployment/resource-profile.ts
```

Expected output:

```ts
export type OpenAgentsResourceProfile = "standard" | "hobby";

export function getOpenAgentsResourceProfile(): OpenAgentsResourceProfile {
  return process.env.OPEN_AGENTS_RESOURCE_PROFILE === "hobby"
    ? "hobby"
    : "standard";
}

export function isHobbyResourceProfile(): boolean {
  return getOpenAgentsResourceProfile() === "hobby";
}
```

- [ ] **Step 2: Rewrite the module**

Edit `apps/web/lib/deployment/resource-profile.ts`:

```ts
export type NigelResourceProfile = "standard" | "hobby";

export function getNigelResourceProfile(): NigelResourceProfile {
  return process.env.NIGEL_RESOURCE_PROFILE === "hobby"
    ? "hobby"
    : "standard";
}

export function isHobbyResourceProfile(): boolean {
  return getNigelResourceProfile() === "hobby";
}
```

- [ ] **Step 3: Update the consumer**

Find and update the import in `apps/web/lib/sandbox/config.ts`. Run:

```bash
grep -n 'getOpenAgentsResourceProfile\|OpenAgentsResourceProfile' apps/web/lib/sandbox/config.ts
```

For each match, replace with the renamed identifier (`getOpenAgentsResourceProfile` → `getNigelResourceProfile`, `OpenAgentsResourceProfile` → `NigelResourceProfile`). Use Edit to make the changes; do not use sed here because the import path itself is unchanged and we want surgical changes.

- [ ] **Step 4: Sweep for any other consumers in code**

Run:

```bash
grep -rn 'OPEN_AGENTS_RESOURCE_PROFILE\|getOpenAgentsResourceProfile\|OpenAgentsResourceProfile' \
  --include='*.ts' --include='*.tsx' .
```

Expected: matches only in `apps/web/lib/deployment/resource-profile.ts` (now using new names) and any consumers updated in Step 3. If any TS/TSX file still has old names, edit it.

- [ ] **Step 5: Update env example**

Edit `apps/web/.env.example`. Replace:

```env
OPEN_AGENTS_RESOURCE_PROFILE=
```

with:

```env
NIGEL_RESOURCE_PROFILE=
```

Also replace the surrounding comment if it mentions "Open Agents" — adjust copy to read:

```env
# Optional deployment refinements
# Set to "hobby" to use lower resource defaults for constrained deployments.
# Leave unset for standard behavior.
NIGEL_RESOURCE_PROFILE=
```

- [ ] **Step 6: Update doc references**

Find any markdown references:

```bash
grep -rn 'OPEN_AGENTS_RESOURCE_PROFILE\|OpenAgentsResourceProfile' --include='*.md' .
```

For each match in `apps/web/SANDBOX-LIFECYCLE.md`, replace `OPEN_AGENTS_RESOURCE_PROFILE` with `NIGEL_RESOURCE_PROFILE`. Skip `README.md` for now — it's overwritten in Task 11.

- [ ] **Step 7: Typecheck**

Run:

```bash
bun run typecheck
```

Expected: passes.

- [ ] **Step 8: Commit**

Run:

```bash
git add -A
git commit -m "rebrand: rename OPEN_AGENTS_RESOURCE_PROFILE to NIGEL_RESOURCE_PROFILE"
```

---

### Task 9: Strip Vercel OAuth from Better Auth config

**Files:**
- Modify: `apps/web/lib/auth/config.ts`

- [ ] **Step 1: Read current config**

Run:

```bash
sed -n '1,40p' apps/web/lib/auth/config.ts
sed -n '70,90p' apps/web/lib/auth/config.ts
sed -n '140,170p' apps/web/lib/auth/config.ts
```

Confirm the file imports `VercelProfile`, defines `mapVercelProfileToUser`, lists `"vercel"` in `trustedProviders`, and has a `vercel:` block in `socialProviders`.

- [ ] **Step 2: Remove Vercel-specific code**

Edit `apps/web/lib/auth/config.ts`:

1. In the `import type { GithubProfile, VercelProfile } from "better-auth/social-providers";` line, remove the `VercelProfile` import:

   ```ts
   import type { GithubProfile } from "better-auth/social-providers";
   ```

2. Delete the entire `mapVercelProfileToUser` function (typically 8–10 lines).

3. In `account.accountLinking.trustedProviders`, change:

   ```ts
   trustedProviders: ["vercel", "github"],
   ```

   to:

   ```ts
   trustedProviders: ["github"],
   ```

4. In `socialProviders`, delete the entire `vercel: { … }` block. Final shape:

   ```ts
     socialProviders: {
       github: {
         clientId: process.env.NEXT_PUBLIC_GITHUB_CLIENT_ID ?? "",
         clientSecret: process.env.GITHUB_CLIENT_SECRET ?? "",
         mapProfileToUser: mapGitHubProfileToUser,
       },
     },
   ```

- [ ] **Step 3: Verify no Vercel references remain in this file**

Run:

```bash
grep -n -i 'vercel' apps/web/lib/auth/config.ts || echo "clean"
```

Expected: prints `clean`.

- [ ] **Step 4: Typecheck**

Run:

```bash
bun run typecheck
```

Expected: passes. If a downstream import of `mapVercelProfileToUser` exists (unlikely — it's a private helper), the typecheck will surface it; remove the offending import.

- [ ] **Step 5: Commit**

Run:

```bash
git add apps/web/lib/auth/config.ts
git commit -m "auth: remove Vercel OAuth provider; GitHub-only"
```

---

### Task 10: Strip Vercel OAuth from `.env.example` and remove the Vercel sign-in UI affordance

**Files:**
- Modify: `apps/web/.env.example`
- Modify: `apps/web/components/auth/*` (specifically the sign-in UI containing the Vercel button — exact file confirmed in Step 1)

- [ ] **Step 1: Find the sign-in UI file(s)**

Run:

```bash
grep -rln 'vercel' apps/web/components/auth/ apps/web/app/ --include='*.tsx' \
  | xargs grep -l 'signIn\|social' 2>/dev/null
```

Expected: one or two TSX files. The most likely candidates are `apps/web/components/auth/sign-in-form.tsx` (or similar) and any landing-page hero that has a "Continue with Vercel" button. Note the actual paths returned.

- [ ] **Step 2: Remove the Vercel sign-in button**

For each file identified in Step 1, find the `<button>` / `<form>` / `<a>` element labeled "Continue with Vercel" or similar, and any associated `signIn.social({ provider: "vercel" })` call. Delete the button JSX and the `vercel` provider call. Keep the GitHub equivalent intact.

If a file becomes a single-button (GitHub-only) form, simplify the surrounding wrapper (e.g., remove the divider "or" between the two buttons).

- [ ] **Step 3: Strip Vercel env vars from `.env.example`**

Edit `apps/web/.env.example`. Delete these lines (and the comment header above them):

```env
# Vercel OAuth (required for sign-in)
NEXT_PUBLIC_VERCEL_APP_CLIENT_ID=
VERCEL_APP_CLIENT_SECRET=
```

The "Minimum runtime" section at the top remains. The GitHub App section becomes the primary OAuth section. Update the GitHub section comment if it implies Vercel is also required.

- [ ] **Step 4: Verify**

Run:

```bash
grep -n -i 'vercel' apps/web/.env.example
```

Expected: only matches inside the `VERCEL_PROJECT_PRODUCTION_URL`, `NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL`, and `VERCEL_SANDBOX_BASE_SNAPSHOT_ID` blocks (these are Vercel platform vars, not OAuth, and stay).

```bash
grep -rn 'vercel.*sign\|provider.*vercel\|"vercel"' apps/web/components/ apps/web/app/ --include='*.tsx' \
  | grep -v 'VercelProfile\|vercel.com\|vercel-' \
  | head
```

Expected: empty (all OAuth-related Vercel references removed).

- [ ] **Step 5: Smoke test**

Run:

```bash
bun run typecheck
bun run web
```

Expected: typecheck passes; dev server boots; landing page shows only the GitHub sign-in button. Stop the server with `Ctrl-C`.

- [ ] **Step 6: Commit**

Run:

```bash
git add -A
git commit -m "auth: drop Vercel OAuth from env example and sign-in UI"
```

---

### Task 11: Replace README and deploy-your-own copy

**Files:**
- Modify: `README.md` (root)
- Modify: `apps/web/README.md`
- Modify: `apps/web/app/deploy-your-own/page.tsx`
- Modify: `apps/web/components/landing/github-link.tsx`

- [ ] **Step 1: Replace root README**

Overwrite `README.md` with Nigel-specific content:

```markdown
# Nigel

Nigel is a fork of [vercel-labs/open-agents](https://github.com/vercel-labs/open-agents) extended with hierarchical multi-agent orchestration, Linear ticket triggers, an expanded tool surface (browser, database, cloud, MCP, Slack), per-repo `.nigel.yaml` config, and Datadog-backed observability.

See [docs/product-specs/2026-05-08-nigel-system-design.md](docs/product-specs/2026-05-08-nigel-system-design.md) for the design.

See [UPSTREAM.md](UPSTREAM.md) for upstream tracking and sync workflow.

## Status

Phase 0 complete: forked, rebranded, GitHub-only auth.
Subsequent phases live in `docs/exec-plans/active/`.

## Local setup

```sh
bun install
cp apps/web/.env.example apps/web/.env
# fill in POSTGRES_URL, BETTER_AUTH_SECRET, and GitHub App credentials
bun run web
```

## Auth

Nigel uses [Better Auth](https://www.better-auth.com/) with GitHub as the only social provider. The GitHub App's OAuth credentials are also used for repo access, pushes, and PRs.

## Deploy

Same shape as upstream: deploy `apps/web` to Vercel, attach Postgres, configure GitHub App credentials. Vercel OAuth is not used.
```

- [ ] **Step 2: Replace `apps/web/README.md` with a thin pointer**

Overwrite `apps/web/README.md`:

```markdown
# Nigel — Web App

The Next.js web app for Nigel. See the root [README](../../README.md) and the [system design spec](../../docs/product-specs/2026-05-08-nigel-system-design.md).
```

- [ ] **Step 3: Update deploy-your-own page**

Run:

```bash
grep -n 'Open Agents\|open-agents' apps/web/app/deploy-your-own/page.tsx
```

For each occurrence, replace "Open Agents" with "Nigel" in human-facing copy. Do not replace string fragments inside URLs that point to the upstream repo if any (those should be updated to point at `to11ai/nigel` only if the page links the user to fork-able source — adjust based on what the page actually does).

- [ ] **Step 4: Update GitHub link component**

Run:

```bash
grep -n 'open-agents\|Open Agents' apps/web/components/landing/github-link.tsx
```

Replace the link target with `https://github.com/to11ai/nigel` and the visible label with "Nigel" if there is one.

- [ ] **Step 5: Sweep for remaining user-facing "Open Agents" strings in TSX**

Run:

```bash
grep -rn 'Open Agents' apps/web/components/ apps/web/app/ --include='*.tsx'
```

For each match in user-facing JSX, replace with "Nigel". Skip any inside `.agents/skills/**` (Phase 4 territory).

- [ ] **Step 6: Smoke test the dev server**

Run:

```bash
bun run typecheck
bun run web
```

Expected: typecheck passes; dev server renders landing page with "Nigel" branding throughout. Stop with `Ctrl-C`.

- [ ] **Step 7: Commit**

Run:

```bash
git add README.md apps/web/README.md apps/web/app/deploy-your-own/page.tsx apps/web/components/landing/github-link.tsx
git add -A apps/web/components apps/web/app
git commit -m "rebrand: README, deploy page, and landing copy → Nigel"
```

---

### Task 12: Final code-side lint + typecheck

**Files:**
- (none — verification only)

- [ ] **Step 1: Run the full project check**

Run:

```bash
bun run check
bun run typecheck
```

Expected: both pass. The `check` script runs Ultracite (Biome). If it reports formatting issues from any of the prior edits, run `bun run fix`, review the changes (`git diff`), and commit them with message `style: apply ultracite fix after rebrand`.

- [ ] **Step 2: Confirm the tree is clean**

Run:

```bash
git status
```

Expected: `nothing to commit, working tree clean`.

- [ ] **Step 3: Verify the commit history is logical**

Run:

```bash
git log --oneline main..HEAD
```

Expected: a sequence of small, focused commits starting with `docs: add Nigel system design spec…` and ending with the README rebrand commit. Each commit should be revertible independently. The branch is **not pushed yet** — it gets pushed in Task 19 after the Vercel project exists, so the very first push triggers a deploy.

---

### Task 13: Add `infra/data-neon/` Pulumi project

This task and Tasks 14–16 mirror the pattern in `to11ai/platform/infra/{data-neon,vercel}` (see `vercel-labs/open-agents` is the upstream for the app code; `to11ai/platform` is the reference for the infra shape). Nigel is **prod-only** — there is no `dev` or `stg` stack.

Pulumi org: `to11`. Project names: `nigel-data-neon` and `nigel-vercel` (distinct from platform's `data-neon` / `vercel` projects so the two repos' stacks don't collide).

**Files:**
- Create: `infra/data-neon/Pulumi.yaml`
- Create: `infra/data-neon/Pulumi.prod.yaml`
- Create: `infra/data-neon/index.ts`
- Create: `infra/data-neon/package.json`
- Create: `infra/data-neon/tsconfig.json`
- Create: `infra/data-neon/.gitignore`
- Create: `infra/data-neon/README.md`
- Modify: `package.json` (root) — add `infra/*` to `workspaces.packages`

#### Prerequisites

- Pulumi CLI installed locally (`pulumi version` returns a valid version).
- Logged into Pulumi Cloud (`pulumi whoami` prints your username).
- Member of the `to11` Pulumi org.
- Neon API key already used by `to11ai/platform` (kislerdm/neon provider). Same key works here.

- [ ] **Step 1: Add `infra/*` to root workspaces**

Edit root `package.json`. The current `workspaces.packages` is:

```json
  "workspaces": {
    "packages": [
      "apps/*",
      "packages/*"
    ],
```

Change to:

```json
  "workspaces": {
    "packages": [
      "apps/*",
      "packages/*",
      "infra/*"
    ],
```

- [ ] **Step 2: Create `infra/data-neon/Pulumi.yaml`**

```yaml
name: nigel-data-neon
runtime:
  name: nodejs
  options:
    packagemanager: bun
    nodeargs: "--import tsx"
description: Pulumi project for Nigel's Neon Postgres database (prod-only)
main: index.ts
packages:
  neon:
    source: pulumi/pulumi/terraform-provider
    version: v0.13.0
    parameters:
      - kislerdm/neon
      - 0.13.0
```

- [ ] **Step 3: Create `infra/data-neon/Pulumi.prod.yaml`**

```yaml
config:
  pulumi:tags:
    Environment: production
  nigel-data-neon:projectName: nigel prod
  nigel-data-neon:databaseName: nigel
  nigel-data-neon:userName: nigel_user
  nigel-data-neon:regionId: aws-us-east-1
  nigel-data-neon:historyRetentionSeconds: "2592000"
  # Set the Neon API key (reused from the platform deployment if available):
  #   pulumi config set -s to11/nigel-data-neon/prod --secret neon:apiKey <key>
```

(Note: do not paste an actual encrypted secret into the plan. The engineer running this task copies the value from `to11ai/platform/infra/data-neon/Pulumi.prod.yaml`'s `neon:apiKey` if reusing, or generates a new one.)

- [ ] **Step 4: Create `infra/data-neon/index.ts`**

```ts
import * as neon from "@pulumi/neon";
import * as pulumi from "@pulumi/pulumi";

const config = new pulumi.Config();

const projectName = config.get("projectName") ?? "nigel prod";
const databaseName = config.get("databaseName") ?? "nigel";
const userName = config.get("userName") ?? "nigel_user";
const regionId = config.get("regionId") ?? "aws-us-east-1";
const historyRetentionSeconds = config.getNumber("historyRetentionSeconds");
const pgVersion = config.getNumber("pgVersion");

const neonProject = new neon.Project(
  "nigel-neon-project-prod",
  {
    name: projectName,
    regionId,
    ...(pgVersion !== undefined ? { pgVersion } : {}),
    ...(historyRetentionSeconds !== undefined
      ? { historyRetentionSeconds }
      : {}),
  },
  { protect: true },
);

const neonBranchId = neonProject.defaultBranchId;

const neonEndpoint = new neon.Endpoint(
  "nigel-neon-endpoint-prod",
  {
    projectId: neonProject.id,
    branchId: neonBranchId,
    type: "read_write",
    suspendTimeoutSeconds: -1, // never suspend in prod
  },
  {
    parent: neonProject,
    dependsOn: [neonProject],
    protect: true,
    replaceOnChanges: ["projectId", "branchId", "type"],
  },
);

const neonRole = new neon.Role(
  "nigel-neon-role-prod",
  {
    projectId: neonProject.id,
    branchId: neonBranchId,
    name: userName,
  },
  {
    parent: neonProject,
    dependsOn: [neonProject, neonEndpoint],
    protect: true,
    replaceOnChanges: ["projectId", "branchId", "name"],
  },
);

const neonDatabase = new neon.Database(
  "nigel-neon-database-prod",
  {
    projectId: neonProject.id,
    branchId: neonBranchId,
    name: databaseName,
    ownerName: neonRole.name,
  },
  {
    parent: neonProject,
    dependsOn: [neonEndpoint, neonRole],
    protect: true,
    replaceOnChanges: ["projectId", "branchId", "ownerName"],
  },
);

export const projectId = neonProject.id;
export const branchId = neonBranchId;
export const host = neonEndpoint.host;
export const database = neonDatabase.name;
export const user = neonRole.name;
export const postgresUrl = pulumi.secret(
  pulumi
    .all([neonRole.name, neonRole.password, neonEndpoint.host, neonDatabase.name])
    .apply(([dbUser, dbPassword, dbHost, dbName]) => {
      if (!dbPassword) {
        throw new Error(
          "Neon role password is empty; unable to build postgresUrl.",
        );
      }
      return `postgresql://${encodeURIComponent(dbUser)}:${encodeURIComponent(dbPassword)}@${dbHost}/${encodeURIComponent(dbName)}?sslmode=require`;
    }),
);
export const postgresPoolerUrl = pulumi.secret(
  pulumi
    .all([
      neonRole.name,
      neonRole.password,
      neonProject.databaseHostPooler,
      neonDatabase.name,
    ])
    .apply(([dbUser, dbPassword, poolerHost, dbName]) => {
      if (!dbPassword) {
        throw new Error(
          "Neon role password is empty; unable to build postgresPoolerUrl.",
        );
      }
      return `postgresql://${encodeURIComponent(dbUser)}:${encodeURIComponent(dbPassword)}@${poolerHost}/${encodeURIComponent(dbName)}?sslmode=require`;
    }),
);
```

- [ ] **Step 5: Create `infra/data-neon/package.json`**

```json
{
  "name": "@nigel-infra/data-neon",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc --noEmit",
    "typecheck": "tsc --noEmit",
    "pulumi:preview": "pulumi preview",
    "pulumi:up": "pulumi up --yes",
    "destroy": "pulumi destroy --yes"
  },
  "dependencies": {
    "@pulumi/pulumi": "^3.231.0"
  },
  "devDependencies": {
    "@types/node": "^22",
    "tsx": "^4.21.0",
    "typescript": "^5"
  }
}
```

(`@pulumi/neon` is added in Step 8 via `pulumi package add` once the stack is initialized; that step generates the local SDK and updates this `package.json` automatically.)

- [ ] **Step 6: Create `infra/data-neon/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "types": ["node"]
  },
  "include": ["index.ts", "sdks/**/*.ts"]
}
```

- [ ] **Step 7: Create `infra/data-neon/.gitignore`**

```
node_modules/
sdks/*/node_modules/
sdks/*/bin/
.pulumi/
```

(Pulumi's local SDK output under `sdks/` is committed for reproducibility, but its `node_modules` and built artifacts are not.)

- [ ] **Step 8: Create `infra/data-neon/README.md`**

```markdown
# nigel-data-neon

Pulumi project that provisions Nigel's Neon Postgres database.

## Stacks

- `to11/nigel-data-neon/prod` — production database.

Nigel is prod-only. There are no `dev` or `stg` stacks.

## Outputs

- `projectId` — Neon project ID
- `branchId` — Neon branch ID (the project's default branch)
- `host` — Neon endpoint host
- `database` — database name
- `user` — role name
- `postgresUrl` — full Postgres connection URL (secret)
- `postgresPoolerUrl` — pgbouncer pooler URL (secret)

## Initial provisioning

See `docs/exec-plans/active/2026-05-08-nigel-phase-0-fork-and-rebrand-plan.md` Task 17.
```

- [ ] **Step 9: Commit**

Run:

```bash
git add package.json infra/data-neon/
git commit -m "infra(data-neon): scaffold Pulumi project for Nigel Neon Postgres"
```

---

### Task 14: Add `infra/vercel/` Pulumi project

**Files:**
- Create: `infra/vercel/Pulumi.yaml`
- Create: `infra/vercel/Pulumi.prod.yaml`
- Create: `infra/vercel/index.ts`
- Create: `infra/vercel/package.json`
- Create: `infra/vercel/tsconfig.json`
- Create: `infra/vercel/.gitignore`
- Create: `infra/vercel/README.md`

This Pulumi project owns the Vercel project linked to `to11ai/nigel`, the custom domain, and Pulumi-managed env vars. Per Phase 0 scope, only the env vars required for the dev server to boot are set:

- `POSTGRES_URL` (from the data-neon stack)
- `BETTER_AUTH_SECRET` (Pulumi-generated random)

The GitHub App env vars are required at preview time — Task 18 creates the GitHub App, sets all required Vercel-stack config (token, team ID, `BETTER_AUTH_SECRET`, six GitHub App fields), and runs `pulumi up`. All other env vars (Linear, AI Gateway, Datadog, ElevenLabs) are added in later phases and are not part of Phase 0.

- [ ] **Step 1: Create `infra/vercel/Pulumi.yaml`**

```yaml
name: nigel-vercel
runtime:
  name: nodejs
  options:
    packagemanager: bun
    nodeargs: "--import tsx"
description: Pulumi project for Nigel's Vercel project, domain, and env vars (prod-only)
main: index.ts
```

- [ ] **Step 2: Create `infra/vercel/Pulumi.prod.yaml`**

```yaml
config:
  pulumi:tags:
    Environment: production
  nigel-vercel:projectName: nigel-prod
  nigel-vercel:appDomain: app.nigel.to11.ai
  nigel-vercel:neonStackRef: to11/nigel-data-neon/prod
  vercel:team: terramate
  # All required config + secrets are set in Task 18 before the first `pulumi up`:
  #   pulumi config set -s to11/nigel-vercel/prod --secret vercel:apiToken <token>
  #   pulumi config set -s to11/nigel-vercel/prod nigel-vercel:teamId team_<ID>
  #   pulumi config set -s to11/nigel-vercel/prod --secret nigel-vercel:betterAuthSecret <generated 32-byte base64>
  #   pulumi config set -s to11/nigel-vercel/prod nigel-vercel:githubClientId <client_id>
  #   pulumi config set -s to11/nigel-vercel/prod --secret nigel-vercel:githubClientSecret <client_secret>
  #   pulumi config set -s to11/nigel-vercel/prod nigel-vercel:githubAppId <app_id>
  #   pulumi config set -s to11/nigel-vercel/prod --secret nigel-vercel:githubAppPrivateKey <pem>
  #   pulumi config set -s to11/nigel-vercel/prod nigel-vercel:githubAppSlug <app_slug>
  #   pulumi config set -s to11/nigel-vercel/prod --secret nigel-vercel:githubWebhookSecret <secret>
```

- [ ] **Step 3: Create `infra/vercel/index.ts`**

```ts
import * as pulumi from "@pulumi/pulumi";
import * as vercel from "@pulumiverse/vercel";

const config = new pulumi.Config();

const projectName = config.get("projectName") ?? "nigel-prod";
const appDomain = config.get("appDomain") ?? "app.nigel.to11.ai";

const neonStackRef = new pulumi.StackReference(config.require("neonStackRef"));
const postgresUrl = neonStackRef.requireOutput(
  "postgresUrl",
) as pulumi.Output<string>;

const project = new vercel.Project(
  "nigel-vercel-project-prod",
  {
    name: projectName,
    framework: "nextjs",
    buildCommand:
      config.get("buildCommand") ??
      "cd ../.. && bun run --cwd apps/web build",
    serverlessFunctionRegion: config.get("functionRegion") ?? "iad1",
    rootDirectory: "apps/web",
    gitRepository: {
      type: "github",
      repo: "to11ai/nigel",
    },
  },
  {
    protect: true,
    import: config.get("vercelProjectId"),
  },
);

const projectDomain = new vercel.ProjectDomain(
  "nigel-vercel-domain-prod",
  {
    projectId: project.id,
    domain: appDomain,
  },
  {
    parent: project,
    protect: true,
  },
);

function envVar(
  name: string,
  value: pulumi.Input<string>,
  opts: {
    targets?: string[];
    sensitive?: boolean;
  } = {},
): vercel.ProjectEnvironmentVariable {
  const targets = opts.targets ?? ["production", "preview"];
  return new vercel.ProjectEnvironmentVariable(
    `nigel-vercel-env-${name.toLowerCase().replace(/_/g, "-")}-prod`,
    {
      projectId: project.id,
      key: name,
      value,
      targets,
      sensitive: opts.sensitive ?? false,
    },
    {
      parent: project,
      protect: true,
      deleteBeforeReplace: true,
    },
  );
}

// Required for boot
envVar("POSTGRES_URL", postgresUrl, { sensitive: true });
envVar("BETTER_AUTH_SECRET", config.requireSecret("betterAuthSecret"), {
  sensitive: true,
});

// GitHub App env vars — required for sign-in. Config keys are set in Task 18
// after the GitHub App is created. `pulumi up` should not be run on this
// stack until those keys are populated.
envVar("NEXT_PUBLIC_GITHUB_CLIENT_ID", config.require("githubClientId"));
envVar(
  "GITHUB_CLIENT_SECRET",
  config.requireSecret("githubClientSecret"),
  { sensitive: true },
);
envVar("GITHUB_APP_ID", config.require("githubAppId"));
envVar(
  "GITHUB_APP_PRIVATE_KEY",
  config.requireSecret("githubAppPrivateKey"),
  { sensitive: true },
);
envVar(
  "NEXT_PUBLIC_GITHUB_APP_SLUG",
  config.require("githubAppSlug"),
);
envVar(
  "GITHUB_WEBHOOK_SECRET",
  config.requireSecret("githubWebhookSecret"),
  { sensitive: true },
);

export const projectId: pulumi.Output<string> = project.id;
export const projectNameOutput: pulumi.Output<string> = pulumi.output(
  project.name,
);
export const appDomainOutput: pulumi.Output<string> = pulumi.output(appDomain);
```

- [ ] **Step 4: Create `infra/vercel/package.json`**

```json
{
  "name": "@nigel-infra/vercel",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc --noEmit",
    "typecheck": "tsc --noEmit",
    "pulumi:preview": "pulumi preview",
    "pulumi:up": "pulumi up --yes",
    "destroy": "pulumi destroy --yes"
  },
  "dependencies": {
    "@pulumi/pulumi": "^3.231.0",
    "@pulumiverse/vercel": "^4.6.1"
  },
  "devDependencies": {
    "@types/node": "^22",
    "tsx": "^4.21.0",
    "typescript": "^5"
  }
}
```

- [ ] **Step 5: Create `infra/vercel/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "types": ["node"]
  },
  "include": ["index.ts"]
}
```

- [ ] **Step 6: Create `infra/vercel/.gitignore`**

```
node_modules/
.pulumi/
```

- [ ] **Step 7: Create `infra/vercel/README.md`**

```markdown
# nigel-vercel

Pulumi project that provisions Nigel's Vercel project, custom domain, and Pulumi-managed env vars.

## Stacks

- `to11/nigel-vercel/prod` — production app.

## Depends on

- `to11/nigel-data-neon/prod` (for `postgresUrl`)

## Outputs

- `projectId` — Vercel project ID
- `projectNameOutput` — Vercel project name
- `appDomainOutput` — custom domain (e.g., `app.nigel.to11.ai`)

## Initial provisioning

See `docs/exec-plans/active/2026-05-08-nigel-phase-0-fork-and-rebrand-plan.md` Tasks 15 and 16.
```

- [ ] **Step 8: Install workspace dependencies and typecheck**

Run:

```bash
bun install
bun run --cwd infra/vercel typecheck
```

Expected: install succeeds; typecheck passes for `infra/vercel`. Typecheck for `infra/data-neon` will fail until Task 17 generates the Neon SDK — that is expected.

- [ ] **Step 9: Commit**

Run:

```bash
git add infra/vercel/
git commit -m "infra(vercel): scaffold Pulumi project for Nigel Vercel app"
```

---

### Task 15: Add `infra/aws-dns/` Pulumi project for `nigel.to11.ai` zone

**Files:**
- Create: `infra/aws-dns/Pulumi.yaml`
- Create: `infra/aws-dns/Pulumi.prod.yaml`
- Create: `infra/aws-dns/index.ts`
- Create: `infra/aws-dns/package.json`
- Create: `infra/aws-dns/tsconfig.json`
- Create: `infra/aws-dns/.gitignore`
- Create: `infra/aws-dns/README.md`

This Pulumi project creates a delegated Route53 hosted zone for `nigel.to11.ai` and a CNAME record `app.nigel.to11.ai` → `cname.vercel-dns.com`. The pattern mirrors `to11ai/platform/infra/aws-root-dns` (which owns the parent `to11.ai` zone). Delegation NS records in the parent zone are added in a separate platform-side change (Task 16).

#### Why a separate zone vs. a single record in `to11.ai`

`to11.ai` is owned by the platform repo's `aws-root-dns/root` stack. Adding a single CNAME there would couple Nigel changes to the platform repo. A delegated subzone keeps Nigel-owned DNS in this repo while only requiring a one-time delegation change in the parent zone.

#### AWS account

Same as platform's `aws-root-dns`: management account with ambient identity (Pulumi Cloud OIDC role in CI; SSO admin locally). No `assumeRole` config — provider uses default credentials.

- [ ] **Step 1: Create `infra/aws-dns/Pulumi.yaml`**

```yaml
name: nigel-aws-dns
runtime:
  name: nodejs
  options:
    packagemanager: bun
    nodeargs: "--import tsx"
description: Pulumi project for Nigel's Route53 zone (nigel.to11.ai) and DNS records
main: index.ts
```

- [ ] **Step 2: Create `infra/aws-dns/Pulumi.prod.yaml`**

```yaml
config:
  pulumi:tags:
    Environment: production
  aws:region: us-east-1
  nigel-aws-dns:zoneName: nigel.to11.ai
  nigel-aws-dns:appHost: app.nigel.to11.ai
  nigel-aws-dns:vercelCnameTarget: cname.vercel-dns.com
```

- [ ] **Step 3: Create `infra/aws-dns/index.ts`**

```ts
import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

const config = new pulumi.Config();
const region = config.get("region") ?? "us-east-1";
const zoneName = config.get("zoneName") ?? "nigel.to11.ai";
const appHost = config.get("appHost") ?? `app.${zoneName}`;
const vercelCnameTarget =
  config.get("vercelCnameTarget") ?? "cname.vercel-dns.com";

const tags = {
  ManagedBy: "pulumi",
  Project: "nigel-aws-dns",
};

// Runs against the management account using ambient identity.
// In Pulumi Cloud deployments the identity is the OIDC role published by
// to11ai/platform's aws-workload-ci-access; locally it's the SSO admin session.
const provider = new aws.Provider("managementProvider", { region });

const zone = new aws.route53.Zone(
  "nigel-zone-prod",
  {
    name: zoneName,
    comment: `Subdomain zone for Nigel (${zoneName}). Delegated from to11.ai.`,
    forceDestroy: false,
    tags,
  },
  {
    provider,
    protect: true,
  },
);

new aws.route53.Record(
  "nigel-app-cname-prod",
  {
    zoneId: zone.zoneId,
    name: appHost,
    type: "CNAME",
    ttl: 300,
    records: [vercelCnameTarget],
  },
  {
    provider,
    parent: zone,
  },
);

export const hostedZoneId: pulumi.Output<string> = zone.zoneId;
export const hostedZoneNameServers: pulumi.Output<string[]> = zone.nameServers;
export const zoneNameOutput: pulumi.Output<string> = pulumi.output(zoneName);
export const appHostOutput: pulumi.Output<string> = pulumi.output(appHost);
```

- [ ] **Step 4: Create `infra/aws-dns/package.json`**

```json
{
  "name": "@nigel-infra/aws-dns",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc --noEmit",
    "typecheck": "tsc --noEmit",
    "pulumi:preview": "pulumi preview",
    "pulumi:up": "pulumi up --yes",
    "destroy": "pulumi destroy --yes"
  },
  "dependencies": {
    "@pulumi/aws": "^7.26.0",
    "@pulumi/pulumi": "^3.231.0"
  },
  "devDependencies": {
    "@types/node": "^22",
    "tsx": "^4.21.0",
    "typescript": "^5"
  }
}
```

- [ ] **Step 5: Create `infra/aws-dns/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "types": ["node"]
  },
  "include": ["index.ts"]
}
```

- [ ] **Step 6: Create `infra/aws-dns/.gitignore`**

```
node_modules/
.pulumi/
```

- [ ] **Step 7: Create `infra/aws-dns/README.md`**

```markdown
# nigel-aws-dns

Pulumi project that owns the `nigel.to11.ai` Route53 hosted zone and DNS records inside it.

## Stacks

- `to11/nigel-aws-dns/prod` — production zone.

## Resources

- `aws.route53.Zone` for `nigel.to11.ai` (delegated from `to11.ai`).
- `aws.route53.Record` CNAME `app.nigel.to11.ai` → `cname.vercel-dns.com`.

## Outputs

- `hostedZoneId`
- `hostedZoneNameServers` — consumed by `to11ai/platform/infra/aws-root-dns/root` to delegate from `to11.ai`.
- `zoneNameOutput`, `appHostOutput`

## Delegation (one-time, in platform repo)

After this stack's first apply, the platform repo's `aws-root-dns/root` stack must add an `aws.route53.Record` of type `NS` for `nigel.to11.ai` in the `to11.ai` zone, with values pulled from this stack's `hostedZoneNameServers` output via `pulumi.StackReference`. Until that record exists, `nigel.to11.ai` (and therefore `app.nigel.to11.ai`) will not resolve from the public DNS.

## Initial provisioning

See `docs/exec-plans/active/2026-05-08-nigel-phase-0-fork-and-rebrand-plan.md` Task 15.
```

- [ ] **Step 8: Install workspace dependencies and typecheck**

Run:

```bash
bun install
bun run --cwd infra/aws-dns typecheck
```

Expected: install succeeds; typecheck passes.

- [ ] **Step 9: Initialize the stack and apply**

```bash
cd infra/aws-dns
pulumi stack init to11/nigel-aws-dns/prod
pulumi preview
```

Expected preview output: 2 resources to create — `aws.route53.Zone` and `aws.route53.Record`.

```bash
pulumi up --yes
```

Expected: 2 resources created. Capture the `hostedZoneNameServers` output for the next step:

```bash
pulumi stack output hostedZoneNameServers
```

Expected: a list of 4 AWS-assigned name servers (e.g., `ns-123.awsdns-XX.com`, `ns-456.awsdns-XX.net`, etc.). Save these — they go into the platform-side delegation in Task 16.

- [ ] **Step 10: Commit the Pulumi project files**

```bash
cd ../..
git add infra/aws-dns/
git commit -m "infra(aws-dns): scaffold Pulumi project for nigel.to11.ai zone"
```

---

### Task 16: Delegate `nigel.to11.ai` from parent `to11.ai` zone (platform-side change)

This task is performed in the **`to11ai/platform`** repository, not nigel. It is included here so the cross-repo dependency is explicit and tracked.

**Files (in `to11ai/platform`):**
- Modify: `infra/aws-root-dns/index.ts` — add a `pulumi.StackReference` to `to11/nigel-aws-dns/prod` and an `aws.route53.Record` of type `NS` delegating `nigel.to11.ai` from the `to11.ai` zone.
- Modify: `infra/aws-root-dns/Pulumi.root.yaml` — add a `nigelAwsDnsStackRef` config entry.

The pattern mirrors the existing `stgDelegation` block in `infra/aws-root-dns/index.ts` which delegates `stg.to11.ai` to the staging foundation stack.

- [ ] **Step 1: In `to11ai/platform`, edit `infra/aws-root-dns/Pulumi.root.yaml`**

Add the stack reference under `config:`:

```yaml
  aws-root-dns:nigelAwsDnsStackRef: to11/nigel-aws-dns/prod
```

- [ ] **Step 2: In `to11ai/platform`, edit `infra/aws-root-dns/index.ts`**

After the `stgDelegation` block (around line 81 in upstream), add:

```ts
const nigelAwsDnsStackRef = new pulumi.StackReference(
  config.require("nigelAwsDnsStackRef"),
);
const nigelNameServers = nigelAwsDnsStackRef.requireOutput(
  "hostedZoneNameServers",
) as pulumi.Output<string[]>;

new aws.route53.Record(
  "nigelDelegation",
  {
    zoneId: rootZone.zoneId,
    name: "nigel.to11.ai",
    type: "NS",
    ttl: 172800,
    records: nigelNameServers,
  },
  { provider },
);
```

- [ ] **Step 3: Open PR in `to11ai/platform`**

Standard platform PR workflow: feature branch, CI green, review, merge, then trigger the `aws-root-dns/root` stack's `pulumi up` (typically via Pulumi Cloud Deployments).

- [ ] **Step 4: Verify delegation took effect**

```bash
dig +short NS nigel.to11.ai
```

Expected: 4 name servers matching the values from `nigel-aws-dns` Task 15 Step 9. Propagation can take up to ~30 minutes.

```bash
dig +short app.nigel.to11.ai
```

Expected: a `cname.vercel-dns.com.` line followed by Vercel-assigned IPs (the IPs appear after the Vercel project domain is registered in Task 18).

---

### Task 17: Provision Neon Postgres (`pulumi up` for `nigel-data-neon`)

**Files:**
- (none new — runs Pulumi commands; may modify `infra/data-neon/{package.json,sdks/}` via `pulumi package add`)

This task is the first real cloud deploy. Each `pulumi up` writes resources to Neon. Read the preview before approving.

The Vercel stack is intentionally deferred to Task 18 because its `index.ts` calls `config.require()` for the GitHub App credentials — they must exist before `pulumi up` runs.

#### Prerequisites

- Pulumi CLI logged in to the `to11` org.
- Neon API key available (reuse from `to11ai/platform/infra/data-neon/Pulumi.prod.yaml`'s `neon:apiKey` if reusing the existing Neon account, or generate fresh).

- [ ] **Step 1: Initialize the Neon stack**

```bash
cd infra/data-neon
pulumi stack init to11/nigel-data-neon/prod
```

Expected: stack created; switch reported.

- [ ] **Step 2: Generate the local Neon SDK via `pulumi package add`**

```bash
pulumi package add neon
```

Expected: Pulumi reads `Pulumi.yaml`'s `packages.neon` block, generates the local SDK at `sdks/neon/`, and updates `package.json` with `"@pulumi/neon": "file:sdks/neon"`. Re-run install:

```bash
cd ../..
bun install
```

- [ ] **Step 3: Set the Neon API key**

```bash
cd infra/data-neon
pulumi config set --secret neon:apiKey <NEON_API_KEY>
```

Replace `<NEON_API_KEY>` with the actual key. Verify (no key value is printed):

```bash
pulumi config | grep -i neon
```

- [ ] **Step 4: Preview Neon stack**

```bash
pulumi preview
```

Expected: 4 resources to create — `neon.Project`, `neon.Endpoint`, `neon.Role`, `neon.Database`. No errors.

- [ ] **Step 5: Apply Neon stack**

```bash
pulumi up --yes
```

Expected: all 4 resources created. Outputs include `postgresUrl` (secret, masked), `host`, `projectId`, etc.

- [ ] **Step 6: Verify Neon connectivity**

```bash
pulumi stack output postgresUrl --show-secrets > /tmp/nigel-pg-url.txt
psql "$(cat /tmp/nigel-pg-url.txt)" -c 'SELECT 1' && rm /tmp/nigel-pg-url.txt
```

Expected: `?column?` row with value `1`. If `psql` is not installed, skip — Vercel will surface connection errors at deploy time instead.

- [ ] **Step 7: Commit generated SDK**

```bash
cd ../..
git status
```

If `infra/data-neon/sdks/neon/` was generated and tracked, and `infra/data-neon/package.json` was updated by `pulumi package add`, commit:

```bash
git add infra/data-neon/sdks infra/data-neon/package.json
git commit -m "infra(data-neon): add generated Neon SDK from pulumi package add"
```

If nothing changed, skip.

---

### Task 18: Create GitHub App and provision Vercel stack

GitHub App must exist before the Vercel Pulumi stack is applied (the stack's `index.ts` requires GitHub App credentials at preview time). This task creates the GitHub App, sets all required Vercel-stack config (token, team ID, `BETTER_AUTH_SECRET`, six GitHub App fields), then runs `pulumi up`.

**Files:**
- (none — manual GitHub App creation + Pulumi config set + `pulumi up`)

#### Prerequisites

- Vercel API token available (reuse from `to11ai/platform/infra/vercel/Pulumi.prod.yaml` or generate fresh).
- Vercel team ID for the `terramate` team.
- Permission to create a GitHub App in the `to11ai` org.
- Neon Pulumi stack (Task 17) completed — its `postgresUrl` output is referenced by the Vercel stack.
- AWS DNS stack (Task 15) applied and platform-side delegation merged (Task 16) — required for `app.nigel.to11.ai` to resolve and for Vercel SSL provisioning to succeed. The Vercel project still creates without DNS, but cert issuance and the production URL will fail until DNS resolves.

#### Domain note

The Vercel project will register `app.nigel.to11.ai` on the Vercel side, but the actual DNS CNAME must exist in the AWS Route53 zone owned by `to11ai/platform/infra/aws-root-dns/root`. The GitHub App configuration uses the production domain — it works on day one if the CNAME is created beforehand or if the Vercel auto-generated `*.vercel.app` URL is used as the fallback callback URL.

To avoid coupling Phase 0 to the manual DNS step, this task uses the `*.vercel.app` URL for the GitHub App callbacks. Once DNS is added (Step 11 of this task), the GitHub App's URLs are updated to the production domain.

- [ ] **Step 1: Initialize the Vercel stack (preview only — no apply yet)**

```bash
cd infra/vercel
pulumi stack init to11/nigel-vercel/prod
```

Expected: stack created.

- [ ] **Step 2: Set Vercel-side config**

```bash
pulumi config set --secret vercel:apiToken <VERCEL_API_TOKEN>
pulumi config set nigel-vercel:teamId team_<ID>
pulumi config set --secret nigel-vercel:betterAuthSecret "$(openssl rand -base64 32)"
```

Replace `<VERCEL_API_TOKEN>` and `team_<ID>` with actual values.

- [ ] **Step 3: Determine the placeholder callback URL**

The Vercel project's auto-generated production URL follows `https://<projectName>-<teamSlug>.vercel.app` (e.g., `https://nigel-prod-terramate.vercel.app`). Use this URL until DNS is configured. Record the chosen value for the next step:

```bash
PLACEHOLDER_URL="https://nigel-prod-terramate.vercel.app"
echo $PLACEHOLDER_URL
```

(Adjust `nigel-prod-terramate` if the Vercel-generated subdomain differs once the project exists. Step 8 verifies the actual URL.)

- [ ] **Step 4: Create the GitHub App**

Visit `https://github.com/organizations/to11ai/settings/apps/new`. Configure:

- **GitHub App name**: `Nigel`.
- **Homepage URL**: `<PLACEHOLDER_URL>` (will be updated to `https://app.nigel.to11.ai` once DNS is configured).
- **Callback URL** (one per line):
  - `<PLACEHOLDER_URL>/api/auth/callback/github`
  - `https://app.nigel.to11.ai/api/auth/callback/github`
  - `http://localhost:3000/api/auth/callback/github`
- **Setup URL**: `<PLACEHOLDER_URL>/api/github/app/callback`.
- **Webhook URL**: `<PLACEHOLDER_URL>/api/github/webhook` (placeholder; full integration in later phases).
- **Webhook secret**: generate one with `openssl rand -hex 32` — save it.
- **Repository permissions**: Contents (read & write), Pull requests (read & write), Issues (read), Metadata (read).
- **Subscribe to events**: Push, Pull request (Phase 0 minimum; expand later).
- **Where can this GitHub App be installed**: Any account.

Save the GitHub App. On the next page:

- Note the **App ID** and **Slug** (visible in the URL).
- Generate a **private key** — download the PEM file.
- Generate a **client secret**.
- Note the **Client ID**.

- [ ] **Step 5: Set GitHub App credentials in Pulumi config**

```bash
pulumi config set nigel-vercel:githubAppId <APP_ID>
pulumi config set nigel-vercel:githubAppSlug <SLUG>
pulumi config set nigel-vercel:githubClientId <CLIENT_ID>
pulumi config set --secret nigel-vercel:githubClientSecret <CLIENT_SECRET>
pulumi config set --secret nigel-vercel:githubWebhookSecret <WEBHOOK_SECRET_FROM_STEP_4>

# private key — paste contents of the downloaded PEM
pulumi config set --secret nigel-vercel:githubAppPrivateKey "$(cat /path/to/nigel.YYYY-MM-DD.private-key.pem)"
```

- [ ] **Step 6: Preview Vercel stack**

```bash
pulumi preview
```

Expected: 10 resources to create — `vercel.Project`, `vercel.ProjectDomain`, and 8 `vercel.ProjectEnvironmentVariable` (for `POSTGRES_URL`, `BETTER_AUTH_SECRET`, and the 6 GitHub App env vars). No errors.

- [ ] **Step 7: Apply Vercel stack**

```bash
pulumi up --yes
```

Expected: all 10 resources created. Outputs include `projectId`, `projectNameOutput`, `appDomainOutput`.

- [ ] **Step 8: Verify the actual Vercel-generated production URL**

In the Vercel dashboard, find the project's auto-generated URL under "Domains". If it differs from the `<PLACEHOLDER_URL>` used in the GitHub App settings, update the GitHub App's Homepage URL, Callback URLs (only the `*.vercel.app` entry), Setup URL, and Webhook URL to the actual value. Save.

- [ ] **Step 9: Verify DNS resolves end-to-end**

DNS is fully Pulumi-managed (`infra/aws-dns` Task 15 created the zone and CNAME; Task 16 delegated from the parent `to11.ai` zone). Verify resolution:

```bash
dig +short app.nigel.to11.ai
```

Expected: `cname.vercel-dns.com.` followed by Vercel A records. If empty:

- Confirm the `nigel-aws-dns` Pulumi stack was applied (`pulumi stack output -s to11/nigel-aws-dns/prod hostedZoneNameServers`).
- Confirm the platform-side delegation PR is merged and `aws-root-dns/root` was applied (Task 16).
- Wait up to 30 minutes for DNS propagation.

- [ ] **Step 10: Update the GitHub App URLs to the production domain**

Once `app.nigel.to11.ai` resolves to the Vercel app, update the GitHub App's Homepage URL, Setup URL, and Webhook URL from `<PLACEHOLDER_URL>` to `https://app.nigel.to11.ai/...`. Keep the `*.vercel.app` callback URL too (preview deploys still need it). Save.

- [ ] **Step 11: Install the GitHub App on `to11ai`**

Visit `https://github.com/apps/<slug>/installations/new`. Install the App on the `to11ai` org with access to the `nigel` repository (and any other repos that should accept agent-driven changes).

---

### Task 19: Push branch and open PR

**Files:**
- (none — push + PR creation only)

- [ ] **Step 1: Push the branch**

```bash
git push -u origin phase-0-fork-and-rebrand
```

Expected: push succeeds. Vercel auto-deploys the branch as a preview deployment because the project is now linked to `to11ai/nigel` from Task 18.

- [ ] **Step 2: Open a PR**

```bash
gh pr create \
  --title "Phase 0: fork + rebrand to Nigel" \
  --body "$(cat <<'EOF'
Implements docs/exec-plans/active/2026-05-08-nigel-phase-0-fork-and-rebrand-plan.md.

## What this PR does

- Forks vercel-labs/open-agents to to11ai/nigel.
- Rebrands package names, branding strings, theme storage key, env var (`OPEN_AGENTS_RESOURCE_PROFILE` → `NIGEL_RESOURCE_PROFILE`).
- Strips Vercel OAuth from Better Auth config, env example, and sign-in UI; keeps GitHub-only auth.
- Adds Pulumi infra projects under `infra/data-neon` and `infra/vercel` provisioning Neon Postgres and the Vercel app for prod.
- Records the upstream commit SHA in `UPSTREAM.md`.

Spec: docs/product-specs/2026-05-08-nigel-system-design.md.
EOF
)"
```

Expected: PR opens; Vercel preview link appears as a status check.

---

### Task 20: Deploy preview verification

**Files:**
- (none — pure verification)

- [ ] **Step 1: Confirm preview deploy succeeds**

In the Vercel dashboard for `to11ai/nigel` (project `nigel-prod`), verify the preview deployment for `phase-0-fork-and-rebrand` is `Ready`. If it failed, the build log will indicate the cause — fix and re-push.

- [ ] **Step 2: Open the preview URL**

Verify in a fresh browser window:

1. The page title in the browser tab is `Nigel`.
2. The landing page describes Nigel (matches the description in `apps/web/app/layout.tsx`).
3. The sign-in section shows only a GitHub button — no Vercel button.
4. View source: the `<title>` is `Nigel` and `<meta name="description">` is the new description.

- [ ] **Step 3: Spot-check that no upstream branding leaked**

In the deployed page's HTML and any obvious user-facing text, confirm no "Open Agents" label appears.

- [ ] **Step 4: Smoke test sign-in (required)**

Click "Continue with GitHub". Authorize the app. Expected: redirected back to the app, signed in. The user record is created in the Neon Postgres database. Run:

```bash
pulumi stack output -s to11/nigel-data-neon/prod postgresUrl --show-secrets \
  | xargs -I {} psql "{}" -c "SELECT id, username FROM users LIMIT 5"
```

Expected: at least one row with the signed-in username. If sign-in fails, check (a) the GitHub App's callback URL matches the deployed app's hostname, (b) the env vars in the Vercel project match the GitHub App credentials, and (c) the GitHub App is installed on the user's account or org.

- [ ] **Step 5: Document the deploy URL in the PR**

Paste the preview URL into the PR description. If `app.nigel.to11.ai` is reachable, also paste the production URL.

---

## Acceptance criteria for Phase 0

1. `to11ai/nigel` exists on GitHub as a fork of `vercel-labs/open-agents`.
2. The local clone at `/Users/matt/code/github.com/to11ai/nigel` contains the full upstream code, plus `docs/product-specs/2026-05-08-nigel-system-design.md`, `docs/exec-plans/active/2026-05-08-nigel-phase-0-fork-and-rebrand-plan.md`, and `UPSTREAM.md` recording the fork-base SHA.
3. The root `package.json` `name` is `nigel`, and `infra/*` is in `workspaces.packages`. All three workspace packages under `packages/` are renamed to `@nigel/*`. No code-level references to `@open-agents/*` remain (markdown in `.agents/skills/**` excepted).
4. `apps/web/app/layout.tsx` reflects "Nigel" branding (title, template, description, theme storage key, metadataBase fallback).
5. `apps/web/lib/auth/config.ts` has no Vercel social provider, no `VercelProfile` import, and no `mapVercelProfileToUser` function. `trustedProviders` contains only `"github"`.
6. `apps/web/.env.example` has no `NEXT_PUBLIC_VERCEL_APP_CLIENT_ID` or `VERCEL_APP_CLIENT_SECRET`. The Vercel platform vars (`VERCEL_PROJECT_PRODUCTION_URL`, etc.) remain.
7. `OPEN_AGENTS_RESOURCE_PROFILE` is renamed to `NIGEL_RESOURCE_PROFILE` everywhere in code and docs (excluding `.agents/skills/**`).
8. The sign-in UI shows only a GitHub button.
9. `bun run check` and `bun run typecheck` both pass.
10. Pulumi stacks `to11/nigel-aws-dns/prod`, `to11/nigel-data-neon/prod`, and `to11/nigel-vercel/prod` exist and have been successfully `pulumi up`-ed at least once.
11. Route53 hosted zone for `nigel.to11.ai` exists, is delegated from the `to11.ai` zone (via a platform-side change in `to11ai/platform/infra/aws-root-dns/root`), and `dig +short app.nigel.to11.ai` returns `cname.vercel-dns.com.` plus Vercel-assigned IPs.
12. The Vercel project `nigel-prod` exists, is linked to `to11ai/nigel`, has all required Phase 0 env vars (`POSTGRES_URL`, `BETTER_AUTH_SECRET`, and the six GitHub App env vars) set via Pulumi, and auto-deploys on push.
13. A Vercel preview deploy of the `phase-0-fork-and-rebrand` branch builds and serves the rebranded site at the auto-generated `*.vercel.app` URL; the production deploy is reachable at `https://app.nigel.to11.ai`.
14. Sign-in via GitHub works against the deployed app and creates a `users` row in Neon Postgres. The GitHub App is created in `to11ai`, installed on the org with access to `to11ai/nigel`, and its credentials are wired through Pulumi-managed Vercel env vars.

---

## Out of scope for Phase 0

- The `Run` abstraction (Phase 1).
- Specialist registry (Phase 2).
- `.nigel.yaml` config (Phase 3).
- Specialist roster (Phase 4) — this is why `.agents/skills/**` is left untouched.
- Tool registry (Phase 5).
- Linear integration (Phase 6).
- Observability (Phase 7).
- New UI surfaces beyond rebranding (Phase 8).
- Eval suite (Phase 9).

---

## Self-review notes

The plan has been checked against the spec's Phase 0 description and the user's directive to mirror `to11ai/platform/infra` for prod-only Vercel + Neon bootstrap. Coverage:

- ✅ Fork + rebrand → Tasks 1–11.
- ✅ Strip Vercel OAuth (config, env example, UI) → Tasks 9–10.
- ✅ Document upstream commit SHA in `UPSTREAM.md` → Task 3.
- ✅ Vercel + Neon bootstrap mirroring `to11ai/platform/infra` (prod-only, no staging) → Tasks 13 (Neon scaffold), 14 (Vercel scaffold), 17 (Neon up), 18 (Vercel up).
- ✅ DNS — Pulumi-managed Route53 zone `nigel.to11.ai` plus delegation from parent `to11.ai` → Tasks 15 (zone scaffold + up) and 16 (platform-side delegation).
- ✅ App FQDN `app.nigel.to11.ai` wired through layout metadataBase, Vercel ProjectDomain, and GitHub App URLs.
- ✅ GitHub App creation + credentials wiring (required for sign-in) → Task 18.
- ✅ Verify deploy preview works AND sign-in works against deployed app → Task 20.
- ✅ Each rename is its own commit (per spec's "minimal Phase 0 delta + clean upstream merges") → Tasks 5, 6.1, 6.2, 6.3, 7, 8, 9, 10, 11 each commit independently. Infra additions (Tasks 13, 14, 15) each commit independently for the same reason.

No placeholders. All commands and code blocks are concrete. Type/string consistency: every renamed identifier (`OpenAgentsResourceProfile` → `NigelResourceProfile`, `getOpenAgentsResourceProfile` → `getNigelResourceProfile`) is consistent across Tasks 8 and the consumer in `apps/web/lib/sandbox/config.ts`. The theme storage key `nigel-theme` appears only once (Task 7). The `infra/` Pulumi project names (`nigel-data-neon`, `nigel-vercel`) are consistent across Tasks 13, 14, 15 and the stack references in `Pulumi.prod.yaml` files. The Vercel project name `nigel-prod` is consistent across Tasks 14 (Pulumi config), 17 (PR description), and 18 (verification).
