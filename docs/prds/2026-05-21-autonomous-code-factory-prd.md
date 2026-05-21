# PRD: Autonomous Code Factory

**Date:** 2026-05-21
**Status:** Draft
**Owner:** Matt Calhoun
**Resolves:** Assessment request 2026-05-21: what is missing for Nigel to become an autonomous code factory
**Supersedes:** none

## Summary

Nigel already has much of the substrate for agentic software work: persisted `Run` trees, Linear-triggered planner runs, LLM-backed specialists, sandbox execution, repo config parsing, local-stack startup, encrypted tool connections, cost tracking, Linear activity streaming, and basic run visibility. The missing product is not "can an agent edit code?" The missing product is a **factory**: a reliable ticket-to-PR system that owns planning, implementation, verification, review, PR creation, CI babysitting, human approval, and recovery as one coherent workflow.

This PRD defines the product requirements for making Nigel an autonomous code factory. The launch shape is intentionally practical: Linear is the primary intake surface; Nigel creates a factory run, decomposes the ticket, produces patch artifacts, integrates and verifies them, opens a draft PR, watches CI, performs a bounded fix loop, and hands the work back with proof. More advanced autonomy, including auto-merge, visual proof everywhere, infra apply workflows, and learning loops, is phased after the first merge-ready factory loop is reliable.

## Problem

Nigel can currently start a Linear-triggered planner run and the planner can dispatch specialists. That is useful, but it is not yet a factory.

The current system still relies too heavily on prompt compliance and free-form specialist output. A planner may dispatch a coder, tester, or reviewer, but the platform does not yet have a product-level lifecycle that says: "this ticket has a plan, these patch bundles were accepted, these checks passed, this PR was opened, these CI failures were classified, this fix loop ran, this proof is attached, this is now waiting for a human." Without that lifecycle, the user sees activity but not an accountable delivery pipeline.

There is also a handoff gap. Fresh-sandbox specialists can inspect or edit code, but there is no first-class patch artifact that the root run applies into an integration workspace. That prevents reliable parallel implementation and makes verification ambiguous: the platform cannot prove which changes were actually integrated versus merely summarized by a child agent.

Finally, the GitHub delivery loop is still chat/session-centered. Chat flows have commit, push, PR, and merge UI. Linear-triggered factory runs do not yet own branch creation, PR creation, PR updates, GitHub checks, review feedback, or merge-readiness. For a code factory, PR lifecycle is not an optional UI action; it is the factory's output.

## Goals

1. Make Linear ticket delegation produce an observable, resumable factory run with explicit phases from intake through PR readiness.
2. Make code changes first-class patch artifacts that can be integrated, verified, reviewed, and traced back to the specialist that produced them.
3. Make `.nigel.yaml` checks the canonical verification contract for each repo.
4. Make Linear-triggered runs own branch, commit, draft PR, CI watch, and bounded fix-loop behavior.
5. Preserve human control at meaningful gates: ambiguous requirements, risky changes, budget extension, destructive operations, and merge/ready-for-review policy.
6. Give reviewers a small, evidence-rich PR: ticket link, run link, summary, patch provenance, checks, risks, and proof.
7. Give operators enough policy, queue, budget, and recovery controls to run the factory safely.
8. Measure whether the factory is actually getting better: autonomy rate, merge-ready rate, cost, cycle time, fix-loop count, and escalation quality.

## Non-goals

- **Autonomous production deploys.** This PRD ends at merge-ready PR or policy-approved merge. Production deployment automation is a separate product decision.
- **Unbounded autonomy.** The factory must have retry, cost, child-run, and concurrency caps.
- **Arbitrary cloud writes from sandboxes.** Destructive or privileged operations remain gated by registered scoped tools and human approval.
- **Replacing human product judgment.** Ambiguous requirements and high-risk architecture choices should escalate with options, not be guessed through.
- **Multi-tenant SaaS administration.** This PRD assumes the existing single-deployment Nigel model.
- **Pixel-level visual design.** UX surfaces are described at the capability level.

## Vocabulary

