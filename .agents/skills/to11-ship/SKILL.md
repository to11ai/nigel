---
name: to11-ship
description: "Canonical end-to-end development process for to11ai/nigel — for both bug and feature work. Covers intake through merged PR: classify, create/reuse a dedicated worktree, run the shared worktree setup hook, start the local stack with make dev, brainstorm + write a human-approved product spec (features) or reproduce + identify root cause (bugs), decompose into plans, implement (subagent-driven for features), run adversarial-validation in a separate subagent, run clean-pr before push, publish PR proof with verify-pr-proof gating, and babysit the PR until terminal."
---

# to11 Ship

Canonical end-to-end development process for `to11ai/nigel`. Covers bug and feature work from intake through merged PR. Classify upfront, then follow the shared spine with the bug or feature middle.

## Hard Rules

### Shared

- Work in a dedicated git worktree under `./.worktrees/<name>` in the source checkout. Never work in the source checkout or a shared session worktree.
- Branch prefix uses the requester's initials when determinable. For Matt Calhoun, use `mc/`. If the requester cannot be determined, ask for initials before creating the branch.
- After creating the worktree, run `.agents/hooks/worktree-setup.sh <source-root> <worktree-root>`.
- Start the canonical local stack in the worktree before implementation/testing with `make dev` via a TTY-backed shell. Non-PTY execs fail silently for terminal-dependent processes; in slash interfaces use `! make dev`, in subshells wrap with `script -q /dev/null make dev` or equivalent. See `feedback_tty_shell_for_hooks`.
- **Absolute paths only.** Every Bash command in Implement/Validate/Publish phases must target the worktree by absolute path (`/.worktrees/<branch>/...`) or be prefixed with `cd .worktrees/<branch> && ...`. Never rely on cwd — shell cwd silently drifts back to main between commands and pulumi/bun/make calls then miss config. See `feedback_pulumi_config_set_worktree`.
- **Check for existing PR work before starting.** During Preflight, run `git log --oneline origin/main -50 | grep -i <ticket-id>` AND `gh pr list --search '<ticket-id>' --state all`. If a merged PR exists, stop and report Done. If an open PR exists, stop and ask which workstream is canonical. See `feedback_check_existing_pr_before_work`.
- Local web E2E (`make e2e`) must pass locally before push. `$clean-pr` enforces this by default. Do not run platform/OTel E2E (`make test-e2e`) locally unless the user explicitly requests it or the work directly targets that path. Do not run `make e2e` manually — `$clean-pr` owns the stack swap. See `feedback_no_manual_make_e2e`.
- Before invoking `$clean-pr`, stop the background `make dev` stack with `make dev-down` and confirm `.worktree/runtime.json` is gone. `$clean-pr` owns the stack lifecycle for E2E; leaving `make dev` running causes port-allocation collisions and wasted retries.
- Do not push until `$clean-pr` passes locally.
- Rebase before opening PR. Run `git fetch origin && git rebase origin/main` and resolve conflicts before `gh pr create`. Never push a PR on a branch behind main. See `feedback_rebase_before_pr`.
- PRs are created or converted to ready-for-review before completion unless the user explicitly asks for a draft or an unresolved blocker requires draft status. Draft PRs do not trigger the full managed review path; if a PR remains draft, report it as unfinished/blocking rather than done.
- PR title format is `<conventional-commit-style title> [TO11-XXX]` when a Linear ticket is in context. See `feedback_pr_title_linear`.
- All web UI must be implemented with Tailwind CSS and shadcn/ui components. Raw CSS, CSS modules, styled-components, and inline styles are not permitted. If an existing file uses raw CSS, migrate it as part of the change — do not add to it. See `feedback_use_tailwind_not_css_modules`.
- If web UI changed, screenshots stay local under `.worktree/artifacts/**` and must be attached or embedded in a GitHub-rendered PR proof comment. Broken images, private raw URLs that do not render, local paths, checked-in filenames, and PR-body-only references do not satisfy this gate. Do not commit screenshot artifacts unless they are intentional visual-test baselines.
- GitHub issue/PR comment APIs publish Markdown text only; they do not upload local screenshot files. For UI proof, upload images to the `to11-pr-proof` Vercel Blob store with `bun run proof:screenshot-upload -- --pr <number>` (requires `BLOB_READ_WRITE_TOKEN`), then pipe the emitted `--screenshot <local-path>=<public-url>` flags into `bun run publish-pr-proof`. Do not try `raw.githubusercontent.com`, private release assets, gists, temporary file hosts, or a sidecar proof-assets branch as iterative fallbacks.
- `$adversarial-validation` MUST run in a separate Task/subagent with a clean context. Before invoking `$clean-pr`, record the validation subagent's task ID/result link in the working notes so independence is verifiable. Validation in the main implementation session is forbidden — a polluted context defeats the independence guarantee.
- `verify-pr-proof` must pass for the current PR head SHA before `$babysit-pr` is invoked. If verify fails, fix the upload step and re-verify; never start babysit while proof verification is failing.
- Hand off to `$babysit-pr` for post-publish monitoring. Do not poll CI/Pulumi yourself. If running babysit inline, wait 60–90s between status checks. See `feedback_polling_cadence`.
- The workflow is not complete until `$babysit-pr` reaches a terminal state (PR merged, closed, or explicitly handed off with a named blocker). Completing a phase is not completing the workflow. Do not stop or report completion between phases.

