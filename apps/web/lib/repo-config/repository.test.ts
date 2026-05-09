import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "@/lib/db/client";
import { repoConfigs } from "@/lib/db/schema";
import { getRepoConfigRow, upsertRepoConfigRow } from "./repository";
import type { RepoConfig } from "./types";

const sample: RepoConfig = {
  version: 1,
  setup: ["bun install"],
};

beforeEach(async () => {
  await db.delete(repoConfigs);
});

describe("repo_configs repository", () => {
  test("upsertRepoConfigRow creates a new row", async () => {
    const row = await upsertRepoConfigRow("acme/widget", sample, "db");
    expect(row.repoFullName).toBe("acme/widget");
    expect(row.source).toBe("db");
  });

  test("upsertRepoConfigRow updates the existing row in place", async () => {
    const a = await upsertRepoConfigRow("acme/widget", sample, "inferred");
    const b = await upsertRepoConfigRow(
      "acme/widget",
      { ...sample, setup: ["echo updated"] },
      "db",
    );
    expect(b.id).toBe(a.id);
    expect(b.source).toBe("db");
    expect((b.configJson as RepoConfig).setup).toEqual(["echo updated"]);
  });

  test("getRepoConfigRow returns the row when present", async () => {
    await upsertRepoConfigRow("acme/widget", sample, "db");
    const row = await getRepoConfigRow("acme/widget");
    expect(row?.repoFullName).toBe("acme/widget");
  });

  test("getRepoConfigRow returns null when absent", async () => {
    const row = await getRepoConfigRow("does/not-exist");
    expect(row).toBeNull();
  });
});
