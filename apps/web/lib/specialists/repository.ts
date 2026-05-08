import { and, asc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db/client";
import { specialists } from "@/lib/db/schema";
import type { SpecialistOverrideFields, SpecialistRow } from "./types";

export type CustomSpecialistInput = {
  name: string;
  systemPrompt: string;
  model: string;
  toolAllowlist: readonly string[];
  sandboxPolicy: "inherit" | "fresh" | "fresh_clean";
  mayRecurse: boolean;
  maxChildren: number;
  budgetUsdDefaultMicros: number;
  needsLocalStack: boolean;
  createdBy?: string | null;
};

export async function upsertCustomSpecialist(
  input: CustomSpecialistInput,
): Promise<SpecialistRow> {
  const existing = await db
    .select()
    .from(specialists)
    .where(eq(specialists.name, input.name))
    .limit(1);
  const row = existing[0];
  const now = new Date();

  if (row) {
    if (row.kind !== "custom") {
      throw new Error(
        `specialist '${input.name}' exists with kind='${row.kind}', expected 'custom'`,
      );
    }
    const updated = await db
      .update(specialists)
      .set({
        systemPrompt: input.systemPrompt,
        model: input.model,
        toolAllowlist: [...input.toolAllowlist],
        sandboxPolicy: input.sandboxPolicy,
        mayRecurse: input.mayRecurse,
        maxChildren: input.maxChildren,
        budgetUsdDefaultMicros: input.budgetUsdDefaultMicros,
        needsLocalStack: input.needsLocalStack,
        updatedAt: now,
      })
      .where(eq(specialists.id, row.id))
      .returning();
    return updated[0];
  }

  const inserted = await db
    .insert(specialists)
    .values({
      id: nanoid(),
      name: input.name,
      kind: "custom",
      systemPrompt: input.systemPrompt,
      model: input.model,
      toolAllowlist: [...input.toolAllowlist],
      sandboxPolicy: input.sandboxPolicy,
      mayRecurse: input.mayRecurse,
      maxChildren: input.maxChildren,
      budgetUsdDefaultMicros: input.budgetUsdDefaultMicros,
      needsLocalStack: input.needsLocalStack,
      createdBy: input.createdBy ?? null,
    })
    .returning();
  return inserted[0];
}

export async function upsertOverride(
  name: string,
  fields: SpecialistOverrideFields,
): Promise<SpecialistRow> {
  const existing = await db
    .select()
    .from(specialists)
    .where(eq(specialists.name, name))
    .limit(1);
  const row = existing[0];
  const now = new Date();

  if (row) {
    if (row.kind !== "override") {
      throw new Error(
        `specialist '${name}' exists with kind='${row.kind}', expected 'override'`,
      );
    }
    const updated = await db
      .update(specialists)
      .set({
        ...normalizeOverrideFields(fields),
        updatedAt: now,
      })
      .where(eq(specialists.id, row.id))
      .returning();
    return updated[0];
  }

  const inserted = await db
    .insert(specialists)
    .values({
      id: nanoid(),
      name,
      kind: "override",
      ...normalizeOverrideFields(fields),
    })
    .returning();
  return inserted[0];
}

export async function deleteOverride(name: string): Promise<void> {
  await db
    .delete(specialists)
    .where(and(eq(specialists.name, name), eq(specialists.kind, "override")));
}

export async function listSpecialists(): Promise<SpecialistRow[]> {
  return db.select().from(specialists).orderBy(asc(specialists.name));
}

function normalizeOverrideFields(
  fields: SpecialistOverrideFields,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (fields.systemPrompt !== undefined) out.systemPrompt = fields.systemPrompt;
  if (fields.model !== undefined) out.model = fields.model;
  if (fields.toolAllowlist !== undefined) {
    out.toolAllowlist = fields.toolAllowlist ? [...fields.toolAllowlist] : null;
  }
  if (fields.sandboxPolicy !== undefined) {
    out.sandboxPolicy = fields.sandboxPolicy;
  }
  if (fields.mayRecurse !== undefined) out.mayRecurse = fields.mayRecurse;
  if (fields.maxChildren !== undefined) out.maxChildren = fields.maxChildren;
  if (fields.budgetUsdDefaultMicros !== undefined) {
    out.budgetUsdDefaultMicros = fields.budgetUsdDefaultMicros;
  }
  if (fields.needsLocalStack !== undefined) {
    out.needsLocalStack = fields.needsLocalStack;
  }
  return out;
}