| Term | What it means |
|---|---|
| Factory run | A top-level Nigel run whose purpose is to deliver a code change from intake to PR readiness. It may own many child specialist runs. |
| Factory phase | The product-level progress state inside a factory run: intake, planning, implementation, integration, verification, review, PR draft, CI watch, fix loop, awaiting human, merge ready, terminal. Distinct from the coarse `agent_runs.status`. |
| Specialist run | A child run executed by a role-specific agent such as `coder`, `linter`, `type-checker`, `unit-tester`, `reviewer`, or `adversarial-reviewer`. |
| Integration workspace | The root sandbox/worktree where accepted patch bundles are applied and verified before PR creation. |
| Patch bundle | A durable artifact produced by a writing specialist. Contains base SHA, diff or commit ref, changed files, summary, risk notes, and local verification evidence. |
| Verification bundle | The set of checks, logs, pass/fail results, and rerun history that supports a PR. |
| Fix loop | A bounded cycle where Nigel classifies a failed check or CI job, dispatches the right specialist, applies the resulting patch, and reruns verification. |
| Proof | Any reviewer-consumable evidence attached to the run or PR: check logs, screenshots, reviewer reports, Pulumi previews, diff summaries, or CI links. |
| Human gate | A durable pause that requires an authorized person to approve, reject, clarify, extend budget, or change policy before the factory continues. |

## Personas

### Engineering Lead

Owns team throughput and code quality. Wants routine tickets to turn into reviewable PRs without constant supervision. Cares about merge-ready rate, cycle time, and whether the system escalates honestly when it is stuck.

### Developer Reviewer

Reviews factory-authored PRs. Wants the diff to be small, coherent, tested, and explained. Does not want to reconstruct agent behavior from chat transcripts.

### Product Owner

Delegates work from Linear. Wants ticket status and comments to reflect reality: picked up, working, blocked, PR opened, needs approval, or completed.

### Platform Operator

Keeps Nigel reliable and within budget. Cares about queues, stale runs, leaked sandboxes, retry storms, credential boundaries, and observability.

### Compliance / Security Reviewer

Reviews sensitive changes. Cares about approval gates, audit history, secret redaction, destructive action prevention, and provenance of code changes.

## User stories

### US-1: Delegate a Linear ticket to the factory

**As a** Product Owner,
**I want to** assign or delegate a Linear ticket to Nigel,
**so that** Nigel starts a factory run without requiring me to open the Nigel chat UI.

**Acceptance criteria:**
- Linear assignment, app delegation, AgentSession, and `/run` command can create a factory run.
- The run links back to the Linear issue and records the human owner.
- The Linear issue receives a comment that Nigel picked up the work, including the run link and the first visible phase.
- If repo or owner resolution fails, Nigel comments with the exact missing configuration and does not create a run.
- Duplicate webhook deliveries and near-simultaneous Linear events do not create duplicate active factory runs for the same issue.
- The run appears in `/runs` with trigger `linear`, repo, owner, phase, status, budget, and cost.

### US-2: See the factory plan before code changes

**As an** Engineering Lead,
**I want to** see the factory's decomposition before implementation proceeds,
**so that** I can trust the work is scoped and detect bad plans early.

**Acceptance criteria:**
- Every factory run creates a structured plan artifact before writing code.
- The plan includes scope, assumptions, files/areas likely touched, specialist assignments, planned checks, risk level, and human gates expected.
- Plans for low-risk tickets may auto-proceed by repo policy.
- Plans for high-risk or ambiguous tickets pause at a human gate with approve/reject/clarify options.
- Rejected plans do not start implementation; clarification appends context and replans.

### US-3: Produce code as patch bundles

**As a** Developer Reviewer,
**I want** every writing specialist to produce a patch bundle,
**so that** the final PR can be traced to concrete agent outputs rather than free-form summaries.

**Acceptance criteria:**
- `coder`, `formatter`, `linter`, `type-checker`, `unit-tester`, and `e2e-tester` can produce patch bundles when they edit code.
- A patch bundle records base SHA, diff or commit ref, changed files, specialist run id, summary, risk notes, and verification commands the specialist ran.
- Patch bundles are stored as run artifacts and are visible from the run detail page.
- The root factory run can accept, reject, or supersede each patch bundle.
- A patch bundle cannot be applied if its base no longer matches and cannot be rebased cleanly.
- The final PR body links to patch provenance.

### US-4: Integrate child work into one root workspace

**As a** Platform Operator,
**I want** child specialist changes to merge through a root integration workspace,
**so that** parallel work does not become an untracked collection of sandbox edits.

**Acceptance criteria:**
- The factory run owns one integration workspace for the final PR diff.
- Accepted patch bundles are applied in a deterministic order.
- Non-overlapping patches from parallel specialists can apply automatically.
- Conflicting patches create a conflict artifact with files, hunks, and specialist run ids.
- A bounded integration specialist may resolve conflicts when policy allows.
- Unresolved conflicts pause the factory and comment on Linear with the conflict summary.