### Bug-only

- Reproduce the bug locally or inspect concrete evidence before changing code.
- Identify root cause before implementing the fix.

### Feature-only

- Stop after the product spec is written or updated. Do not plan or implement until the human approves the spec.
- After spec approval, treat the approved spec as the source of truth. If implementation, tests, or review feedback reveal a spec/implementation mismatch, make the implementation match the spec or ask the human to approve a spec change before editing the spec to match the implementation.
- Specs live in `docs/product-specs/`; plans live in `docs/exec-plans/active/`. Never `docs/superpowers/`. See `feedback_plan_location`.

## Tool Compatibility

- Claude Code: invoke this workflow either via `/ralph-loop Use $to11-ship. <bug|feature>: <description> --completion-promise "WORKFLOW COMPLETE"` or via `/goal Complete the full to11-ship for <description> — do not stop until babysit-pr reaches a terminal state.` The ralph-loop variant re-feeds the prompt on every exit attempt and only releases when you output the exact completion promise; the goal variant pins a persistent goal that survives between phases. Either prevents premature stopping. Use slash commands/Superpowers skills when available, and rely on the Claude WorktreeCreate hook when it is the active worktree path. Still verify `.worktree/runtime.json` after `make dev`.
- Codex: set a persistent goal at the start with `/goal Complete the full to11-ship for <description> — do not stop until babysit-pr reaches a terminal state.` Follow this workflow directly when slash commands or Superpowers skills are unavailable. Invocation of `$to11-ship` is explicit authorization to create subagents for required independent validation and bounded parallel workstreams. Prefer agent teams (TeamCreate) for 2+ independent streams; use standalone subagents for adversarial validation, focused research, or narrow implementation tasks.
- Other agents: run the checked-in commands and follow this skill's evidence and stop conditions instead of assuming tool-specific integrations.

## Memory Anchors

These feedback memories drove specific rules in this workflow. Read them when in doubt:

- `feedback_check_existing_pr_before_work` — duplicate-ticket grep
- `feedback_pulumi_config_set_worktree` — worktree cwd drift
- `feedback_no_manual_make_e2e` — `$clean-pr` owns the stack swap
- `feedback_tty_shell_for_hooks` — PTY required for `make dev` and hooks
- `feedback_rebase_before_pr` — rebase before `gh pr create`
- `feedback_pr_title_linear` — `[TO11-XXX]` suffix
- `feedback_polling_cadence` — 60–90s between status checks
- `feedback_screenshot_proactive` — UI changes need rendered proof in PR comment
- `feedback_plan_location` — specs/plans paths
- `feedback_use_tailwind_not_css_modules` — Tailwind/shadcn only for web UI
- `feedback_no_direct_pr_merge` — use `$babysit-pr` to land merges

## Workflow

### 1. Preflight

- **Loop check.** Confirm this workflow was invoked via `/ralph-loop` or `/goal` (Claude Code supports both; Codex uses `/goal`). If it was not, stop immediately and tell the user:
  > This workflow must be started with `/ralph-loop Use $to11-ship. <bug|feature>: <description> --completion-promise "WORKFLOW COMPLETE"` or `/goal Complete the full to11-ship for <description> — do not stop until babysit-pr reaches a terminal state` to prevent premature stopping between phases. Reply **skip** to proceed without the loop guarantee, or rerun with the proper command.

  If the user replies **skip**, continue — but note in your first response that completion guarantees are reduced.
