import { beforeEach, describe, expect, test } from "bun:test";
import { nanoid } from "nanoid";
import { db } from "@/lib/db/client";
import { repoConfigs } from "@/lib/db/schema";
import { upsertRepoConfigRow } from "./repository";
import { loadRepoConfig, RepoConfigCorruptError } from "./resolver";
import type { RepoConfig } from "./types";

beforeEach(async () => {
  await db.delete(repoConfigs);
});

describe("loadRepoConfig", () => {
  test("file source: parses yaml when provided", async () => {
    const out = await loadRepoConfig({
      repoFullName: "acme/widget",
      yamlText: "version: 1\nsetup: ['bun install']\n",
      packageJson: null,
      turboJson: null,
    });
    expect(out.source).toBe("file");
    expect(out.config.version).toBe(1);
  });

  test("file source: applies Turbo derivation", async () => {
    const out = await loadRepoConfig({
      repoFullName: "acme/widget",
      yamlText: "version: 1\nchecks:\n  lint: {}\n",
      packageJson: null,
      turboJson: { tasks: {} },
    });
    expect(out.source).toBe("file");
    if (out.source !== "file") throw new Error("unexpected source");
    expect(out.config.checks?.lint?.command).toBe("turbo run lint");
  });

  test("db source: returns the persisted row when no yaml", async () => {
    await upsertRepoConfigRow(
      "acme/widget",
      { version: 1, setup: ["echo persisted"] },
      "db",
    );
    const out = await loadRepoConfig({
      repoFullName: "acme/widget",
      yamlText: null,
      packageJson: null,
      turboJson: null,
    });
    expect(out.source).toBe("db");
    expect(out.config.setup).toEqual(["echo persisted"]);
  });

  test("inferred source: persists the auto-detected config and returns warning", async () => {
    const out = await loadRepoConfig({
      repoFullName: "acme/widget",
      yamlText: null,
      packageJson: { workspaces: ["apps/web"] },
      turboJson: { tasks: {} },
    });
    expect(out.source).toBe("inferred");
    if (out.source !== "inferred") throw new Error("unexpected source");
    expect(out.warning).toMatch(/no \.nigel\.yaml/i);
    expect(out.config.checks?.lint?.command).toBe("turbo run lint");

    const out2 = await loadRepoConfig({
      repoFullName: "acme/widget",
      yamlText: null,
      packageJson: { workspaces: ["apps/web"] },
      turboJson: { tasks: {} },
    });
    expect(out2.source).toBe("inferred"); // persisted with source='inferred'
  });

  test("throws RepoConfigCorruptError when stored row fails schema validation", async () => {
    // Insert a row whose configJson is structurally invalid (e.g., wrong
    // version) — bypass the repository layer's typed input.
    await db.insert(repoConfigs).values({
      id: nanoid(),
      repoFullName: "acme/widget",
      configJson: { version: 99, bogus: true } as unknown as RepoConfig,
      source: "db",
    });
    await expect(
      loadRepoConfig({
        repoFullName: "acme/widget",
        yamlText: null,
        packageJson: null,
        turboJson: null,
      }),
    ).rejects.toThrow(RepoConfigCorruptError);
  });

  test("file source wins over an existing db row", async () => {
    await upsertRepoConfigRow(
      "acme/widget",
      { version: 1, setup: ["echo persisted"] },
      "db",
    );
    const out = await loadRepoConfig({
      repoFullName: "acme/widget",
      yamlText: "version: 1\nsetup: ['echo file']\n",
      packageJson: null,
      turboJson: null,
    });
    expect(out.source).toBe("file");
    expect(out.config.setup).toEqual(["echo file"]);
  });
});
