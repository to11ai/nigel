import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "@/lib/db/client";
import { sandboxSnapshots } from "@/lib/db/schema";
import { getSandboxSnapshot, upsertSandboxSnapshot } from "./repository";

beforeEach(async () => {
  await db.delete(sandboxSnapshots);
});

const sampleKeys = { "docker-compose.yaml": "abc", "bun.lock": "def" };
const sampleHash = "deadbeef".repeat(8); // 64 hex chars

describe("sandbox_snapshots repository", () => {
  test("getSandboxSnapshot returns null when no row", async () => {
    const row = await getSandboxSnapshot({
      repoFullName: "acme/widget",
      profile: "bare",
      keysHash: sampleHash,
    });
    expect(row).toBeNull();
  });

  test("upsert creates a new row", async () => {
    const row = await upsertSandboxSnapshot({
      repoFullName: "acme/widget",
      branchOrSha: "abc123",
      profile: "bare",
      baseSnapshotId: "vsbx-1",
      invalidationKeys: sampleKeys,
      keysHash: sampleHash,
      sizeBytes: 1024,
    });
    expect(row.repoFullName).toBe("acme/widget");
    expect(row.profile).toBe("bare");
    expect(row.keysHash).toBe(sampleHash);
    expect(row.baseSnapshotId).toBe("vsbx-1");
  });

  test("upsert updates the row in place when (repo, profile, keys_hash) collides", async () => {
    const a = await upsertSandboxSnapshot({
      repoFullName: "acme/widget",
      branchOrSha: "abc",
      profile: "bare",
      baseSnapshotId: "vsbx-1",
      invalidationKeys: sampleKeys,
      keysHash: sampleHash,
      sizeBytes: 100,
    });
    const b = await upsertSandboxSnapshot({
      repoFullName: "acme/widget",
      branchOrSha: "def",
      profile: "bare",
      baseSnapshotId: "vsbx-2",
      invalidationKeys: sampleKeys,
      keysHash: sampleHash,
      sizeBytes: 200,
    });
    expect(b.id).toBe(a.id);
    expect(b.baseSnapshotId).toBe("vsbx-2");
    expect(b.branchOrSha).toBe("def");
    expect(b.sizeBytes).toBe(200);
  });

  test("rows with different keys_hash are independent", async () => {
    const hashA = "a".repeat(64);
    const hashB = "b".repeat(64);
    await upsertSandboxSnapshot({
      repoFullName: "acme/widget",
      branchOrSha: "x",
      profile: "bare",
      baseSnapshotId: "vsbx-1",
      invalidationKeys: { f: "1" },
      keysHash: hashA,
    });
    await upsertSandboxSnapshot({
      repoFullName: "acme/widget",
      branchOrSha: "x",
      profile: "bare",
      baseSnapshotId: "vsbx-2",
      invalidationKeys: { f: "2" },
      keysHash: hashB,
    });
    const a = await getSandboxSnapshot({
      repoFullName: "acme/widget",
      profile: "bare",
      keysHash: hashA,
    });
    const b = await getSandboxSnapshot({
      repoFullName: "acme/widget",
      profile: "bare",
      keysHash: hashB,
    });
    expect(a?.baseSnapshotId).toBe("vsbx-1");
    expect(b?.baseSnapshotId).toBe("vsbx-2");
  });

  test("getSandboxSnapshot scopes by profile", async () => {
    await upsertSandboxSnapshot({
      repoFullName: "acme/widget",
      branchOrSha: "x",
      profile: "bare",
      baseSnapshotId: "vsbx-bare",
      invalidationKeys: { f: "1" },
      keysHash: sampleHash,
    });
    const other = await getSandboxSnapshot({
      repoFullName: "acme/widget",
      profile: "onboarded",
      keysHash: sampleHash,
    });
    expect(other).toBeNull();
  });
});
