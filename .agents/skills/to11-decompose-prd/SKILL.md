---
name: to11-decompose-prd
description: "Decompose an approved to11 PRD into a Linear epic and child sub-issues. Use after a PRD in docs/prds/ has been moved to Status: Approved and before any per-ticket spec work starts. Reads the PRD's rough slice list, drafts one Linear sub-issue per slice with acceptance criteria and dependencies, presents the drafted ticket list for human approval, creates the Linear epic and children via the Linear MCP, appends a ## Tickets table back to the PRD, and commits the PRD update. Single-owner skill; does not write specs, plans, or implementation."
---

# to11 Decompose

Turn an approved to11 PRD into an executable Linear epic + sub-issue tree. Bridges the PRD layer and the per-ticket `$to11-ship` flow.

This skill is invoked **once per PRD** after `Status: Approved`. Re-running on the same PRD after slice edits enters delta-decomposition mode (adds new slices to the existing epic; never creates a duplicate epic).

## Hard Rules

- Initial decomposition (no `## Tickets` table in the PRD) requires `Status: Approved`. Re-decomposition (PRD already has a `## Tickets` table) accepts `Status: Approved` or `Status: In flight`. Halt on any other status — including `Draft for review`, `Shipped`, `Superseded`, or `Abandoned` — and ask the owner to fix status manually first. The skill does NOT mutate the `Status:` field; that is the owner's manual action per `docs/prds/index.md`.
- The PRD must have a `## Slice List` section with ≥1 slice. If missing or empty, halt.
- The Linear MCP must be available and authenticated. If unavailable, halt and report the auth blocker. Do not write partial state.
- Create exactly **one epic per PRD**. On re-invocation, detect the existing epic from the PRD's `## Tickets` table and add new children to it. Never create a second epic for the same PRD.
- Never silently mutate existing Linear tickets. On re-decomposition, surface diffs (new slice / removed slice / edited slice) and ask the owner before writing changes.
- Work in a dedicated worktree under `./.worktrees/<name>`. The PRD update commit lives in that worktree. `make dev` is NOT required for decomposition work (PRD update is doc-only).
- Branch prefix uses the requester's initials per `$to11-ship` rules (Matt Calhoun → `mc/`; ask if unknown).
- Single owner per PRD. If the PRD has multiple owners, halt and ask which single name to use as the canonical owner before continuing.
- The drafted ticket list MUST be approved by the human before any Linear writes. Approval can be batch (all tickets at once) or per-ticket. Editing during approval (rename, merge, split, drop, reorder deps) is expected.
- The PRD `## Tickets` table always reflects exactly what is in Linear: the epic plus every successfully-created child. Failed slices are absent from the table (not represented as placeholder rows) and are picked up by re-decomposition on the next run. The table is always committed after step 5, even on partial failure, so the persisted epic ID prevents a second epic from being created on retry.
- In re-decomposition mode, the working set of slices to draft and create is restricted to slices NOT already present in the existing `## Tickets` table. Never re-create a slice that already has a Linear child. Splice new rows into the existing table — never duplicate rows.
- After Linear writes succeed, append (or splice) the `## Tickets` table in the PRD and commit the PRD update in the same worktree. Commit subject: `docs(prds): decompose <topic> into tickets` (initial) or `docs(prds): re-decompose <topic> — N new tickets` (delta).

## Tool Compatibility

- Claude Code: invoke via slash command or direct call. Uses `mcp__claude_ai_Linear__*` tools for epic + sub-issue creation, parent setting, and relation (dependency) setting.
- Codex: follow the same Linear MCP contracts. If the MCP is not wired, halt and report — do not fall back to manual Linear creation via web UI from the skill (the owner can do that out-of-band but the skill stops).
- Other agents: the skill assumes Linear MCP availability. Without it, the skill cannot complete.

## Memory Anchors

- `feedback_pr_title_linear` — Linear IDs are first-class; child ticket IDs returned by this skill flow downstream to PR titles via `$to11-ship`.
- `feedback_plan_location` — PRDs in `docs/prds/`, specs in `docs/product-specs/`, plans in `docs/exec-plans/active/`. The PRD update this skill produces never leaves `docs/prds/`.
- `feedback_no_sql_in_design_discussion` — PRD content stays conceptual; this skill does not extract or generate schema/API detail for tickets.

## Workflow

### 1. Preflight

- Confirm the PRD path argument exists and resolves under `docs/prds/`.
- Read the PRD front matter and body. Extract: title (strip `PRD:` prefix), summary, vocabulary, goals, non-goals, user stories, requirements, slice list, risks. Detect mode by checking for an existing `## Tickets` section.
  - **Absent** → initial decomposition mode. Require `Status: Approved`. If not, halt with the explicit message: "PRD status is `<actual>`. Owner must edit to `Approved` after reviewer sign-off before initial decomposition. See `docs/prds/index.md` lifecycle states."
  - **Present** → re-decomposition mode. Require `Status: Approved` or `Status: In flight`. If status is anything else, halt with: "PRD status is `<actual>`. Re-decomposition requires `Approved` or `In flight`. Owner must fix status manually first." Extract the existing epic ID from the table. Verify the epic still exists in Linear (`mcp__claude_ai_Linear__get_issue`). If the epic is missing or archived, halt and ask the owner to restore or manually recreate the epic + update the PRD table out-of-band before re-running.
