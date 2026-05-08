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
