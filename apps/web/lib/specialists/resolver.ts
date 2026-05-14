import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { specialists } from "@/lib/db/schema";
import { PRESETS } from "./presets";
import type { CodePreset, ResolvedSpecialist, SpecialistRow } from "./types";

export async function getSpecialist(
  name: string,
): Promise<ResolvedSpecialist | null> {
  const preset = PRESETS[name];
  const rows = await db
    .select()
    .from(specialists)
    .where(eq(specialists.name, name))
    .limit(1);
  const row = rows[0] ?? null;

  if (!row && !preset) {
    return null;
  }

  if (preset && (!row || row.kind === "override")) {
    return mergePreset(preset, row);
  }

  if (!preset && row?.kind === "custom") {
    return rowToCustom(row);
  }

  if (!preset && row?.kind === "override") {
    throw new Error(
      `specialist override has no matching preset in code: ${name}`,
    );
  }

  // Preset exists + row.kind is something unexpected (e.g., 'custom' with a
  // matching preset name — name collision the registry should reject).
  throw new Error(
    `specialist row has unexpected kind for preset name '${name}': ${row?.kind}`,
  );
}

function mergePreset(
  preset: CodePreset,
  row: SpecialistRow | null,
): ResolvedSpecialist {
  if (!row) {
    return { ...preset };
  }
  // Planner is coordinator-only per the spec amendment. An admin must
  // not be able to paper over that by adding `file`, `shell`, or `git`
  // back via a `kind='override'` row. Refuse the override outright
  // rather than silently stripping the disallowed entries — silent
  // stripping would make the override look applied when it isn't.
  if (preset.name === "planner" && row && row.toolAllowlist) {
    const forbidden = ["file", "shell", "git"];
    const violations = row.toolAllowlist.filter((c) =>
      forbidden.includes(c),
    );
    if (violations.length > 0) {
      throw new Error(
        `planner_override_forbidden_tools: cannot apply override to 'planner' that re-adds coordinator-prohibited tools: ${violations.join(", ")}`,
      );
    }
  }
  return {
    name: preset.name,
    kind: preset.kind,
    systemPrompt: row.systemPrompt ?? preset.systemPrompt,
    model: row.model ?? preset.model,
    toolAllowlist: (row.toolAllowlist ??
      preset.toolAllowlist) as readonly string[],
    sandboxPolicy: row.sandboxPolicy ?? preset.sandboxPolicy,
    mayRecurse: row.mayRecurse ?? preset.mayRecurse,
    maxChildren: row.maxChildren ?? preset.maxChildren,
    budgetUsdDefaultMicros:
      row.budgetUsdDefaultMicros ?? preset.budgetUsdDefaultMicros,
    needsLocalStack: row.needsLocalStack ?? preset.needsLocalStack,
    // Inherited from the preset only — the specialists table has no
    // column for these yet, and a DB override of a preset cannot
    // loosen the dispatch gate or strip per-agent reasoning effort.
    ...(preset.providerOptions !== undefined
      ? { providerOptions: preset.providerOptions }
      : {}),
    ...(preset.dispatchTargetAllowlist !== undefined
      ? { dispatchTargetAllowlist: preset.dispatchTargetAllowlist }
      : {}),
    script: preset.script,
  };
}

function rowToCustom(row: SpecialistRow): ResolvedSpecialist {
  const required = {
    systemPrompt: row.systemPrompt,
    model: row.model,
    toolAllowlist: row.toolAllowlist,
    sandboxPolicy: row.sandboxPolicy,
    mayRecurse: row.mayRecurse,
    maxChildren: row.maxChildren,
    budgetUsdDefaultMicros: row.budgetUsdDefaultMicros,
    needsLocalStack: row.needsLocalStack,
  };
  for (const [k, v] of Object.entries(required)) {
    if (v === null || v === undefined) {
      throw new Error(
        `custom specialist '${row.name}' is incomplete — missing field: ${k}`,
      );
    }
  }
  return {
    name: row.name,
    kind: "custom",
    systemPrompt: row.systemPrompt as string,
    model: row.model,
    toolAllowlist: row.toolAllowlist as readonly string[],
    sandboxPolicy: row.sandboxPolicy as ResolvedSpecialist["sandboxPolicy"],
    mayRecurse: row.mayRecurse as boolean,
    maxChildren: row.maxChildren as number,
    budgetUsdDefaultMicros: row.budgetUsdDefaultMicros as number,
    needsLocalStack: row.needsLocalStack as boolean,
  };
}
