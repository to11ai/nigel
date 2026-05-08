import { describe, expect, test } from "bun:test";
import { autoDetectRepoConfig } from "./auto-detect";

describe("autoDetectRepoConfig", () => {
  test("returns minimal config when no inputs provided", () => {
    const out = autoDetectRepoConfig({ packageJson: null, turboJson: null });
    expect(out.version).toBe(1);
    expect(out.turbo).toBeUndefined();
    expect(out.monorepo).toBeUndefined();
  });

  test("enables turbo when turbo.json present", () => {
    const out = autoDetectRepoConfig({
      packageJson: null,
      turboJson: { tasks: {} },
    });
    expect(out.turbo?.enabled).toBe(true);
  });

  test("infers monorepo from package.json workspaces array", () => {
    const out = autoDetectRepoConfig({
      packageJson: { workspaces: ["apps/web", "apps/api"] },
      turboJson: null,
    });
    expect(out.monorepo?.workspaces).toEqual(["apps/web", "apps/api"]);
    expect(out.monorepo?.default_workspace).toBe("apps/web");
  });

  test("infers monorepo from package.json workspaces.packages object form", () => {
    const out = autoDetectRepoConfig({
      packageJson: { workspaces: { packages: ["packages/*"] } },
      turboJson: null,
    });
    expect(out.monorepo?.workspaces).toEqual(["packages/*"]);
  });

  test("derives commands when both turbo.json and workspaces are present", () => {
    const out = autoDetectRepoConfig({
      packageJson: { workspaces: ["apps/web"] },
      turboJson: { tasks: {} },
    });
    expect(out.checks?.lint?.command).toBe("turbo run lint");
    expect(out.checks?.e2e_test?.command).toBe(
      "turbo run test:e2e --filter=apps/web",
    );
  });

  test("default setup is bun install", () => {
    const out = autoDetectRepoConfig({ packageJson: null, turboJson: null });
    expect(out.setup).toEqual(["bun install --frozen-lockfile"]);
  });
});
