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
  model: "anthropic/claude-sonnet-4-6",
  toolAllowlist: ["file", "search", "shell", "git"],
  sandboxPolicy: "inherit",
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
});

export function getPresetNames(): readonly string[] {
  return Object.keys(PRESETS);
}