- Read root `AGENTS.md` and any affected service-level `AGENTS.md`.
- Read the local harness contract at `docs/references/harness.md`.
- **Duplicate-ticket check.** If a Linear ticket ID is in scope, run `git log --oneline origin/main -50 | grep -i <ticket-id>` AND `gh pr list --search '<ticket-id>' --state all`. If a merged PR exists, stop and report Done. If an open PR exists, stop and ask which workstream is canonical.
- Create or reuse a dedicated worktree.
- Run the shared worktree setup hook.
- Confirm the hook materialized root `.env` with provider keys from the canonical secret store before running E2E checks: `set -a; . ./.env; set +a; test -n "${OPENAI_API_KEY:-}"`.
- Run `make dev` via a TTY-backed shell and confirm `.worktree/runtime.json` exists.
- Proceed immediately to Classify.

### 2. Classify

- Determine whether this work is a **bug** (existing user-facing behavior is broken; concrete repro or evidence) or a **feature** (new behavior, new contract, intentional change). If ambiguous, ask the user before continuing. If the work crosses both paths mid-flow (a "bug" that turns out to require architectural change, or a "feature" that resolves to a missing default), switch tracks explicitly — do not try to force one path to cover the other.
- Note the classification:
  - **Bug** → go to step 3a.
  - **Feature** → go to step 3b.

### 3a. Bug path

#### Reproduce And Diagnose

- Capture the user report, logs, failing test, PR comment, screenshot, or URL.
- Reproduce locally against the `make dev` stack when feasible.
- Trace the full failing path before patching.
- Create or update a spec only when the fix changes product behavior, API contracts, architecture, or durable workflow expectations.

#### Plan And Fix

- Write a concise fix plan before editing.
- If the user corrected a previous UI interpretation, restate the intended visual target in concrete layout terms before editing again, including what must remain visible from the design reference and what must not be changed.
- Implement the smallest correct fix.
- Add or update regression coverage when feasible.
- For UI bugs, capture browser evidence against the local stack.
- Run focused tests as work lands; final local E2E is owned by `$clean-pr`.
- Proceed to step 4 (Validate).

### 3b. Feature path

#### Brainstorm And Spec

- Use the Superpowers brainstorming workflow when available, or perform the equivalent structured brainstorming manually, to turn the feature seed into requirements, non-goals, constraints, risks, and acceptance criteria.
- If the feature includes web UI, extract all design tokens from the Claude Design handoff before writing the spec: colors (exact hex/variable names), spacing values, typography (size, weight, line-height, letter-spacing), border radii, and shadows. Record them explicitly in the spec. Link or embed the Claude Design export or reference screenshot directly in the spec so the implementation phase has an unambiguous reference.
- Write or update the product spec in `docs/product-specs/`.
- **Stop and ask for human approval of the spec.** This is the only legitimate stop point before Publish. After approval, proceed immediately to Plan.

#### Plan

- After spec approval, use Superpowers writing-plans/decomposition when available, or perform equivalent plan decomposition manually, to create one or more execution plans under `docs/exec-plans/active/`.
- Run `$plan-review` against each plan.
- Resolve plan blockers before implementation.

#### Implement

- Use Superpowers subagent-driven-development against the approved plan when available. Prefer agent teams (TeamCreate) for 2+ independent streams; use standalone subagents for focused research or narrow implementation tasks when a team is unavailable or unnecessary.
- Keep workstreams bounded and reconcile changes in the parent session.
- If the user corrected a previous UI interpretation, restate the intended visual target in concrete layout terms before editing again, including what must remain visible from the design reference and what must not be changed.
- Add tests and browser evidence required by the plan and risk tier.
- Run focused tests as work lands; final local E2E is owned by `$clean-pr`.
- Proceed to step 4 (Validate).

### 4. Validate

