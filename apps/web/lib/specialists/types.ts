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
  toolAllowlist: readonly string[];
  sandboxPolicy: SandboxPolicy;
  mayRecurse: boolean;
  maxChildren: number;
  budgetUsdDefaultMicros: number;
  needsLocalStack: boolean;
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
