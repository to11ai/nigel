import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "@/lib/db/client";
import { repoConfigs } from "@/lib/db/schema";
import { upsertRepoConfigRow } from "./repository";
import { loadRepoConfig } from "./resolver";

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