- **Stop the dev stack.** Run `make dev-down` and confirm `.worktree/runtime.json` is gone. `$clean-pr` owns the stack lifecycle for E2E; leaving `make dev` bound causes port-allocation failures.
- If web UI changed, run a full design-handoff review before anything else:
  1. Load the Claude Design export or spec reference screenshot alongside the implementation screenshot for each changed view.
  2. Check for inconsistencies in: spacing/padding, typography (size, weight, color, line-height), color values, component dimensions, alignment, border-radius, and shadows. Every discrepancy a designer would notice must be fixed — pixel-level accuracy is required for design-handoff features. Do not accept approximate matches.
  3. Verify every UI value maps to a Tailwind class or CSS variable. Flag and fix any hardcoded values, raw CSS rules, inline styles, or CSS module references introduced in this change.
  4. For features: capture screenshots at all required viewports for each changed view. Every viewport must match the design reference. Desktop: 1920×1080, 1440×900, 1280×800. Tablet & Mobile: 1024×768, 768×1024, 390×844.
  5. For pixel-perfect or design-handoff fixes, run `$clean-pr` with design-reference visual diff inputs and explicit allowed change prefixes so missing layout regions and unrelated harness/infra files block the gate.
- **Dispatch `$adversarial-validation` in a separate Task/subagent.** Record the subagent's task ID or result link in working notes. Validation must not run in the main implementation session — a polluted context defeats the independence guarantee. If you cannot spawn a subagent, stop and report this as a blocker.
- Run `$clean-pr` before push. It owns the local repair/proof loop and may iterate up to its configured attempt limit. clean-pr auto-classifies the PR by conventional-commit type: `feat(*)` requires `--task`, `--spec`, `--plan` and that the plan references the spec; `fix(*)` and others accept the existing `--allow-no-plan` diagnostic bypass. For genuine emergencies use `--emergency-no-spec --emergency-reason "<one-line justification>"` — the reason is written to the proof bundle and surfaces on the PR.
- Proceed immediately to Publish.

### 5. Publish

- **Rebase first.** Run `git fetch origin && git rebase origin/main`, resolve conflicts, re-run focused tests if main moved. Never push a PR on a branch behind main.
- Push only after clean-pr passes locally and the branch is rebased.
- Create or update the PR. Title format: `<conventional-commit-style title> [TO11-XXX]` when a Linear ID is in context. Use ready-for-review status by default after local gates pass; only use draft when the user asked for draft or a named blocker remains.
- For UI proof, upload each screenshot to the `to11-pr-proof` Vercel Blob store before publishing proof:
  1. Confirm `BLOB_READ_WRITE_TOKEN` is exported. If missing, stop and report missing Vercel Blob auth as the blocker; do not search for public hosting workarounds.
  2. Run `bun run proof:screenshot-upload -- --pr <number>`. The uploader auto-discovers image artifacts from the latest proof bundle, uploads them to `screenshots/pr-<number>/<relative-path>`, and emits one `--screenshot <local-path>=<public-url>` flag per upload on stdout. To target specific files instead, add `--image <path>` flags.
  3. Pipe the emitted flags directly into `bun run publish-pr-proof -- --pr <number> --proof <path-to-proof.json>`. The Vercel Blob URLs are public and idempotent — re-runs against the same PR overwrite the previous upload at the same pathname.
- Publish the complete proof inventory to the PR, including clean-pr proof, adversarial validation verdict + subagent task ID, checks, local reviewer status, reproduction/regression evidence (bug) or design-vs-impl side-by-side per required viewport (feature), and visible UI screenshots when applicable.
- **Verify-pr-proof gate.** Run `bun run verify-pr-proof -- --pr <number> --proof <path-to-proof.json>`. This must pass for the current PR head SHA. If it fails (missing/stale images, sticky comment without rendered Markdown image references), fix the upload step and re-verify. Do not proceed to babysit while verify is failing.
- Verify managed/cloud review agents (CodeRabbit, Cursor/Bugbot, etc.) have actually run or been triggered after the PR is ready-for-review. If any skipped because the PR was draft, mark the PR ready and re-trigger them before continuing.
- Hand off to `$babysit-pr` until GitHub CI/review/mergeability reaches a terminal state. Do not poll inline; if babysit cannot be invoked, wait 60–90s between manual status checks. Creating a PR, pushing proof, or triggering review bots is not a completion point.
- Only after babysit-pr reaches a terminal state, output: `WORKFLOW COMPLETE`

## Canonical Prompt

```text
Use $to11-ship.

Classification
- <bug | feature>

# For bugs
Bug
- <what is broken>

Evidence
- <URL, screenshot, logs, failing test, PR comment, user report>

Expected behavior
- <what should happen>

# For features
Feature seed
- <rough idea / desired outcome>

Context
- <optional Linear issue, user pain, links, screenshots, constraints>
```
