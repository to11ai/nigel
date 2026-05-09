import { eq } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db/client";
import { repoConfigs } from "@/lib/db/schema";
import type { RepoConfig, RepoConfigSource } from "./types";

export type RepoConfigRow = InferSelectModel<typeof repoConfigs>;

export async function getRepoConfigRow(
  repoFullName: string,
): Promise<RepoConfigRow | null> {
  const rows = await db
    .select()
    .from(repoConfigs)
    .where(eq(repoConfigs.repoFullName, repoFullName))
    .limit(1);
  return rows[0] ?? null;
}

export async function upsertRepoConfigRow(
  repoFullName: string,
  config: RepoConfig,
  source: RepoConfigSource,
): Promise<RepoConfigRow> {
  const existing = await getRepoConfigRow(repoFullName);
  const now = new Date();

  if (existing) {
    const updated = await db
      .update(repoConfigs)
      .set({ configJson: config, source, updatedAt: now })
      .where(eq(repoConfigs.id, existing.id))
      .returning();
    return updated[0];
  }

  const inserted = await db
    .insert(repoConfigs)
    .values({
      id: nanoid(),
      repoFullName,
      configJson: config,
      source,
    })
    .returning();
  return inserted[0];
}
