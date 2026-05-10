import { describe, expect, test } from "bun:test";
import { RepoConfigSchema } from "./types";

describe("RepoConfigSchema", () => {
  test("accepts a minimal config", () => {
    const parsed = RepoConfigSchema.parse({ version: 1 });
    expect(parsed.version).toBe(1);
  });

  test("accepts the full spec example", () => {
    const parsed = RepoConfigSchema.parse({
      version: 1,
      setup: ["bun install --frozen-lockfile"],
      dev_server: { command: "bun run dev", port: 3000 },
      turbo: { enabled: true, affected: true, task_map: { lint: "lint" } },
      checks: {
        lint: { command: "bun run lint" },
        e2e_test: {
          command: "bun run test:e2e",
          local_stack_profile: "bare",
          needs: ["dev_server"],
        },
      },
      local_stack: {
        startup_commands: ["bun run scripts/provision-neon-branch.ts"],
        teardown_commands: ["bun run scripts/teardown-neon-branch.ts"],
        profiles: {
          bare: { description: "x", post_up: ["bun run db:migrate"] },
        },
        default_profile: "bare",
      },
      routes_for_visual_prover: [{ path: "/", auth: "none" }],
      frontend_globs: ["apps/web/**/*.tsx"],
      monorepo: { workspaces: ["apps/web"], default_workspace: "apps/web" },
    });
    expect(parsed.checks?.e2e_test?.local_stack_profile).toBe("bare");
  });

  test("rejects unknown version", () => {
    expect(() => RepoConfigSchema.parse({ version: 2 })).toThrow();
  });

  test("rejects unknown check key", () => {
    expect(() =>
      RepoConfigSchema.parse({
        version: 1,
        checks: { bogus: { command: "x" } },
      }),
    ).toThrow();
  });

  test("rejects monorepo.default_workspace that is not in workspaces", () => {
    expect(() =>
      RepoConfigSchema.parse({
        version: 1,
        monorepo: {
          workspaces: ["apps/web"],
          default_workspace: "apps/missing",
        },
      }),
    ).toThrow(/default_workspace/);
  });

  test("accepts monorepo without default_workspace", () => {
    const parsed = RepoConfigSchema.parse({
      version: 1,
      monorepo: { workspaces: ["apps/web", "apps/api"] },
    });
    expect(parsed.monorepo?.default_workspace).toBeUndefined();
  });

  test("rejects local_stack.default_profile that is not a key in profiles", () => {
    expect(() =>
      RepoConfigSchema.parse({
        version: 1,
        local_stack: {
          profiles: { bare: { description: "x" } },
          default_profile: "nonexistent",
        },
      }),
    ).toThrow(/default_profile/);
  });

  test("accepts post_up entries as either string or object", () => {
    const parsed = RepoConfigSchema.parse({
      version: 1,
      local_stack: {
        profiles: {
          full: {
            description: "full",
            post_up: [
              "bun run db:migrate",
              { cmd: "bun run db:warm-cache", timeout_seconds: 30, retry: 2 },
            ],
          },
        },
        default_profile: "full",
      },
    });
    expect(parsed.local_stack?.profiles.full?.post_up).toHaveLength(2);
  });

  test("startup_commands and teardown_commands accept string + object entries", () => {
    const parsed = RepoConfigSchema.parse({
      version: 1,
      local_stack: {
        startup_commands: [
          "bun run scripts/provision-neon-branch.ts",
          {
            cmd: "bun run scripts/provision-upstash.ts",
            timeout_seconds: 60,
            retry: 2,
          },
        ],
        teardown_commands: [
          {
            cmd: "bun run scripts/teardown-clickhouse.ts",
            timeout_seconds: 30,
          },
        ],
        startup_timeout_seconds: 120,
        teardown_timeout_seconds: 60,
        profiles: { bare: { description: "x" } },
        default_profile: "bare",
      },
    });
    expect(parsed.local_stack?.startup_commands).toHaveLength(2);
    expect(parsed.local_stack?.teardown_commands).toHaveLength(1);
    expect(parsed.local_stack?.teardown_timeout_seconds).toBe(60);
  });
});