- Confirm Linear MCP authentication (`mcp__claude_ai_Linear__list_teams` or equivalent lightweight call). If auth fails, halt.
- Confirm a Linear team ID/slug from the invocation args or prompt the owner.

### 2. Draft tickets

- **Compute the working slice set:**
  - **Initial decomposition mode:** working set = every entry in `## Slice List`.
  - **Re-decomposition mode:** working set = entries in `## Slice List` whose slice number (S<n>) is NOT already present in the existing `## Tickets` table. Never re-draft or re-create a slice that already has a Linear child. For slices present in `## Tickets` but absent from `## Slice List` (removed), surface to owner per the failure-mode rules; do not auto-close or auto-create. For slices present in both but with edited text (description changed), do NOT re-create — surface as a diff for owner decision: leave existing Linear ticket as-is, or update the Linear ticket title/AC out-of-band (the skill does not mutate existing Linear tickets).
- For each slice S<n> in the working set:
  - **Title:** verb-led summary derived from the slice text.
  - **Description:**
    - First line: link to the PRD file (relative repo path).
    - Second line: `Slice: S<n>` for traceability.
    - Section `### Acceptance Criteria`: 3–8 bullets, each testable. Derive from the slice's intent plus relevant PRD requirements. Do NOT invent requirements not implied by the PRD.
    - Section `### Dependencies`: list `TO11-XXX (slice S<m>)` for any slice this one explicitly builds on. Default inference: each slice depends on the slice immediately preceding it ONLY if the slice text implies sequencing; otherwise leave empty.
    - Section `### Out of Scope`: cross-link to sibling slices that cover excluded pieces.
  - **Label:** `from-prd:<topic-slug>` and `slice:S<n>` (where `<topic-slug>` is derived from the PRD filename, e.g., `routing-rules`).
- Cap drafted AC at 8 bullets per ticket. If a slice would require more, surface to owner: "Slice S<n> drafted to N AC bullets. Split this slice into S<n>a + S<n>b before continuing?"
- Surface micro-slices for owner review: "Slice S<n> has <3 AC bullets. Merge with sibling S<m>?"
- Before proceeding to step 3, explicitly surface any re-decomposition anomalies and wait for owner acknowledgment:
  - **Removed slices** (in `## Tickets` but absent from `## Slice List`): "Slice S<n> (TO11-XXXX) is in `## Tickets` but no longer in `## Slice List`. If intentional, close TO11-XXXX in Linear manually before continuing. If unintentional, restore the slice to the PRD and re-run."
  - **Edited slices** (in both but description changed): "Slice S<n> (TO11-XXXX) description has changed since initial decomposition. The skill will NOT mutate the existing Linear ticket. Owner action: (a) leave Linear ticket as-is, or (b) manually update TO11-XXXX title/description in Linear out-of-band to match the new slice text. Either choice is fine; just acknowledge to continue."
- Do not proceed to step 3 until the owner has acknowledged each surfaced anomaly (or there are none).

### 3. Owner approval gate

- Render the full drafted ticket list as a Markdown preview: table summary plus expanded per-ticket detail.
- Ask the owner: approve batch, approve per-ticket, or edit. Accept edits including rename, merge two slices, split one slice, drop, reorder dependencies. Re-render after edits and re-ask.
- Do not proceed to Linear writes until the owner explicitly approves.

### 4. Create Linear epic

- (Skip if re-decomposition mode and the existing epic was confirmed in Preflight.)
- Call `mcp__claude_ai_Linear__save_issue`:
  - `title`: PRD title (stripped of `PRD:` prefix).
  - `description`: PRD summary + link to the PRD file in the repo.
  - `teamId`: from args/owner.
  - `labelIds`: `from-prd:<topic-slug>`, `type:epic`.
- Capture the returned epic ID (e.g., TO11-1233).

### 5. Create child sub-issues

- For each approved drafted ticket (in slice order):
  - Call `mcp__claude_ai_Linear__save_issue`:
    - `title`, `description` from draft.
    - `parentId`: epic ID from step 4 (or existing epic on re-decomposition).
    - `teamId`: same as epic.
    - `labelIds`: `from-prd:<topic-slug>`, `slice:S<n>`.
  - On success, capture the returned child ID.
  - On failure, record the slice number + error and continue with remaining children. Do NOT halt the loop — accumulate all results so the owner sees the full picture.
