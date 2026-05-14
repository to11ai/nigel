# Spec: Nigel — Custom Coding Agent Platform

**Date:** 2026-05-08
**Status:** Draft

## Feature

Fork of [vercel-labs/open-agents](https://github.com/vercel-labs/open-agents), rebranded as **Nigel**, extended with:

1. Hierarchical multi-agent orchestration (planner → specialists → recursive children, with a `dispatch_specialist` tool).
2. Specialist roster shipped as code presets, customizable and overridable per org.
3. Linear ticket triggers (assign-to-bot model with ping-pong reassignment to capture human ownership).
4. Chained-agent triggers (one Run dispatching follow-up Runs as a top-level trigger source).
5. Expanded tool surface: browser automation (Playwright + multi-resolution screenshots), database access, cloud SDKs, registered MCP servers, Slack outbound.
6. Per-repo `.nigel.yaml` config with Turbo-aware command derivation, `local_stack` profiles (named startup/seeding recipes; commands rather than docker-compose) for stateful test setups, and snapshot caching for fast bootstrap.
7. Cost guardrails (per-Run budget caps, per-org monthly caps).
8. Datadog-backed observability via OpenTelemetry, including dashboards and alerts managed as code.
9. UI surface for the Run hierarchy, visual proof galleries, admin configuration of specialists, repos, and tool connections.

## Problem

Open Agents is a single-agent reference architecture that runs a chat-driven coding agent against Vercel Sandbox VMs. It does not support:

1. Hierarchical orchestration. Complex tasks (plan → research → code → test → review → ship) require either a single overloaded agent or external glue.
2. Non-chat triggers. There is no path from a Linear ticket assignment, a chained agent dispatch, or any other inbound signal to "start a Run" with consistent semantics.
3. Specialist division of labor. There is no mechanism to express that "the tester role uses Haiku in a fresh sandbox with read-only tools" while "the planner uses Sonnet, can dispatch sub-agents, and operates on the parent's sandbox."
4. Per-Run accounting. Costs and depths are not first-class; budgets cannot be enforced at the boundary of a model call.
5. Per-org tool registries. Database connections, cloud credentials, and MCP endpoints have no central encrypted home with capability-scoped allowlists.
6. Repo-driven configuration. Lint, format, type-check, and test commands are not derived from `turbo.json` or declared in a versioned `.nigel.yaml`; the agent guesses.
7. Stateful test setup. Multi-tenant or seeded-state e2e flows require ad-hoc setup scripts that the agent cannot consistently bring up.

Nigel is a fork that solves these by introducing a `Run` abstraction as the load-bearing primitive, then layering specialists, triggers, tool registries, and repo config on top.

## Goals

1. Every execution — top-level chat, Linear-triggered, chained sub-agent — is a `Run` row with the same lifecycle, cost rollup, and ownership semantics.
2. Specialists are composable. A planner can dispatch a coder, a tester, a reviewer, and an adversarial-reviewer in any order, in series or in parallel, with per-specialist sandbox policy.
3. Linear is the primary inbound for tickets. Assigning to the bot user starts a Run; lifecycle reassigns to the human owner whenever human action is needed (blocked, awaiting approval, completed, failed).
4. Cost and depth are bounded by code, not by chance. Every model and tool call passes through a budget check; recursion has a hard cap at depth 5.
5. Repo authors own their build/test config in `.nigel.yaml`, with Turbo derivation eliminating duplication. The harness has no opinions about per-app conventions ("seeded", "with_users", etc.) — those are repo vocabulary.
6. The harness is project-agnostic at the boundary; specialists declare *capabilities* (e.g., `needs_local_stack: true`), repos declare *flavors* (named profiles).
7. Observability is built in. Every Run produces traces, metrics, and logs in Datadog with a navigable hierarchy.

## Non-goals

1. Self-hosted deploy targets in v1. Nigel runs on Vercel; sandboxes use Vercel Sandbox; durable execution uses the Vercel Workflow SDK.
2. Multi-tenant SaaS. Nigel is single-org per deployment; org-level configuration is admin-only and global.
3. Reinventing Pulumi deploy flow. `pulumi up` happens in Pulumi Cloud Deployments via GitOps, not from the sandbox.
4. Direct sandbox-side cloud writes. Sandboxes never hold long-lived production write credentials.
5. Discord, email, or telephone outbound in v1. Slack outbound is the only chat target.
6. Voice synthesis. Voice input via ElevenLabs transcription is kept (per upstream), voice output is out of scope.
7. Linear OAuth per-user. Org-level Linear OAuth only.
8. Workflow state-based triggers in Linear. Assignment-based plus comment commands; no "Ready for AI" state column.
9. Cron triggers in v1. Reserved for a follow-up phase.

## Constraints

1. Auth is GitHub-only via Better Auth + GitHub App. Vercel OAuth provider is removed from upstream.
2. Models are routed through Vercel AI Gateway with Anthropic and OpenAI providers configured.
3. Database is Postgres via Drizzle ORM (kept from upstream).
4. Sandboxes are Vercel Sandbox; durable execution is Workflow SDK (kept from upstream).
5. Linear integration is org-level; one Linear workspace per Nigel deployment.
6. Recursion depth is hard-capped at 5; per-Run direct-children cap defaults to 10.
7. All secrets in `tool_connections` are encrypted at rest; sandbox runtime receives only short-lived scoped credentials.
8. Observability emits OTLP to Datadog; Datadog dashboards and monitors are Pulumi-managed (versioned with code, no clickops).
9. Specialist presets defined in code never reference repo-specific profile names; profile names are repo vocabulary only.
10. Schema migrations are additive until the platform is past Phase 8.

## Proposed Design

### 1. System architecture

Four execution layers:

```
Triggers ──┐
           ▼
        Run ──► Workflow SDK instance ──► Sandbox VM
        ▲           │
        └───────────┘ (child Run via Run.create())
```

- **Triggers**: chat (manual), Linear webhook (assignee changed to bot), chained (parent Run's `dispatch_specialist` tool call).
- **Run**: persistent row, the unit of execution. Owns hierarchy, budget, cost, status, sandbox, and human ownership. Every trigger funnels into `Run.create()`.
- **Workflow SDK**: durable execution, streaming, cancellation. One instance per Run.
- **Sandbox VM**: Vercel Sandbox. Per-Run by default; sub-agent Runs may share parent's sandbox or get a fresh/clean one based on specialist policy.

A Run is the only thing that owns a sandbox, holds a budget, tracks cost, has an owner. All chat messages, tool calls, and artifacts hang off a Run.

### 2. Core domain model

```
agent_runs
  id, parent_run_id (nullable), root_run_id, depth (0-5)
  trigger_source ('chat' | 'linear' | 'chained' | 'cron')
  trigger_ref (e.g., linear issue id, parent run id, comment id)
  specialist_id (nullable; null = top-level chat)
  human_owner_id (FK users)
  repo_ref (owner/name@sha or owner/name@branch)
  sandbox_id, sandbox_policy ('inherit' | 'fresh' | 'fresh_clean')
  workflow_run_id (Workflow SDK handle)
  budget_usd_cap, cost_usd_actual
  status ('pending' | 'running' | 'blocked' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled')
  blocked_reason (text, when status='blocked')
  approval_required (bool), approval_diff_artifact_id (FK), approved_by (FK users), approved_at
  created_at, started_at, ended_at

specialists
  id, name (unique), kind ('preset' | 'custom' | 'override' | 'scripted')
  system_prompt (nullable; required for non-scripted)
  model (gateway slug; nullable for scripted)
  tool_allowlist text[]
  sandbox_policy ('inherit' | 'fresh' | 'fresh_clean')
  may_recurse (bool), max_children int
  budget_usd_default
  needs_local_stack (bool)
  fields jsonb (for kind='override': partial fields applied on top of code preset)

tool_connections
  id, kind ('database' | 'cloud' | 'mcp' | 'slack')
  name (unique per kind)
  config jsonb (encrypted at rest)
  capability_scope jsonb (e.g., {read: true, write: false, allowed_schemas: [...]})
  used_by_specialists text[]
  created_by, created_at, last_used_at

linear_workspace
  id, workspace_id, bot_user_id
  oauth_tokens (encrypted), webhook_secret
  team_repo_map jsonb (linear_team_id -> repo_full_name)

repo_configs
  id, repo_full_name (unique), config_json
  source ('file' | 'db' | 'inferred')
  updated_by, updated_at

sandbox_snapshots
  id, repo_full_name, branch_or_sha, profile, base_snapshot_id
  built_at, ttl_until, size_bytes
  invalidation_keys jsonb

run_messages, run_tool_calls, run_artifacts
  belong to agent_runs.id (cascade)
  run_artifacts.kind ∈ {'screenshot', 'html', 'log', 'file', 'pulumi_preview'}

webhook_events
  source, external_id (unique), received_at, processed_at, run_id (nullable)

users
  ... existing fields ...
  role ('admin' | 'member')   -- first user becomes admin
```

#### Specialist resolution

Specialist presets live in code (`specialists/presets.ts`), versioned with the codebase. The `specialists` table stores only `kind='custom'` rows (admin-created, no code counterpart) and `kind='override'` rows (admin tweaks to a preset, partial fields).

```ts
function getSpecialist(name: string): Specialist {
  const preset = PRESETS[name];
  const override = await db.query.specialists.findFirst({where: {name, kind: 'override'}});
  if (preset && override) return { ...preset, ...override.fields };
  if (preset) return preset;
  return await db.query.specialists.findFirst({where: {name, kind: 'custom'}});
}
```

Code preset changes ship via deploy; admin overrides survive deploys; new admin specialists do not require a PR.

#### Sandbox policy

| Policy | Behavior |
|---|---|
| `inherit` | Share parent Run's sandbox. Cheap, sees parent's edits. |
| `fresh` | New sandbox, clones same repo + branch. Isolated execution, clean of parent's uncommitted changes. |
| `fresh_clean` | New sandbox, fresh clone of base branch. No inherited state. Used for adversarial review. |

Default policy is per-specialist (in code preset); planner can override per dispatch (`dispatch_specialist({sandbox_policy: 'fresh_clean'})`).

### 3. Trigger pipeline

#### Linear webhook

`POST /api/linear/webhook`:

1. Verify HMAC signature using `linear_workspace.webhook_secret`.
2. Decode event; filter to `Issue.assignee_changed` where new assignee = `linear_workspace.bot_user_id`.
3. Resolve repo:
   1. Linear's native GitHub link on the issue, then
   2. `linear_workspace.team_repo_map[issue.team_id]`, then
   3. label override (`repo:owner/name`).
4. If no repo resolves, post a Linear comment "no repo mapped for this team — set the team→repo mapping or add a `repo:owner/name` label" and reassign back to the actor; do not create a Run.
5. Capture `human_owner_id` from `event.actor` (the person who reassigned to the bot). If actor is the bot itself (issue created already-assigned), use `issue.creator`.
6. `Run.create({trigger_source: 'linear', trigger_ref: issue.id, repo_ref, human_owner_id, specialist_id: 'planner', budget_usd_cap: org.default_budget_usd})`.
7. Webhook returns 200 immediately; Workflow SDK kicks off async.

Idempotency: dedupe on `webhook_events.external_id = event.id` via unique constraint.

##### Lifecycle hooks (Linear-side)

| State transition | Action |
|---|---|
| `pending` → `running` | Comment `"Picked up by Nigel for @{human_owner}"`. Bot is the active assignee. |
| `running` → `blocked` | Reassign to `human_owner`. Comment `"Blocked: {blocked_reason}. Comment to resolve."`. |
| `running` → `awaiting_approval` | Reassign to `human_owner`. Comment with preview link and `/approve` and `/reject` instructions. |
| `running` → `completed` | Reassign to `human_owner`. Comment with PR link, summary, cost. |
| `running` → `failed` | Reassign to `human_owner`. Comment with reason and Run URL. |
| `running` → `cancelled` | Reassign to `human_owner`. Comment with cancellation actor and any partial work. |

Reassign target falls back to repo's CODEOWNERS first entry if `human_owner` is deactivated; if that fails, leave unassigned with a comment "no owner reachable".

##### Comment commands

The Linear webhook handler also processes new comments on issues with active or paused Runs:

- `/approve` — only valid in `awaiting_approval`; transitions Run to `running`.
- `/reject` — only valid in `awaiting_approval`; transitions Run to `cancelled` with reason "rejected by {actor}".
- `/resume` — only valid in `blocked`; transitions to `running` with the comment text appended as a new user message.
- `/cancel` — valid in any non-terminal state.
- `/run [instructions]` — creates a fresh top-level Run on the same issue (re-run after fix).

Commands are dedup'd on `(issue_id, comment_id)` to survive webhook retries.

#### Chained dispatch

Specialist tool: `dispatch_specialist({name, task, sandbox_policy?, budget_usd?, local_stack_profile?})`. Implemented as a Workflow SDK step:

1. Validate: `parent.depth < 5`, `parent.cost_usd_actual + budget_usd <= root.budget_usd_cap`, `parent.specialist.may_recurse`, parent's child count < `parent.specialist.max_children`.
2. `Run.create({parent_run_id, root_run_id, specialist_id, trigger_source: 'chained', repo_ref, ...})`.
3. Await child Run completion (Workflow SDK durable wait).
4. Return child's final output to the parent's tool call.

Parallel dispatch is supported via a sibling tool `dispatch_specialists_parallel(array)` that creates N child Runs and awaits all (Workflow SDK `Promise.all` over child workflows).

#### Manual chat

The existing chat path becomes `Run.create({trigger_source: 'chat', specialist_id: null, human_owner_id: session.user_id, ...})`. `specialist_id: null` means "default chat agent" (preserved from upstream — uses upstream's chat system prompt). All chat sessions are top-level Runs.

### 4. Multi-agent orchestration

#### Specialist preset roster

| Name | Default model | Sandbox | Recurse? | needs_local_stack | Tools (allowlist) |
|---|---|---|---|---|---|
| `planner` | sonnet-4.6 | inherit | yes | false | `file_read`, `search`, `dispatch_specialist`, `dispatch_specialists_parallel`, `web`, `linear` |
| `coder` | sonnet-4.6 | inherit | no | false | `file`, `search`, `shell`, `git` |
| `linter` | haiku-4.5 | fresh | no | false | `file`, `search`, `shell` |
| `formatter` | (scripted, no LLM) | fresh | no | false | `shell` |
| `type-checker` | haiku-4.5 | fresh | no | false | `file`, `search`, `shell` |
| `unit-tester` | haiku-4.5 → sonnet on failure | fresh | no | false | `file`, `search`, `shell` |
| `e2e-tester` | sonnet-4.6 | fresh | no | true | `file`, `search`, `shell`, `browser` |
| `visual-prover` | sonnet-4.6 | fresh | no | true | `browser`, `screenshot_matrix`, `file`, `search` |
| `reviewer` | sonnet-4.6 | fresh | no | false | `file`, `search` (read-only) |
| `adversarial-reviewer` | opus-4.7 | fresh_clean | no | false | `file`, `search`, `shell` (read-only) |
| `researcher` | sonnet-4.6 | inherit | yes | false | `web`, `file`, `search`, `dispatch_specialist` |
| `db-analyst` | sonnet-4.6 | inherit | no | true | `database:*`, `file`, `search` |
| `browser-agent` | sonnet-4.6 | inherit | no | false | `browser`, `file`, `search` |
| `pulumi-engineer` | sonnet-4.6 | inherit | no | false | `file`, `search`, `shell`, `git`, `mcp:pulumi`, `cloud:*` |

Admins can extend this roster via `kind='custom'` rows or override individual fields via `kind='override'` rows.

#### Planner role — coordinator-only constraint

The `planner` is the only specialist whose toolset is deliberately *narrower* than its dispatch surface implies. It can dispatch any specialist in the roster, but its own allowlist is `file_read` + `search` + `web` + the two dispatch tools + `linear`. It cannot write files, run shell, run git, or hold any mutation surface against the working tree.

This is a hard rule. The planner is a coordinator, not a worker.

Rationale:

1. **Budget attribution.** When the planner does the work itself, root-budget spend gets booked to the planner Run rather than the worker Run that would naturally own the change. Every code edit and shell call should show up on a child Run's cost ledger so per-specialist budget caps actually mean something. The "patch trivially without dispatching" escape hatch breaks per-worker accounting.
2. **Sandbox + allowlist hygiene.** Workers run with the right scope by construction: `coder` has `git` because code edits need commits; `linter` has `shell` for a narrow purpose; `reviewer` is read-only. When the planner short-circuits to "I'll just patch this myself," it patches with planner-grade tool surface — typically broader than the worker's. This silently widens the trust boundary.
3. **Auditability and lineage.** Every code change in a Nigel Run should be attributable to a dispatched worker Run identified by name in the trace tree. "Trivial patches" by the planner skip that lineage and produce a Run tree where the diff appears to have come from nowhere.
4. **Observed cost behavior.** In practice the escape hatch consumes the budget. A planner that *can* edit will edit, will then read more files to verify its edit, and will then dispatch a verification specialist whose budget was meant to cover the verification but now covers re-reading work the planner already did. The classical pattern (read + decompose + dispatch + synthesize, never mutate) keeps the planner's spend bounded by coordination overhead.

The planner is permitted `linear` because Linear-triggered Runs need a callback channel at completion: post the PR URL as a comment, attach the visual-proof gallery. The `linear` tool exposed to the planner is intentionally limited to read + comment + attach operations (`linear_get_issue`, `linear_comment`, `linear_attach`). Workflow-state mutations on Linear issues (status, assignee, labels, project, cycle, estimate) route through the `linear-engineer` specialist with explicit `may_transition: true` authorization, per Section 3 lifecycle and the `linear-engineer` working principles. Comments are not state changes; attachments are not state changes.

Custom specialists registered via `kind='custom'` may opt into a wider allowlist than the planner. The coordinator-only constraint applies only to the `planner` preset row and any `kind='override'` row that targets it (the resolver enforces this — overrides on `planner` must not add `file`, `shell`, or `git`).

#### Recursion and budget invariants

1. `depth ≤ 5` enforced at every dispatch validator.
2. `may_recurse: false` specialists cannot call `dispatch_specialist` (the tool is removed from their tool list at runtime).
3. `max_children` per specialist (default 10) caps direct children of any single Run.
4. Top-level Run sets `root.budget_usd_cap`. Every model and tool call increments `cost_usd_actual` on the calling Run; cost rolls up to root via Postgres trigger.
5. Before each Workflow SDK step, compare `root.cost_usd_actual` against `root.budget_usd_cap`. On exceed, transition Run to `blocked` with reason "budget exhausted"; reassign to `human_owner`.
6. Sub-agent dispatch deducts requested `budget_usd` from remaining; child cannot exceed its allocation regardless of root remaining budget.

#### Visual proof

`visual-prover` specialist captures screenshots across resolution matrix. Default matrix in code (admin overridable per org):

```ts
DEFAULT_RESOLUTIONS = {
  desktop: [[1920,1080], [1366,768], [1536,864], [1280,720]],
  mobile:  [[360,800],  [390,844],  [393,873],  [412,915]],
  tablet:  [[768,1024], [1280,800], [800,1280], [820,1180]],
}
```

Tool: `screenshot_matrix(routes: string[], resolutions?: ResolutionMatrix)`. Runs Playwright headless, iterates resolutions × routes, saves PNGs to Vercel Blob storage, registers each as a `run_artifacts` row with `kind='screenshot'`, `metadata = {route, viewport, device}`.

Planner heuristic for dispatch:

```ts
if (diff.changedPaths.some(p => repo_config.frontend_globs.some(g => match(g, p)))) {
  dispatch_specialist({
    name: 'visual-prover',
    routes: inferRoutesFromDiff(diff, repo_config.routes_for_visual_prover),
  });
}
```

`inferRoutesFromDiff` consults `repo_config.routes_for_visual_prover`; falls back to `/` if empty.

#### Lifecycle on completion

On Run completion with screenshot artifacts:

1. Group screenshots by route, order by device tier (desktop → tablet → mobile).
2. Post a Linear comment with markdown image grid (Linear renders inline).
3. Use Linear `attachmentCreate` mutation to attach a "Visual proof" link pointing to `/runs/:id/proof` in the Nigel UI.
4. Inject the same gallery link into the auto-generated PR description.

### 5. Tool registry

#### Tool categories

| Tool | Kind | Scope | Config storage |
|---|---|---|---|
| `file`, `search`, `shell`, `git` | code | per-sandbox | (no config) |
| `web` (search/fetch) | code | per-sandbox | env: search API keys |
| `browser` + `screenshot_matrix` | code | per-sandbox | (Playwright pre-installed in sandbox image) |
| `dispatch_specialist`, `dispatch_specialists_parallel` | code | per-Run | (registry lookup) |
| `linear` | code | per-org | from `linear_workspace` row |
| `database:<name>` | dynamic | per-org | `tool_connections.kind='database'` |
| `cloud:<name>` | dynamic | per-org | `tool_connections.kind='cloud'` |
| `mcp:<name>` | dynamic | per-org | `tool_connections.kind='mcp'` |
| `slack:<name>` | dynamic | per-org | `tool_connections.kind='slack'` |

#### Per-tool config shapes

```ts
// kind='database'
{
  driver: 'postgres' | 'mysql' | 'mssql',
  url: secret,
  readonly: bool,
  allowed_schemas?: string[],
}

// kind='cloud'
{
  provider: 'aws' | 'gcp' | 'vercel' | 'pulumi',
  credentials: secret,
  regions: string[],
  allowed_actions: string[],   // e.g., ['s3:GetObject', 'ec2:DescribeInstances']
  stack_policy?: {              // pulumi-specific
    stacks: Record<string, {auto_approve: bool, destroy_allowed: bool, model_override?: string}>
  }
}

// kind='mcp'
{
  endpoint: string,
  auth: {kind: 'bearer' | 'oauth' | 'env', secret: string} | {kind: 'env', vars: string[]},
  allowed_tools: string[],
}

// kind='slack'
{
  webhook_url: secret,
  default_channel: string,
  allowed_channels: string[],
}
```

#### Tool resolution

```ts
function resolveTool(spec: string, run: Run, action: ToolAction): Tool {
  const [kind, name] = spec.split(':');
  const conn = await db.query.toolConnections.findFirst({where: {kind, name}});
  assertSpecialistAllowed(conn, run.specialist_id);
  assertCapabilityInScope(conn, action);   // e.g., write blocked when readonly=true
  return buildToolHandle(kind, conn.config, run.id);
}
```

#### Secrets handling

1. Sandbox never receives raw `tool_connections.config` values.
2. Secrets are injected only as env vars, only when a tool is invoked, only for the duration of the call.
3. Where the upstream service supports short-lived credentials, use them: AWS STS, GCP impersonation, GitHub installation tokens. Database credentials are minted as scoped sessions per Run (connection proxy in Nigel) and expire on Run end.
4. Secrets do not appear in spans, logs, artifacts, or Linear comments. The OTel exporter has a redaction layer that strips known credential patterns.

#### MCP integration

Generic MCP client. Org admin registers an MCP endpoint as `tool_connections.kind='mcp'`. At Run init, Nigel discovers the MCP's tool schemas and exposes them to the model with the same JSON Schema contract as native tools. Tool calls are proxied through Nigel — never directly from sandbox — to capture audit log and cost in `run_tool_calls`.

#### Pulumi specifics

`mcp:pulumi` is the standard Pulumi MCP server, registered like any other. Allowlist on the connection narrows to read-only operations:

```json
{
  "allowed_tools": ["preview", "stack_output", "stack_history", "list_stacks"]
}
```

`pulumi up` and `pulumi destroy` are not in the allowlist; deploys happen via Pulumi Cloud Deployments on PR merge, not from the sandbox. The `cloud:pulumi` connection holds a read-only Pulumi access token for sandbox preview; Pulumi Cloud Deployments uses a separate, never-shared token.

### 6. `.nigel.yaml` and `local_stack`

Per-repo configuration lives in `.nigel.yaml` at the repo root. Three resolution layers:

1. **File**: `.nigel.yaml` in the cloned repo. Canonical.
2. **DB fallback**: `repo_configs` table populated by admin via UI for repos without a file.
3. **Auto-detect**: sniff `package.json` and `turbo.json`. Persists the inferred config to `repo_configs.source='inferred'` and posts a warning comment "no `.nigel.yaml` found — inferred config used. Commit `.nigel.yaml` for canonical setup."

Resolution order at clone time:

```ts
function loadRepoConfig(repo: string, sha: string): RepoConfig {
  const fileConfig = readFileFromSandbox('.nigel.yaml');
  if (fileConfig) return parseAndValidate(fileConfig);
  const dbConfig = await db.query.repoConfigs.findFirst({where: {repo_full_name: repo}});
  if (dbConfig) return dbConfig.config_json;
  return autoDetectFromPackageJson(repo);
}
```

#### Schema (Zod-validated)

```yaml
version: 1

setup:
  - "bun install --frozen-lockfile"

dev_server:
  command: "bun run dev"
  port: 3000
  ready_check: "http://localhost:3000"
  ready_timeout_seconds: 60

turbo:
  enabled: true                 # auto-true if turbo.json present
  remote_cache_token: env:TURBO_TOKEN
  affected: true                # use --affected on PR diffs
  task_map:
    lint: lint
    format: format:check
    type_check: check-types
    unit_test: test:unit
    e2e_test: test:e2e
    dev: dev

checks:
  lint:        { command: "bun run lint" }
  format:      { command: "bun run format:check" }
  type_check:  { command: "bun run typecheck" }
  unit_test:   { command: "bun run test:unit", local_stack_profile: none }
  e2e_test:
    command: "bun run test:e2e"
    local_stack_profile: bare
    needs: [dev_server]

local_stack:
  # Commands run once per Run, before any profile, to provision the
  # backing infra the repo needs. Each command is responsible for its
  # own readiness — a Neon-branch provisioning script should not return
  # until the branch is reachable. There is no `wait_for` step; bake it
  # into the command. There is no docker-compose; if a repo wants
  # Postgres, it provisions a Neon branch (or whatever it uses in prod).
  # Vercel Sandbox cannot host docker — see Phase 3b-2 followup.
  #
  # Each list entry is either a plain string command or an object with
  # `cmd`, optional `timeout_seconds` (per-command cap; the outer
  # `startup_timeout_seconds` is the total wall-clock cap), and optional
  # `retry` count for transient failures.
  startup_commands:
    - "bun run scripts/provision-neon-branch.ts"
    - cmd: "bun run scripts/provision-upstash.ts"
      timeout_seconds: 60
      retry: 2
    - "bun run scripts/provision-clickhouse.ts"
    - "bun run scripts/start-api &"
    - "bun run scripts/start-gateway &"
    - "bun run scripts/start-web &"
  teardown_commands:
    - "bun run scripts/teardown-neon-branch.ts"
    - "bun run scripts/teardown-upstash.ts"
    - "bun run scripts/teardown-clickhouse.ts"
  env_file: .env.test
  startup_timeout_seconds: 120
  teardown_timeout_seconds: 60
  teardown_on_exit: true
  profiles:
    bare:
      description: "Migrations only, no data"
      post_up:
        - "bun run db:migrate"
    onboarded:
      description: "Default tenants + admin users"
      post_up:
        - "bun run db:migrate"
        - "bun run db:seed:tenants"
        - "bun run db:seed:users"
        - cmd: "bun run db:warm-cache"
          timeout_seconds: 30
          retry: 2
    full_demo:
      description: "Tenants + sample workflows + activity"
      post_up:
        - "bun run db:migrate"
        - "bun run db:seed:full"
  default_profile: bare

routes_for_visual_prover:
  - { path: "/",          auth: none }
  - { path: "/dashboard", auth: required }

frontend_globs: ["apps/web/**/*.{tsx,jsx,css}"]

monorepo:
  workspaces: [apps/web, apps/api]
  default_workspace: apps/web
```

#### Turbo-derived commands

When `turbo.enabled` (auto-true if `turbo.json` exists), commands not explicitly set in `checks` are derived:

| Section | Derivation |
|---|---|
| `checks.lint.command` | `turbo run lint` (+ `--affected` on PR runs) |
| `checks.format.command` | `turbo run format:check` |
| `checks.type_check.command` | `turbo run check-types` |
| `checks.unit_test.command` | `turbo run test:unit` |
| `checks.e2e_test.command` | `turbo run test:e2e --filter=<workspace>` |
| `dev_server.command` | `turbo run dev --filter=<default_workspace>` |
| `monorepo.workspaces` | from root `package.json` `workspaces` field |

Explicit overrides in `.nigel.yaml` always win.

#### Profile selection (no harness-level profile names)

```ts
function resolveProfile(check, specialist, dispatch, repo): Profile | null {
  if (!specialist.needs_local_stack) return null;
  if (dispatch.local_stack_profile) return repo.profiles[dispatch.local_stack_profile];
  if (check?.local_stack_profile) return repo.profiles[check.local_stack_profile];
  return repo.profiles[repo.default_profile] ?? null;
}
```

`local_stack_profile: none` (or omitted on a no-stack check) skips the entire local-stack bootstrap (no `startup_commands`, no profile's `post_up`). If a specialist requires `needs_local_stack: true` and no profile resolves, the Run fails fast with a clear error citing the specialist name and the chain of fallbacks that returned nothing.

The planner specialist receives the list of available profile names (`Object.keys(repo.profiles)`) at start; it picks per task using its own judgment, not by hard-coded name.

#### Snapshot caching

```
sandbox_snapshots
  id, repo_full_name, branch_or_sha, profile, base_snapshot_id
  built_at, ttl_until, size_bytes
  invalidation_keys: {
    'package-lock': sha256,
    'migration-files': sha256,
    'seed-script': sha256,
    '.nigel.yaml.local_stack': sha256,   // hash of the local_stack subtree
  }
```

Bootstrap flow:

1. Run dispatch with profile resolved.
2. Compute invalidation keys from current files (including a hash of the `.nigel.yaml` `local_stack` subtree so changes to `startup_commands` / `teardown_commands` / `post_up` invalidate the cache).
3. Query `sandbox_snapshots` for an exact match on `(repo, profile, keys)`.
4. **Hit**: resume from snapshot — backing infra and seed state already in place, ready in seconds.
5. **Miss**: full bootstrap: run `startup_commands` (provision external services + start any locally-hosted processes), run the profile's `post_up` commands, then snapshot the sandbox filesystem and register the row.

When migration files, seed scripts, the local_stack config, or the lockfile change, the snapshot is implicitly invalidated.

### 7. UI

Routes:

```
/                         existing chat (manual top-level Runs)
/runs                     list of all Runs across trigger sources, filterable
/runs/:id                 single Run detail (streaming chat, timeline, artifacts)
/runs/:id/tree            hierarchy tree view
/runs/:id/proof           visual-prover gallery
/admin/specialists        roster (presets read-only + customs + overrides CRUD)
/admin/connections        tool_connections CRUD per kind
/admin/repos              repo_configs (DB fallback, team→repo map)
/admin/linear             Linear OAuth + bot user + webhook secret + team→repo map
/admin/budget             org default budget caps + monthly cap
/share/:token             read-only session sharing (kept from upstream)
```

#### `/runs` list

Columns: status, trigger source, specialist, repo + branch, human owner, Linear ticket link, cost (`$X.XX of $Y.YY`), started, duration. Filters: status, trigger source, owner, date range, repo. Sort by cost, duration, started.

#### `/runs/:id` detail

Existing upstream chat-streaming view plus a metadata sidebar (specialist, parent/root, depth, sandbox id, budget bar), a lifecycle timeline (status transitions with timestamps), the human owner card with a reassign button, the Linear ticket card if applicable, a children-Runs panel listing dispatched sub-agents, and an artifacts panel grouped by kind.

#### `/runs/:id/tree`

Indented tree of Run hierarchy with each node showing specialist name, Run id, status, and rolled-up cost. Each node clickable to its detail page. Cost rollup is a denormalized SQL query on `root_run_id`.

#### `/runs/:id/proof`

Grid: rows = routes, columns = device tier (desktop / tablet / mobile), each cell expandable to a carousel of resolutions in that tier. Hover shows route + viewport. Click for fullscreen. Header links: Linear ticket, GitHub PR, parent Run.

#### `/admin/specialists`

Presets are read-only with a "View source" link to the TS file. Custom specialists CRUD (form: name, system prompt, model, tool allowlist multi-select from `tool_connections`, sandbox policy, recurse, budget default, `needs_local_stack`). Override rows are partial forms — only fields the admin wants to change; UI shows "preset value (overridden to X)" inline per field.

#### `/admin/connections`

Tabs per kind. CRUD form per kind. Test-connection button per row. `last_used_at` column to surface stale connections. Specialist allowlist multi-select per row. Secrets are write-only — entered once, encrypted, never re-displayed. "Rotate" action replaces the secret without exposing the previous value.

#### Auth

`/admin/*` requires `users.role = 'admin'`. First user to sign up becomes admin; admin can promote others. New `users.role` column defaults to `'member'`.

#### Realtime

Postgres `LISTEN/NOTIFY` on `agent_runs` row changes drives Server-Sent Events to:

- `/runs` list — new Run inserted, status changes
- `/runs/:id/tree` — child Run created, status changes

Existing chat streaming SSE in upstream is preserved.

#### Mobile

`/runs` list and `/runs/:id` detail must work on mobile (humans get reassigned to issues in Linear and may check on phone). Admin pages are desktop-only.

### 8. Observability

OTel SDK wired in web app, Workflow SDK steps, and sandbox bootstrap. Single OTLP exporter pointed at Datadog.

#### Spans

```
trace: <root_run_id>
└─ span: run.execute
   ├─ span: run.dispatch_specialist  (per child Run)
   │  └─ trace.link → child Run's trace (separate trace, linked via parent_run_id)
   ├─ span: model.call
   │  attrs: model, input_tokens, output_tokens, cache_read_tokens, cost_usd, latency_ms
   ├─ span: tool.call
   │  attrs: tool.kind, tool.name, success, latency_ms, cost_usd
   ├─ span: sandbox.exec
   ├─ span: linear.comment
   ├─ span: pulumi.preview
   ├─ span: local_stack.startup
   └─ span: profile.post_up
```

Each child Run gets its own root trace, linked to parent via OTel span links. Workflow SDK steps may resume hours later; keeping them in one trace produces unmanageable durations. Links preserve hierarchy for cross-trace search in Datadog.

Trace context propagation: sandbox VMs receive `traceparent` env var on bootstrap; tool call wrappers extract from sandbox env on the web side. Linear webhooks create traces with `linear.issue.id`, `linear.actor.id` as attributes.

#### Metrics

```
nigel.runs.started_total {trigger_source, specialist, repo}
nigel.runs.completed_total {status, specialist, repo}
nigel.runs.duration_seconds {specialist, status}        histogram
nigel.runs.cost_usd_total {trigger_source, specialist, repo}
nigel.runs.depth {root_run_id}                          histogram
nigel.tokens.input_total {model, specialist}
nigel.tokens.output_total {model, specialist}
nigel.tokens.cache_read_total {model, specialist}
nigel.tools.invocations_total {tool_kind, tool_name, success}
nigel.sandbox.bootstrap_seconds {profile, cache_hit}    histogram
nigel.budget.exhausted_total {repo}
```

#### Cost capture

Every `model.call` span computes `cost_usd` from token counts × current price table, then increments `agent_runs.cost_usd_actual` atomically. Cost rollup `root_run.cost_usd_actual = SUM(self + descendants)` is denormalized via Postgres trigger on insert/update.

Pricing lives in code (`pricing/models.ts`), keyed by AI Gateway model slug, with input / output / cache-read prices per million tokens. Updated on a per-deploy basis as providers ship new pricing.

Budget enforcement: before each model or tool call, compare `root.cost_usd_actual` against `root.budget_usd_cap`; on exceed, transition Run to `blocked` with reason `"budget exhausted"`. Org-level monthly cap (admin config): when `org.month_to_date_cost ≥ org.monthly_cap`, reject new top-level Runs with status `cancelled`, reason `"org budget exhausted"`.

#### Dashboards and alerts

Pulumi-managed Datadog `Dashboard` and `Monitor` resources, versioned with code:

1. Run health — RPS, p50/p95/p99 duration, error rate, by specialist.
2. Cost — $ per day, per repo, per specialist; budget-exhaustion rate.
3. Linear pipeline — tickets received, picked up, completed, blocked, mean time-in-status.
4. Sandbox bootstrap — cache hit rate, latency p50/p95 by profile.
5. Tool reliability — error rate per tool kind, MCP latency, DB query latency, Pulumi preview latency.

Alerts:

- Hourly spend > threshold (e.g., $50/h).
- Run stuck in `running` > 30 min with no status change.
- Linear webhook 4xx/5xx rate > 1%.
- Budget-exhaustion rate > 5% of Runs.
- Sandbox bootstrap p95 > 60s.
- Org monthly cap utilization > 80%.

#### Logs

Structured JSON logs from web app and Workflow SDK shipped to Datadog Logs, each entry tagged with `run_id`, `root_run_id`, `trace_id`, `specialist`. Datadog auto-correlates trace ↔ logs.

Sandbox stdout/stderr is captured to `run_artifacts.kind='log'` for direct viewing in the Nigel UI. The structured summary (exit codes, command line, duration) is what goes to Datadog.

#### Retention

| Data | Retention |
|---|---|
| Datadog traces | Datadog default (15 days indexed, archive longer) |
| `agent_runs` rows | indefinite |
| `run_artifacts` | 90 days, then blob-store eviction; configurable per org |
| `run_messages`, `run_tool_calls` (non-completed) | 90 days |
| `run_messages`, `run_tool_calls` (completed) | indefinite |

### 9. Error handling

#### Error taxonomy

| Class | Examples | Recovery |
|---|---|---|
| Transient | model rate-limit, network blip, sandbox cold-start timeout, Linear API 5xx | Retry with exponential backoff, max 3 attempts (Workflow SDK durable retry) |
| Tool-level | shell exit non-zero, tsc errors, test failures, lint violations | NOT errors — return result to model; model decides next step |
| Budget | `cost_usd_actual ≥ budget_usd_cap` | Run → `blocked`; reassign to human; comment "budget exhausted, raise cap to resume" |
| Approval needed | `awaiting_approval` state (reserved; no preset specialists trigger it after Pulumi shift) | Run → `awaiting_approval`; listens for `/approve` / `/reject` |
| Validation / config | Bad `.nigel.yaml`, missing repo mapping, no profile resolved, unknown specialist name, sandbox creation failure | Run → `failed` immediately; comment with specific reason; no retry |
| Auth / permission | GitHub App token expired, Linear OAuth revoked, MCP auth fails | Run → `failed`; admin alert via Slack tool_connection; no retry until admin fixes |
| Sandbox runtime | Sandbox killed mid-Run, workflow step timeout | Resume from last checkpoint (Workflow SDK durable). After 3 consecutive resume failures → `failed` |
| Infinite loops / cost spiral | Model retries same broken edit, budget burning fast | Tripped by budget cap. Per-tool soft caps (e.g., max 50 file edits per Run) → tool refuses with "edit budget exhausted, plan differently" |
| Internal error | Unhandled exception in Nigel code | Caught at Workflow SDK step boundary → Run → `failed`; full stack trace to Datadog; comment "internal error: <run_id>" + admin alert |

#### Workflow SDK retry policy (transient class)

```ts
{
  initial_interval_seconds: 2,
  backoff_coefficient: 2,
  maximum_interval_seconds: 60,
  maximum_attempts: 3,
}
```

Applied to: model API calls, GitHub API, Linear API, MCP calls, sandbox API. Non-idempotent operations (e.g., Linear `commentCreate`) use idempotency keys (`run_id` + message hash) to dedupe across retries.

#### Cancel semantics

Cancelling a Run cascades to all descendants (tree walk on `parent_run_id` plus Workflow SDK cancellation tokens). Sandboxes are torn down. Final cost is recorded. Linear comment is posted with cancellation actor and a note about partial work. The branch (if any) is retained for forensics, not pushed.

#### Resumability

`running` Runs survive deploys and sandbox crashes via Workflow SDK durability. `blocked` and `awaiting_approval` Runs persist indefinitely until human action. Comment commands resume via webhook → Workflow SDK signal. TTL: `awaiting_approval` 24h, `blocked` 7 days → auto-cancel with comment.

#### No-data-loss invariants

1. Sandbox state is lost on crash, but all artifacts (file edits, screenshots, logs) are written to `run_artifacts` blob-store on each `commit`/`screenshot`/`log` event, not at Run end. Mid-Run failure preserves work product.
2. Budget counter is incremented before the model call (debit pattern). A crash does not undercount and let a Run sneak past the cap on resume.
3. Linear state (assignee, comments) is the source of truth for the human-facing view. Inconsistencies are reconciled by reading Linear, not by patching.

#### Failure isolation

Each Run is its own Workflow SDK instance with its own sandbox. One failing Run does not affect siblings. Bad output from a specialist (e.g., `coder` writes broken code) is caught by downstream specialists (`tester`, `reviewer`); planner loops or gives up; failure does not spread. Misconfigured tool connections fail only the Runs that use them, not the whole org.

### 10. Testing strategy

#### Test pyramid for Nigel itself

```
                     ┌─────────────────────┐
                     │   Eval suite        │  end-to-end agent quality
                     │   (slow, $$, gated) │
                     └─────────────────────┘
                    ┌───────────────────────┐
                    │   E2E (Playwright)    │  full UI + workflow + sandbox
                    └───────────────────────┘
                   ┌─────────────────────────┐
                   │   Integration           │  workflow + DB + mocked sandbox
                   └─────────────────────────┘
                ┌───────────────────────────────┐
                │   Unit (Bun test, Vitest)     │  resolvers, parsers, lifecycle
                └───────────────────────────────┘
```

#### Unit (fast, on every commit)

- `loadRepoConfig` precedence resolver; Zod validation cases for `.nigel.yaml`.
- `resolveProfile` capability resolver; `none` and missing-profile cases.
- `resolveTool` parser; capability-scope check; allowlist enforcement.
- `getSpecialist` resolver: code preset > override merge > custom row.
- `Run.create` validator: depth ≤ 5, recurse perms, budget arithmetic, max_children.
- `costRollup` invariant: `root.cost = sum of subtree`.
- Pricing calculator: token counts × price table → USD with rounding.
- Linear comment command parser (`/approve`, `/reject`, `/resume`, `/run`, `/cancel`).
- Repo-mapping resolver: Linear native > team_repo_map > label override.
- Trigger source dedup: idempotency key derivation for webhook events.
- Snapshot invalidation key hashing: lockfile + local_stack subtree + migrations + seeds.

Target: < 10s for full unit suite. Run on every commit.

#### Integration (workflow-level, mocked external)

Real Postgres (test container), real Workflow SDK, mocked LLM + sandbox + Linear + GitHub. LLM mock is scripted responses keyed by message-history hash; deterministic. Sandbox mock is in-memory FS + scripted shell exit codes.

Cases:

- Linear webhook → `Run.create` → workflow start → status transitions.
- Chained dispatch: parent → child Run, durable wait, child completes, parent resumes.
- Budget exhaustion: simulated model calls accumulating cost → Run transitions to `blocked` at exact cap.
- Approval gate generic: `awaiting_approval` → `/approve` → resume.
- Idempotency: replay same Linear webhook 3× → Run created once.
- Cascading cancel: cancel root → all descendants cancelled, sandboxes torn down.
- Reassignment ping-pong: human reassigns mid-Run → cancel + comment.
- Snapshot cache: same profile + same hashes twice → second resume from snapshot.

Target: < 90s for full integration suite. Run on every PR.

#### E2E (Playwright on Nigel itself)

Real browser hitting a deployed Nigel preview environment with real Postgres, real Workflow SDK, real Vercel Sandbox, mocked LLM + Linear + GitHub (HTTP-level mocks via Mockttp/MSW).

Critical paths:

- Sign in via GitHub → land on `/runs`.
- Manual chat Run → streaming → completion → artifacts visible.
- Admin creates a custom specialist → dispatch a Run using it → completes.
- Admin registers a Slack connection → trigger Run that posts → assertion on mocked Slack endpoint.
- Linear webhook (synthesized) → Run appears in `/runs` list → tree view shows hierarchy → `/proof` shows screenshots.
- Cancel mid-Run → status updates, sandbox tear-down logged.
- Visual proof gallery: image grid renders, viewports labeled correctly.

Run on every PR via GitHub Actions, against a per-PR Vercel preview deploy.

#### Eval suite (agent quality, gated)

Real LLM, real sandbox, real-ish repos. Measures whether agents actually succeed at tasks. Eval set: small curated repos with scripted Linear-ticket scenarios, organized by category — code edits, tests, refactor, visual, multi-step, adversarial (prompt injection, secret-exfiltration attempts).

Scoring: pass/fail per scenario, plus cost and duration. Trend tracked over time. Nightly cron in CI; results posted to a Datadog dashboard. Fails the build if regression > 10% week-over-week.

Cost cap: $50/run for nightly eval. Skip if month-to-date eval spend > $1000.

#### Coverage targets

Unit + integration: 80% line coverage, 100% on critical paths (Run lifecycle, budget, auth, idempotency). E2E: scenario completion, not coverage.

#### Adversarial validation

Every PR that changes Run lifecycle, trigger handling, budget, or tool resolution requires adversarial review. Reviewer checks: race conditions on parent/child state, idempotency at boundaries, secret leakage in spans/logs, cost double-counting, Linear comment dedup.

### 11. Migration ordering (phases)

Phase 0 — Fork, rebrand, strip Vercel OAuth, document upstream SHA.

Phase 1 — `Run` abstraction. Add tables; backfill existing chat sessions; redirect storage to Run-scoped tables; cost rollup; lifecycle state machine. Feature-flag the new path; keep upstream behavior as fallback.

Phase 2 — Specialist registry. Presets file in code; resolver; `dispatch_specialist` tool; parallel dispatch; budget enforcement at boundaries; `needs_local_stack` field.

Phase 3 — Repo config layer. `.nigel.yaml` Zod schema; `repo_configs` DB fallback; Turbo derivation; `local_stack` profiles + post-up + readiness gates + teardown; sandbox snapshot caching.

Phase 4 — Specialist roster (one preset at a time, each its own PR with eval scenarios): `coder` → `linter` / `formatter` / `type-checker` / `unit-tester` → `e2e-tester` → `reviewer` / `adversarial-reviewer` → `researcher` → `db-analyst` → `browser-agent` + `screenshot_matrix` → `visual-prover` + `/runs/:id/proof` → `pulumi-engineer` + Pulumi MCP.

Phase 5 — Tool registry + connections. `tool_connections` with encrypted secrets and scoped runtime credentials; `/admin/connections`; DB tool (Postgres first); generic MCP client; Slack webhook tool; Cloud SDK wrappers (only providers actually used).

Phase 6 — Linear integration. OAuth + admin UI; webhook handler; lifecycle hooks (comment + ping-pong); comment command parser; idempotency.

Phase 7 — Observability. OTel wired across web/workflow/sandbox; OTLP → Datadog; metrics emission; structured logs with trace correlation; Pulumi-managed dashboards and monitors.

Phase 8 — UI completeness. `/runs` list with filters, `/runs/:id/tree`, `/runs/:id/proof`, all `/admin/*` pages, mobile responsive, cost/budget bar, cancel/retry, SSE live updates.

Phase 9 — Eval suite + hardening. Eval scenarios across categories; nightly eval cron + Datadog dashboard; adversarial-validation pass on critical paths; failure-mode drills (kill Postgres, kill sandbox, expire GitHub token, revoke Linear OAuth mid-Run); reference docs.

#### Ordering invariants

1. Phase 0 precedes everything.
2. Phase 1 precedes 2-9 (Run abstraction is load-bearing).
3. Phase 2 + 3 unblock Phase 4 (specialists need both registry and repo config).
4. Phase 5 unblocks Phase 4 specialists that need tool connections (`db-analyst`, `pulumi-engineer`, `browser-agent` browser config).
5. Phase 6 needs `coder` and `planner` to exist (Linear-triggered Runs need at least those).
6. Phase 7 runs in parallel with anything from Phase 2 onward — wire OTel as you go, not at the end.
7. Phase 8 ships incrementally throughout — `/runs` list useful from Phase 1.
8. Phase 9 gated on most prior phases existing.

#### Upstream sync

Periodic merges from `vercel-labs/open-agents`. Most divergence lives in new files (specialists, runs, triggers, connections) and a handful of touched upstream files (auth config, chat session storage). Conflicts will concentrate in `apps/web` route handlers and Drizzle schema. Upstream SHA tracked in `UPSTREAM.md`.

#### Rollback plan

Phase 1's feature flag covers Phase 2-3 rollouts. Phase 4+ each ships behind its own flag (`NIGEL_ENABLE_LINEAR_TRIGGERS`, `NIGEL_ENABLE_VISUAL_PROVER`, etc.) so individual capabilities can be killed without rollback. DB migrations are additive only until Phase 9.

## Acceptance criteria

1. A Linear ticket assigned to the bot user creates a Run, the planner dispatches at least one specialist, and on completion the issue is reassigned to the human owner with a PR link comment.
2. A planner Run can dispatch `coder`, `linter`, `formatter`, `type-checker`, `unit-tester`, `e2e-tester`, `reviewer`, and `adversarial-reviewer` in any combination, with parallel groups, and produce a passing PR for a curated eval scenario.
3. Recursion at depth 6 is rejected by the dispatch validator with a clear error.
4. A Run that exceeds its `budget_usd_cap` mid-execution transitions to `blocked` and reassigns to the human owner with a Linear comment.
5. Cancelling a parent Run cancels all descendants and tears down their sandboxes within 30 seconds.
6. Two identical Linear webhooks (same `event.id`) produce exactly one Run.
7. A `visual-prover` Run posts a Linear comment with screenshots at every default-matrix resolution and a link to `/runs/:id/proof` that renders the same images.
8. `/admin/connections` allows admin to register a Postgres `tool_connections.kind='database'` row; `db-analyst` Run can query it; secret never appears in spans, logs, artifacts, or Linear comments.
9. A repo with `turbo.json` and no `.nigel.yaml` runs lint/typecheck/test via derived `turbo run` commands without admin intervention.
10. A repo declaring `local_stack.profiles.onboarded` runs `e2e-tester` against `startup_commands` + the profile's `post_up` scripts; second run with same hashes resumes from snapshot in under 10 seconds.
11. A `pulumi-engineer` Run can run `pulumi preview` but cannot run `pulumi up` (allowlist enforces).
12. Datadog dashboards (`Run health`, `Cost`, `Linear pipeline`, `Sandbox bootstrap`, `Tool reliability`) render with live data from a deployed Nigel.
13. Kill -9 the web app mid-Run; on restart, Workflow SDK resumes from the last checkpoint and the Run reaches `completed` if it was on track.
14. The eval suite runs nightly, completes, and posts results to Datadog with no manual intervention.

## Open questions

1. **Voice input UX**: upstream's ElevenLabs transcription path — kept as-is or hidden behind a feature flag? (Keeping per Q11.2 but UX surface unspecified.)
2. **Read-only sharing for chained Runs**: do `/share/:token` links cover the entire Run tree or only the shared Run? (Default assumption: entire tree from shared Run as root.)
3. **Per-org budget defaults**: org-level monthly cap is admin-configurable, but is there a default for new orgs? (Default assumption: $500/month, surfaced in `/admin/budget` for editing.)
4. **Linear comment edits**: does an edited comment re-trigger the comment-command handler? (Default assumption: no — only `commentCreate` events; edits ignored.)
5. **MCP tool discovery caching**: how often does Nigel re-discover tools from a registered MCP endpoint? (Default assumption: at Run init, not per tool call; admin can force-refresh from `/admin/connections`.)
6. **Pulumi Cloud Deployments link surfacing**: which Pulumi Cloud API endpoint to poll for the deployment URL after PR push? (Default assumption: `Deployment` resource on the stack matching the branch; specifics deferred to Phase 4 Pulumi PR.)
7. **GitHub App permissions scope**: minimum required permissions for the App (Contents R/W, PRs R/W, Issues read, Webhook receive)? (Default assumption: same as upstream's GitHub App requirements; verify against new flows.)
8. **Eval-suite repo selection**: which curated repos are in the v1 eval set? (Default assumption: a tiny Next.js todo app, a small Pulumi sample, a Drizzle CRUD app — each public, vendored as git submodules under `eval/repos/`.)

## Assumptions

1. Upstream `vercel-labs/open-agents` HEAD as of fork date is stable enough to base on; no in-flight breaking changes expected from upstream during Phase 0–1.
2. ~~Vercel Sandbox supports docker-in-docker (compose up) within the sandbox image. If not, `local_stack` requires a custom base snapshot with docker pre-installed; that custom snapshot becomes a deploy prerequisite documented in the deploy guide.~~ **Invalidated 2026-05-09**: a spike confirmed Vercel Sandbox's capability bounding set excludes `CAP_SYS_ADMIN`, `CAP_NET_ADMIN`, and `CAP_SYS_PTRACE`. Docker cannot run inside Vercel Sandbox regardless of binary availability. `local_stack` was redesigned as a list of `startup_commands` + `teardown_commands` + profile `post_up` commands the repo author writes against its chosen cloud APIs (Neon, Upstash, ClickHouse Cloud, etc.) rather than docker-compose. See section 6.
3. Vercel AI Gateway exposes Anthropic and OpenAI with the slugs we expect (`anthropic/claude-opus-4.7`, `anthropic/claude-sonnet-4.6`, `anthropic/claude-haiku-4.5`, `openai/gpt-*`). Pricing table in code is updated when slugs or prices change.
4. Pulumi MCP server exists and exposes the tools `preview`, `stack_output`, `stack_history`, `list_stacks`. If naming differs, the connection's `allowed_tools` adjusts at registration time.
5. Linear's webhook events include `Issue.assignee_changed` with both prior and new assignee, plus an `actor` field identifying who made the change. If actor is not provided, fall back to `creator` per Section 3.
6. Linear renders inline image markdown (`![alt](url)`) in comments. If not, fall back to `attachmentCreate` mutation with image URLs.
7. First user to sign up becomes admin. For multi-admin deployments, an admin can promote others via `/admin/users` (deferred to Phase 8 if not present in upstream).
8. `to11ai` org's deploy uses Datadog as the observability vendor (per Q11.6 saved as user feedback). If a different vendor is preferred for a fork, the OTel exporter swaps without other changes.
9. Pulumi Cloud Deployments handles `pulumi up` on PR merge; sandbox-side `pulumi-engineer` is read-only by design.
10. The repository will be initialized as a fork of `vercel-labs/open-agents`; this spec is being written into an empty directory in advance of the fork. Phase 0 creates the actual git history.

## References

- [vercel-labs/open-agents](https://github.com/vercel-labs/open-agents)
- [Vercel Workflow SDK](https://vercel.com/docs/workflow)
- [Vercel Sandbox](https://vercel.com/docs/sandbox)
- [Vercel AI Gateway](https://vercel.com/docs/ai-gateway)
- [Better Auth](https://www.better-auth.com/)
- [Linear API: Webhooks](https://developers.linear.app/docs/graphql/webhooks)
- [Linear API: Comments and mentions](https://developers.linear.app/docs/graphql/comments)
- [Pulumi Cloud Deployments](https://www.pulumi.com/docs/pulumi-cloud/deployments/)
- [Turbo `--affected` and `--filter`](https://turbo.build/repo/docs/reference/run)
- [OpenTelemetry OTLP exporter](https://opentelemetry.io/docs/specs/otlp/)
- [Datadog: OTLP ingest](https://docs.datadoghq.com/opentelemetry/)