### US-5: Run canonical repo checks

**As an** Engineering Lead,
**I want** Nigel to run the repo's declared checks,
**so that** PR readiness is based on the same commands humans and CI use.

**Acceptance criteria:**
- The factory resolves checks from `.nigel.yaml`, DB fallback, or auto-detected repo config.
- Check results record check kind, command, working directory, local-stack profile, start/end timestamps, exit code, logs, parsed failure summary, and retry number.
- The integration workspace must pass required local checks before PR readiness.
- Check logs are stored as artifacts and linked from `/runs/:id`.
- A missing required check configuration produces a clear Linear blocker instead of silently skipping verification.
- Re-running checks creates a new attempt and preserves prior attempts.

### US-6: Fix failed local verification

**As a** Developer Reviewer,
**I want** Nigel to route check failures to the right specialist,
**so that** simple lint/type/test failures are fixed before I review the PR.

**Acceptance criteria:**
- Format failures route to `formatter`.
- Lint failures route to `linter`.
- Type failures route to `type-checker`.
- Unit failures route to `unit-tester`.
- E2E failures route to `e2e-tester` when local-stack configuration exists.
- Each fix attempt has a retry cap per check kind and per factory run.
- If retries are exhausted, Nigel pauses with a concise blocker: failing command, last error summary, attempted fixes, and run links.

### US-7: Open and maintain a draft PR

**As an** Engineering Lead,
**I want** Nigel to open a draft PR from a Linear-triggered run,
**so that** the factory output enters the normal review workflow.

**Acceptance criteria:**
- Nigel creates a deterministic branch name based on repo policy and Linear key.
- Nigel commits the integrated workspace with a conventional commit message.
- Nigel opens a draft PR with ticket link, run link, summary, changes, verification bundle, known risks, and proof links.
- If a PR already exists for the active factory run, Nigel updates it rather than opening a duplicate.
- The Linear issue receives the PR link.
- The run stores PR number, URL, branch, commit SHA, and current PR state.

### US-8: Watch CI and run a bounded CI fix loop

**As a** Developer Reviewer,
**I want** Nigel to watch required GitHub checks and attempt obvious fixes,
**so that** I do not inherit a failing PR when the failure is mechanical.

**Acceptance criteria:**
- Nigel polls or subscribes to GitHub check status for the factory PR.
- Required checks are resolved from repo policy and GitHub branch protection where available.
- Failed checks are classified by job, log excerpt, file path hints, and failure type.
- Nigel can dispatch one or more fix specialists based on the failure class.
- CI fix attempts update the same PR branch.
- CI watch stops when checks pass, retry budget is exhausted, human review is required, or timeout is reached.
- Linear receives a terminal CI comment: passing, blocked with failing checks, or waiting for review.

### US-9: Address review feedback

**As a** Developer Reviewer,
**I want** Nigel to respond to review comments when asked,
**so that** the factory can keep a PR moving after initial review.

**Acceptance criteria:**
- A reviewer can trigger a review-fix loop from Linear or the PR.
- Nigel fetches unresolved review threads and check annotations.
- Nigel groups feedback into actionable tasks and non-actionable notes.
- Nigel applies fixes through patch bundles and reruns relevant checks.
- Nigel replies with what was addressed and what remains blocked.
- Retry budget prevents endless review churn.

### US-10: Pause for human approval

**As a** Compliance / Security Reviewer,
**I want** Nigel to pause before risky actions,
**so that** autonomy does not bypass review policy.

**Acceptance criteria:**
- Repo/org policy can require approval for dependency changes, secrets/config edits, infra changes, destructive commands, budget extension, PR ready-for-review, auto-merge, or merge-with-failing-checks.
- Approval requests include the diff or preview, risk summary, checks, and proposed next action.
- The workflow waits durably; process restart does not lose the pending action.
- `/approve` resumes the exact pending action and records approver/timestamp.
- `/reject` cancels or returns to planning with the rejection reason.
- Unauthorized approval attempts are rejected and logged.

### US-11: Prove frontend changes visually

**As a** Developer Reviewer,
**I want** screenshots attached when Nigel changes UI code,
**so that** I can inspect behavior without pulling the branch locally.

**Acceptance criteria:**
- Frontend file changes can trigger a visual proof phase by repo policy.
- `visual-prover` runs configured routes from `.nigel.yaml`.
- Screenshots are captured across the configured viewport matrix.
- Screenshots are stored as artifacts and rendered in `/runs/:id/proof`.
- PR body and Linear comment link to the proof gallery.
- If visual proof cannot run because routes or local stack are missing, Nigel reports that as a proof gap rather than pretending it passed.

