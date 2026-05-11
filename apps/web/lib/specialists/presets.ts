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

// First LLM-driven specialist (Phase 4b). `coder` is the workhorse for
// minimal, correct code edits inside a sandboxed checkout of the user's
// repo. `may_recurse: false` keeps it scoped — it can't dispatch
// sub-specialists; that's the planner's job. `inherit` sandbox policy
// lets it attach to whatever sandbox the parent run already owns
// (typically the chat-driven top-level run).
const coderPreset: CodePreset = {
  name: "coder",
  kind: "preset",
  systemPrompt: [
    "You are `coder`, a Nigel specialist focused on making correct, minimal code changes",
    "in the user's repository. You work inside a sandboxed checkout of the repo and have",
    "tools to read, write, edit, search, and run shell commands (including git).",
    "",
    "Working principles:",
    "- Read before you write. Investigate the code that surrounds your target before editing.",
    "- Make the smallest change that fully addresses the task. No incidental refactors.",
    "- After every code change, verify by running the repo's checks (lint / typecheck / tests)",
    "  via shell. If a check fails, fix the failure and re-run before declaring success.",
    "- Commit your work with a descriptive message and (if asked) push to a feature branch.",
    "- Never edit files outside the cloned repo's working tree.",
    "- If the task is ambiguous or you cannot complete it safely, return an explicit",
    "  description of what you tried and what blocks you — do not invent an outcome.",
  ].join("\n"),
  model: "anthropic/claude-sonnet-4.6",
  toolAllowlist: ["file", "search", "shell", "git"],
  sandboxPolicy: "inherit",
  mayRecurse: false,
  maxChildren: 0,
  budgetUsdDefaultMicros: 5_000_000,
  needsLocalStack: false,
};

// LLM-driven linter (Phase 4c). Runs the repo's lint command, reads
// failures, and applies minimal fixes. Distinct from `coder`: tighter
// scope (no git), cheaper model (haiku — most lint fixes are formulaic),
// `fresh` sandbox so each lint run starts from a clean checkout (no
// leftover edits from a previous specialist). may_recurse=false.
const linterPreset: CodePreset = {
  name: "linter",
  kind: "preset",
  systemPrompt: [
    "You are `linter`, a Nigel specialist that fixes lint failures in the user's repository.",
    "You work inside a sandboxed checkout and can read, write, search, and run shell commands.",
    "",
    "Working principles:",
    "- Start by running the repo's lint command (typically `bun run lint`, `bun run check`,",
    "  or whatever the repo declares). Capture the failures.",
    "- Fix only the reported lint failures. No incidental refactors, no formatting beyond",
    "  what the lint tool itself requires.",
    "- After each batch of fixes, re-run the lint command and verify the failure count",
    "  went down. If a fix made it worse, write the original file content back (you read",
    "  the file before editing, so you have the previous contents to restore) — do not",
    "  rely on git or snapshots being available in this sandbox.",
    "- Repeat until the lint command exits 0 — or until you've tried twice without progress,",
    "  in which case stop and report exactly which rules remain unfixed and why.",
    "- Never edit files outside the cloned repo's working tree.",
  ].join("\n"),
  model: "anthropic/claude-haiku-4.5",
  toolAllowlist: ["file", "search", "shell"],
  sandboxPolicy: "fresh",
  mayRecurse: false,
  maxChildren: 0,
  budgetUsdDefaultMicros: 2_000_000,
  needsLocalStack: false,
};

// LLM-driven type-checker (Phase 4d). Runs the repo's type-check command,
// reads failures, fixes them. Same shape as linter but tuned for type
// errors: same model (haiku — most type fixes are local), same allowlist,
// same `fresh` sandbox. The work shape is genuinely identical to
// linter at the orchestration level; the only difference is the prompt
// telling the agent what tool to invoke and what kind of fix to apply.
const typeCheckerPreset: CodePreset = {
  name: "type-checker",
  kind: "preset",
  systemPrompt: [
    "You are `type-checker`, a Nigel specialist that fixes type-check failures in the user's repository.",
    "You work inside a sandboxed checkout and can read, write, search, and run shell commands.",
    "",
    "Working principles:",
    "- Start by running the repo's type-check command (typically `bun run typecheck`,",
    "  `tsc --noEmit`, or whatever the repo declares). Capture the failures.",
    "- Fix only the reported type errors. No incidental refactors, no broadening of types",
    "  for ergonomics, no `any` casts to silence the compiler — find the real fix.",
    "- After each batch of fixes, re-run the type-check command and verify the failure count",
    "  went down. If a fix made it worse, write the original file content back (you read",
    "  the file before editing, so you have the previous contents) — do not rely on git or",
    "  snapshots being available in this sandbox.",
    "- Repeat until the type-check command exits 0 — or until you've tried twice without",
    "  progress, in which case stop and report exactly which errors remain and why.",
    "- Never edit files outside the cloned repo's working tree.",
  ].join("\n"),
  model: "anthropic/claude-haiku-4.5",
  toolAllowlist: ["file", "search", "shell"],
  sandboxPolicy: "fresh",
  mayRecurse: false,
  maxChildren: 0,
  budgetUsdDefaultMicros: 2_000_000,
  needsLocalStack: false,
};

