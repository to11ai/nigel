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

// Map of preset name → preset definition. Names must be unique. The
// resolver validates that no DB `override` row references a name absent
// from this map.
export const PRESETS: Readonly<Record<string, CodePreset>> = Object.freeze({
  [echoPreset.name]: echoPreset,
});

export function getPresetNames(): readonly string[] {
  return Object.keys(PRESETS);
}