### US-12: Recover from interrupted work

**As a** Platform Operator,
**I want** factory runs to recover or fail cleanly,
**so that** autonomy does not create hidden operational debt.

**Acceptance criteria:**
- Workflow steps persist enough state to reconnect to an existing sandbox instead of provisioning duplicates on replay.
- Provision, execute, integrate, verify, PR, CI watch, and teardown are separate durable steps.
- Stale pending/running runs appear in an intervention queue.
- Operators can retry, cancel, or mark failed with a reason.
- Sandbox teardown failures are visible and retryable.
- Runs that exceed heartbeat, duration, budget, or retry policy stop automatically with a clear reason.

### US-13: Configure factory policy per repo

**As a** Platform Operator,
**I want** repo-level policy controls,
**so that** autonomy can be enabled gradually and safely.

**Acceptance criteria:**
- Admins can enable or disable factory PR creation per repo.
- Repo policy controls branch prefix, required local checks, required GitHub checks, max fix attempts, max child runs, max parallel specialists, auto-ready behavior, auto-merge behavior, and approval gates.
- Org defaults apply when repo policy omits a value.
- Policy changes are audited.
- New runs read policy at intake and persist the policy snapshot used for that run.

### US-14: Measure factory performance

**As an** Engineering Lead,
**I want** factory metrics and evals,
**so that** we know whether autonomy is improving or just producing activity.

**Acceptance criteria:**
- Metrics include autonomy rate, draft-PR rate, merge-ready rate, median cycle time, median cost, check-fix success rate, CI-fix success rate, human-gate frequency, and failure reasons.
- Metrics can be filtered by repo, specialist, trigger source, and date range.
- An eval harness can run fixture tickets through the factory and compare outcomes across releases.
- Failed evals link to run artifacts, patch bundles, and check logs.
- Recurring failure classes can become prompt updates, repo config suggestions, or new regression fixtures.

## Functional requirements

### Factory phase model

- `agent_runs.status` remains the coarse lifecycle status.
- Factory runs need an additional phase/progress model. Implementation may use a new table or additional columns, but the product surface must show phase history.
- Phase transitions are append-only audit events.
- Every phase records start/end timestamps, result, and key artifact references.
- Phase transitions must be safe to retry.

### Patch artifacts

- Patch bundles are first-class artifacts, not only text in an assistant message.
- Patch application occurs only in the integration workspace.
- Patch provenance is included in the final PR.
- Patch bundle schema must support both raw diffs and commit refs, because different sandbox/branch strategies may choose different transport.

### Verification

- `.nigel.yaml` remains the repo-authored source of truth for checks where present.
- DB fallback and auto-detect are allowed, but must be labeled as fallback in the run.
- Check outputs are stored as artifacts.
- The factory cannot mark a PR merge-ready without a verification bundle or a human override.

### GitHub lifecycle

- Factory-owned PRs are idempotent: one active PR per factory run.
- PR updates preserve reviewer context and do not force-push unless policy allows.
- CI watch must distinguish pending, passing, failing, cancelled, skipped, and required-review states.
- Branch protection and mergeability are read from GitHub where possible.

### Linear lifecycle

- Linear comments should be short and stateful: picked up, planned, PR opened, blocked, waiting for approval, merge-ready, failed.
- Nigel should not spam every internal step to Linear; detailed trace lives in Nigel.
- AgentSession activity can stream step-level thoughts/actions, but terminal ticket comments should summarize product state.

### Admin surfaces

Required launch or near-launch admin surfaces:

- Factory policy per repo.
- Factory queue / stuck run intervention.
- Specialist presets and overrides.
- Tool connections.
- Linear workspace mapping.
- Budget and concurrency settings.

### Security and approval

- Tool and connection scopes remain enforced at runtime, independent of prompts.
- Secrets must be redacted from messages, logs, artifacts, spans, and Linear comments.
- Risky actions require durable approval based on policy.
- Approval records include actor, timestamp, run id, pending action, and evidence artifact links.

## UX surfaces

### Linear

Linear remains the primary user-facing intake and status surface for factory runs. Comments should include links, concise state, and next action. Slash commands remain the control surface for owners: `/run`, `/cancel`, `/resume`, `/approve`, `/reject`.

### `/runs`

The runs list should surface factory phase, PR state, CI state, cost, owner, repo, trigger, and whether human action is required. It should support filters for stuck, awaiting approval, failed, merge-ready, and active CI watch.

