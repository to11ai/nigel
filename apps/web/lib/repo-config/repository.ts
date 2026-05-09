import { eq } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db/client";
import { repoConfigs } from "@/lib/db/schema";
import type { RepoConfig, StoredRepoConfigSource } from "./types";

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
  source: StoredRepoConfigSource,
): Promise<RepoConfigRow> {
  // Single atomic INSERT...ON CONFLICT — avoids the TOCTOU window that a
  // separate SELECT-then-INSERT/UPDATE would open under concurrent webhooks
  // for the same repo.
  const inserted = await db
    .insert(repoConfigs)
    .values({
      id: nanoid(),
      repoFullName,
      configJson: config,
      source,
    })
    .onConflictDoUpdate({
      target: repoConfigs.repoFullName,
      set: { configJson: config, source, updatedAt: new Date() },
    })
    .returning();
  return inserted[0];
}