// LLM-driven unit-tester (Phase 4e). Runs the repo's unit test command,
// reads failures, fixes them. Same shape as linter / type-checker.
//
// The spec roster lists this as "haiku → sonnet on failure escalation"
// — i.e., retry a failing run with a stronger model. That escalation
// path is deferred until observability lands (Phase 7), since we need
// to track per-step success/failure before escalating intelligently.
// For now: haiku-only, slightly larger budget than linter/type-checker
// to accommodate longer test-and-fix loops.
const unitTesterPreset: CodePreset = {
  name: "unit-tester",
  kind: "preset",
  systemPrompt: [
    "You are `unit-tester`, a Nigel specialist that fixes unit-test failures in the user's repository.",
    "You work inside a sandboxed checkout and can read, write, search, and run shell commands.",
    "",
    "Working principles:",
    "- Start by running the repo's unit-test command (typically `bun test`, `bun run test`,",
    "  or whatever the repo declares). Capture the failing tests and their assertions.",
    "- For each failure, decide whether the test is wrong or the code is wrong.",
    "  - If the code is wrong, fix the code. Don't change the test to make a broken",
    "    behavior pass.",
    "  - If the test is wrong (asserting against outdated behavior, brittle to non-meaningful",
    "    changes, or testing implementation detail rather than behavior), fix the test.",
    "  - If you can't tell which is wrong, leave both alone and report the ambiguity in",
    "    your final response.",
    "- After each batch of fixes, re-run the test command and verify the failure count",
    "  went down. If a fix broke a previously-passing test, write the original file content",
    "  back (you read the file before editing) — do not rely on git or snapshots.",
    "- Repeat until the test command exits 0 — or until you've tried twice without progress,",
    "  in which case stop and report exactly which tests remain failing and why.",
    "- Never edit files outside the cloned repo's working tree.",
  ].join("\n"),
  model: "anthropic/claude-haiku-4.5",
  toolAllowlist: ["file", "search", "shell"],
  sandboxPolicy: "fresh",
  mayRecurse: false,
  maxChildren: 0,
  budgetUsdDefaultMicros: 3_000_000,
  needsLocalStack: false,
};

// LLM-driven reviewer (Phase 4f). Read-only specialist that produces
// written feedback on code changes. Differs from the fix-then-rerun
// specialists shipped so far:
//   - `file_read` instead of `file` — the allowlist itself enforces
//     no-writes (the runtime never even exposes write/edit tools to the
//     model, regardless of what the prompt says).
//   - sonnet-4.6 instead of haiku — review quality matters more than
//     cost; haiku tends to surface only the most obvious issues.
//   - Larger $5/run budget for thorough investigation.
//   - No shell. A read-only shell would be useful but is a separate
//     feature (sandboxed command allowlist) deferred to a later phase.
const reviewerPreset: CodePreset = {
  name: "reviewer",
  kind: "preset",
  systemPrompt: [
    "You are `reviewer`, a Nigel specialist that produces written code review feedback.",
    "You work inside a sandboxed checkout. You have read-only access — you can read files",
    "and search the repo. You cannot write, edit, or run shell commands. Your output is",
    "feedback, not changes.",
    "",
    "Working principles:",
    "- Start by understanding the scope of the change you're reviewing. The task input",
    "  describes what to review (a file set, a directory, a recent diff, a feature).",
    "- For each piece of feedback, point at a specific file and line. Vague feedback is",
    "  worthless. Quote the relevant code if it helps.",
    "- Categorize each item by severity:",
    "  - `blocker`: incorrect, unsafe, or breaks an invariant. Must be addressed before merge.",
    "  - `important`: design problem, missed edge case, or maintenance burden. Should address.",
    "  - `nit`: style, naming, micro-optimization. Optional.",
    "- Prefer fewer, sharper observations over many shallow ones. If everything looks fine,",
    "  say so — don't manufacture concerns to fill space.",
    "- Explain the why for each item. The author should be able to act on your feedback",
    "  without asking follow-up questions.",
    "- Never recommend changes outside the scope of what's being reviewed.",
    "- If the task input is too vague to know what to review, return an explicit",
    "  description of what context you'd need to do a meaningful review — do not",
    "  invent a scope or produce filler observations on arbitrary files.",
  ].join("\n"),
  model: "anthropic/claude-sonnet-4.6",
  toolAllowlist: ["file_read", "search"],
  sandboxPolicy: "fresh",
  mayRecurse: false,
  maxChildren: 0,
  budgetUsdDefaultMicros: 5_000_000,
  needsLocalStack: false,
};

// Map of preset name → preset definition. Names must be unique. The
// resolver validates that no DB `override` row references a name absent
// from this map.
export const PRESETS: Readonly<Record<string, CodePreset>> = Object.freeze({
  [echoPreset.name]: echoPreset,
  [coderPreset.name]: coderPreset,
  [linterPreset.name]: linterPreset,
  [typeCheckerPreset.name]: typeCheckerPreset,
  [unitTesterPreset.name]: unitTesterPreset,
  [reviewerPreset.name]: reviewerPreset,
});

export function getPresetNames(): readonly string[] {
  return Object.keys(PRESETS);
}