### `/runs/:id`

The run detail page should show:

- phase timeline
- run tree
- plan artifact
- patch bundles
- verification bundle
- tool calls and messages
- PR metadata
- CI watch history
- approval requests
- artifacts and proof

### `/runs/:id/proof`

The proof page should render screenshots, check logs, patch provenance, reviewer reports, and other high-signal artifacts in a reviewer-friendly view.

### Admin factory queue

Operators need a queue of stale, failed, blocked, awaiting-approval, leaked-sandbox, and CI-timeout runs with retry/cancel/mark-failed controls.

## Non-functional requirements

### Reliability

- Workflow replay must not duplicate active PRs, duplicate factory runs, or orphan sandboxes.
- Every side effect must have an idempotency key.
- Runs must fail closed with a user-visible reason.

### Performance

- A small ticket should reach draft PR in under 15 minutes when checks are local and pass on first attempt.
- Local-stack snapshot acceleration should make repeated E2E setup meaningfully faster once wired.
- CI watch polling must avoid API rate-limit pressure through backoff and webhook support where possible.

### Cost control

- Budget caps apply at root run and child run levels.
- Factory policy caps child count, retry count, and parallelism.
- Budget exhaustion pauses with a clear request for approval or scope reduction.

### Observability

- Trace attributes must include run id, root run id, phase, specialist, repo, PR number, check kind, and cost.
- Dashboards should show active runs, failed phases, stuck phases, cost by repo, and fix-loop rates.
- Operator alerts should fire on stuck queues, sandbox leak rate, workflow start failures, and CI watch timeouts.

### Security

- Sandboxes never receive broad long-lived production credentials.
- Tool connections are scoped and audited.
- Artifacts are redacted before storage and display.
- Human approval is mandatory for policy-defined risky actions.

## Analytics

Track at minimum:

- factory run created
- phase started/completed/failed
- plan approved/rejected/clarified
- patch bundle produced/applied/rejected/conflicted
- check attempt started/completed
- fix loop started/completed/exhausted
- PR opened/updated/ready/merged/closed
- CI watch started/passed/failed/timed out
- approval requested/approved/rejected
- run recovered/cancelled/failed

Primary dashboard metrics:

- autonomy rate
- draft PR rate
- merge-ready rate
- median time to draft PR
- median time to merge-ready
- median cost per draft PR
- median fix loops per PR
- human gates per PR
- top failure reasons

## Launch scope

### MVP

- Linear intake only.
- Single repo per run.
- Factory controller with visible phases.
- Structured plan artifact.
- Patch bundles for writing specialists.
- Root integration workspace.
- Canonical local check runner.
- Draft PR creation and update.
- GitHub CI watch with one bounded fix loop.
- Human approval before ready-for-review.
- Basic admin policy: enabled repos, budgets, retry caps, required checks.

MVP success: a well-scoped Linear ticket can become a draft PR with integrated code changes, passing local checks, a verification bundle, and a Linear comment linking to the PR, without the user opening the Nigel chat UI.

### Phase 2

- Review-comment auto-addressing.
- Visual proof galleries.
- Local-stack snapshot acceleration.
- More robust CI failure classification.
- Specialist override UI.
- Stale-run intervention queue.

### Phase 3

- Auto-ready-for-review by policy.
- Auto-merge by policy.
- Parallel patch production and integration at scale.
- Infra/Pulumi preview workflows with approval gates.
- Eval harness and learning reports.

## Open questions

1. Should factory phase state live on `agent_runs`, a new `factory_runs` table, or an append-only phase-events table with a materialized current phase?
2. Should patch bundles use raw diffs, temporary branch refs, or both at launch?
3. Should MVP require human approval before opening the draft PR, before marking ready-for-review, or both?
4. Which GitHub feedback sources are in v1: required checks only, human reviews, CodeRabbit/Cursor comments, or all check annotations?
5. Should Linear issue status move automatically, or should Nigel only comment and assign/delegate?
6. What proof is required for backend-only changes beyond passing checks and reviewer report?
7. Should auto-merge be in Phase 2 or Phase 3 if branch protection and repo policy are already satisfied?

## Launch criteria

1. 20 fixture tickets run through the MVP factory with at least 70% reaching draft PR without human intervention.
2. Every factory PR includes ticket link, run link, verification bundle, and patch provenance.
3. No interrupted workflow creates duplicate active PRs for the same factory run.
4. Every failed run has a Linear-visible reason and a run-visible artifact trail.
5. Factory PR creation is opt-in per repo and can be disabled immediately by an admin.