- After all children are attempted, set inter-ticket dependencies for **successfully created** children only. Dependency relations require both ticket IDs to exist; skip any dependency where one side failed and surface the skip in the report.
- Proceed to step 6 regardless of partial failures. The PRD `## Tickets` table is always written with the epic + only the children that actually succeeded — no fictional rows for failed slices. After committing, halt and report failures so the owner can re-run. The persisted table preserves the epic ID and the successful children, which makes the re-run detect re-decomposition mode and retry only the missing slices. This is what prevents a second epic from being created on retry.

### 6. Append `## Tickets` table to PRD

- Always runs after step 5, even if some children failed. The table reflects exactly what is in Linear: epic + every successfully-created child. Failed slices are absent from the table and will be picked up by re-decomposition on the next run.
- Compose the Markdown table:

```markdown
## Tickets

**Epic:** [TO11-1233] <Epic Title>

| Slice | Linear | Title | Depends on |
|---|---|---|---|
| S1 | TO11-1234 | <title> | — |
| S2 | TO11-1235 | <title> | TO11-1234 |
```

- On re-decomposition, splice new rows into the existing table. Never duplicate existing rows. Never remove existing rows unless the owner explicitly approved a removal in step 3 AND the corresponding Linear ticket has been closed/archived out-of-band.
- Write the updated PRD file. Stage and commit:
  - Subject (all successful): `docs(prds): decompose <topic> into tickets` (initial) or `docs(prds): re-decompose <topic> — N new tickets` (delta).
  - Subject (partial failure): `docs(prds): decompose <topic> — partial (N of M slices)`. Body lists the failed slices + errors so the owner has a record alongside the runtime report.

### 7. Report

- Print summary: epic ID + URL, count of child tickets, child IDs + titles, any deferred relations or owner action items.
- Next step: per Linear ticket, owner enters `$to11-ship` with the ticket ID. The spec produced under each ticket must include `**Linear:**`, `**PRD:**`, and `**Slice:**` front matter per `docs/how-to/development-workflow.md`.

## Failure Modes

| Failure | Behavior |
|---|---|
| PRD status does not match the mode (initial requires `Approved`; re-decomposition requires `Approved` or `In flight`) | Halt before any Linear writes. Clear message naming the actual and required statuses. |
| Slice list missing or empty | Halt. Ask owner to add slices and re-run. |
| Linear MCP auth fails | Halt. Report missing auth. Do not write partial state. |
| Linear team ID not provided and not inferable | Prompt owner. Do not guess. |
| Epic creation succeeds, child creation fails partway | Continue creating remaining children (do not halt the loop). Skip dependencies that reference a failed child. After all attempts, commit the PRD `## Tickets` table with the epic + only the successfully-created children — failed slices are absent. Then halt and report all successes and failures. Owner re-runs in re-decomposition mode (the persisted table makes this automatic), which retries only the missing slices under the same epic. No second epic is created. |
| Re-decomposition: existing epic missing from Linear | Halt. Two recovery paths: (a) restore the epic in Linear and re-run as-is, or (b) delete the entire `## Tickets` section from the PRD, leave `Status: Approved` (or move back to `Approved` if currently `In flight`), and re-run — the skill enters initial mode and creates a fresh epic + all children. Both paths preserve the one-epic-per-PRD invariant because (a) reuses the old epic and (b) starts over from a clean slate with no stale references. The skill itself never creates a second epic in a single run. |
| Slice ambiguous (multiple plausible interpretations) | Surface to owner. Do not guess. |
| Slice would generate >8 AC bullets | Surface: "Split S<n> into S<n>a/S<n>b?" |
| Slice would generate <3 AC bullets | Surface: "Merge S<n> with sibling?" |
| PRD references vocabulary terms not defined in its `## Vocabulary` section | Warn but proceed. The PRD review should have caught this; the skill is not the gate. |
| Owner rejects drafted list with no actionable edits | Halt. Ask owner to specify edits or to abort. |
| Worktree not present | Halt. Ask owner to create one and re-run. |

## What This Skill Does NOT Do

- Does NOT write product specs (those live in `docs/product-specs/`; `$to11-ship` produces them per ticket).
- Does NOT write execution plans (`superpowers:writing-plans` does, downstream).
- Does NOT trigger implementation.
- Does NOT estimate (no story points, no time estimates).
- Does NOT assign owners to child tickets (Linear team defaults apply).
- Does NOT split or merge existing Linear tickets (a separate skill would, if ever needed).
- Does NOT mutate the PRD `Status:` field. Owner does this manually.
- Does NOT close Linear tickets when a PRD is moved to `Shipped` or `Abandoned`. Owner does this in Linear.

## Canonical Prompt

```text
Use $to11-decompose-prd.

PRD
- <path under docs/prds/, e.g. docs/prds/2026-05-19-routing-rules-prd.md>

Linear team
- <team ID or slug, e.g. TO11>

Notes
- <optional: initial epic title override, parent epic if PRD nests under a larger initiative, label override>
```
