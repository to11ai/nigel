import { and, eq, gt, isNull, or } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db/client";
import { sandboxSnapshots } from "@/lib/db/schema";

export type SandboxSnapshotRow = InferSelectModel<typeof sandboxSnapshots>;

export type GetSandboxSnapshotInput = {
  repoFullName: string;
  profile: string;
  keysHash: string;
};

export async function getSandboxSnapshot(
  input: GetSandboxSnapshotInput,
): Promise<SandboxSnapshotRow | null> {
  // Filter out expired rows: a row with `ttl_until` in the past is no
  // longer reusable. `ttl_until: null` means "no expiry" and always
  // passes through.
  const now = new Date();
  const rows = await db
    .select()
    .from(sandboxSnapshots)
    .where(
      and(
        eq(sandboxSnapshots.repoFullName, input.repoFullName),
        eq(sandboxSnapshots.profile, input.profile),
        eq(sandboxSnapshots.keysHash, input.keysHash),
        or(
          isNull(sandboxSnapshots.ttlUntil),
          gt(sandboxSnapshots.ttlUntil, now),
        ),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export type UpsertSandboxSnapshotInput = {
  repoFullName: string;
  branchOrSha: string;
  profile: string;
  baseSnapshotId: string | null;
  invalidationKeys: Record<string, string>;
  keysHash: string;
  ttlUntil?: Date | null;
  sizeBytes?: number | null;
};

export async function upsertSandboxSnapshot(
  input: UpsertSandboxSnapshotInput,
): Promise<SandboxSnapshotRow> {
  const inserted = await db
    .insert(sandboxSnapshots)
    .values({
      id: nanoid(),
      repoFullName: input.repoFullName,
      branchOrSha: input.branchOrSha,
      profile: input.profile,
      baseSnapshotId: input.baseSnapshotId,
      invalidationKeys: input.invalidationKeys,
      keysHash: input.keysHash,
      ttlUntil: input.ttlUntil ?? null,
      sizeBytes: input.sizeBytes ?? null,
    })
    .onConflictDoUpdate({
      target: [
        sandboxSnapshots.repoFullName,
        sandboxSnapshots.profile,
        sandboxSnapshots.keysHash,
      ],
      set: {
        branchOrSha: input.branchOrSha,
        baseSnapshotId: input.baseSnapshotId,
        invalidationKeys: input.invalidationKeys,
        ttlUntil: input.ttlUntil ?? null,
        sizeBytes: input.sizeBytes ?? null,
        builtAt: new Date(),
      },
    })
    .returning();
  const row = inserted[0];
  if (!row) {
    throw new Error("upsertSandboxSnapshot: RETURNING produced no row");
  }
  return row;
}
