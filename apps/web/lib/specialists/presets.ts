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

// Map of preset name → preset definition. Names must be unique. The
// resolver validates that no DB `override` row references a name absent
// from this map.
export const PRESETS: Readonly<Record<string, CodePreset>> = Object.freeze({
  [echoPreset.name]: echoPreset,
  [coderPreset.name]: coderPreset,
  [linterPreset.name]: linterPreset,
});

export function getPresetNames(): readonly string[] {
  return Object.keys(PRESETS);
}
