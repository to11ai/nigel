import type { ProviderOptionsByProvider } from "@nigel/agent";
import type { InferSelectModel } from "drizzle-orm";
import type { specialists } from "@/lib/db/schema";
import type { SandboxPolicy } from "@/lib/runs/types";

export type SpecialistKind = "preset" | "custom" | "override" | "scripted";

// A fully-resolved specialist as the dispatch path consumes it.
// Code presets and DB-resolved customs both produce this shape.
export type ResolvedSpecialist = {
  name: string;
  kind: SpecialistKind;
  systemPrompt: string | null;
  model: string | null;
  // Per-specialist provider options merged on top of model defaults.
  // Used to set reasoningEffort (and similar knobs) without leaking
  // the choice into the model id string.
  providerOptions?: ProviderOptionsByProvider;
  toolAllowlist: readonly string[];
  sandboxPolicy: SandboxPolicy;
  mayRecurse: boolean;
  maxChildren: number;
  budgetUsdDefaultMicros: number;
  needsLocalStack: boolean;
  // When set, dispatch.ts refuses to dispatch any specialist not on
  // this list — even if the parent has `dispatch_specialist` in its
  // tool allowlist and `mayRecurse: true`. Used to scope a recursive
  // specialist to a safe subset of targets (e.g. `researcher` can
  // only dispatch other `researcher`s, never code-touching roles).
  //
  // When unset, no target restriction applies. That's the right
  // default for the `planner` (which is meant to dispatch any
  // specialist) and for top-level chat dispatches.
  //
  // Necessary as a runtime gate, not just a prompt-level one,
  // because the dispatching specialist may run with prompt-injected
  // input — `researcher` fetches arbitrary web pages, and a
  // malicious page could otherwise instruct it to dispatch a
  // write-capable specialist.
  dispatchTargetAllowlist?: readonly string[];
  // Only populated for kind='scripted' (Phase 2 supports just this case).
  // Returns the specialist's output as a string; throws on failure.
  script?: (task: string) => Promise<string>;
};

// A preset as defined in lib/specialists/presets.ts.
export type CodePreset = ResolvedSpecialist & {
  kind: "preset" | "scripted";
};

// Drizzle-derived row type for the specialists table.
export type SpecialistRow = InferSelectModel<typeof specialists>;

// Override fields that can be applied on top of a code preset.
// Mirrors the nullable columns in `specialists`.
export type SpecialistOverrideFields = {
  systemPrompt?: string | null;
  model?: string | null;
  toolAllowlist?: readonly string[] | null;
  sandboxPolicy?: SandboxPolicy | null;
  mayRecurse?: boolean | null;
  maxChildren?: number | null;
  budgetUsdDefaultMicros?: number | null;
  needsLocalStack?: boolean | null;
};
