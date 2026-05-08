import { describe, expect, test } from "bun:test";
import { applyTurboDerivation } from "./turbo-derive";
import type { RepoConfig } from "./types";

const base = (overrides: Partial<RepoConfig> = {}): RepoConfig =>
  ({ version: 1, setup: [], ...overrides }) as RepoConfig;

describe("applyTurboDerivation", () => {
  test("returns config unchanged when turbo is disabled and no turbo.json", () => {
    const config = base({ checks: { lint: {} } });
    const out = applyTurboDerivation(config, { turboJsonPresent: false });
    expect(out.checks?.lint?.command).toBeUndefined();
  });

  test("auto-enables turbo when turbo.json is present and not explicitly disabled", () => {
    const config = base({ checks: { lint: {} } });
    const out = applyTurboDerivation(config, { turboJsonPresent: true });
    expect(out.checks?.lint?.command).toBe("turbo run lint");
  });

  test("respects explicit turbo.enabled=false even when turbo.json is present", () => {
    const config = base({
      turbo: { enabled: false, affected: false },
      checks: { lint: {} },
    });
    const out = applyTurboDerivation(config, { turboJsonPresent: true });
    expect(out.checks?.lint?.command).toBeUndefined();
  });

  test("derives all five check defaults", () => {
    const config = base({
      checks: {
        lint: {},
        format: {},
        type_check: {},
        unit_test: {},
        e2e_test: {},
      },
    });
    const out = applyTurboDerivation(config, { turboJsonPresent: true });
    expect(out.checks?.lint?.command).toBe("turbo run lint");
    expect(out.checks?.format?.command).toBe("turbo run format:check");
    expect(out.checks?.type_check?.command).toBe("turbo run check-types");
    expect(out.checks?.unit_test?.command).toBe("turbo run test:unit");
    expect(out.checks?.e2e_test?.command).toBe("turbo run test:e2e");
  });

  test("appends --filter=<default_workspace> to e2e_test and dev_server", () => {
    const config = base({
      checks: { e2e_test: {} },
      dev_server: {},
      monorepo: { workspaces: ["apps/web"], default_workspace: "apps/web" },
    });
    const out = applyTurboDerivation(config, { turboJsonPresent: true });
    expect(out.checks?.e2e_test?.command).toBe(
      "turbo run test:e2e --filter=apps/web",
    );
    expect(out.dev_server?.command).toBe("turbo run dev --filter=apps/web");
  });

  test("explicit command overrides derivation", () => {
    const config = base({
      checks: { lint: { command: "custom-lint" } },
    });
    const out = applyTurboDerivation(config, { turboJsonPresent: true });
    expect(out.checks?.lint?.command).toBe("custom-lint");
  });

  test("turbo.task_map overrides default task names", () => {
    const config = base({
      turbo: { affected: false, task_map: { lint: "lint:strict" } },
      checks: { lint: {} },
    });
    const out = applyTurboDerivation(config, { turboJsonPresent: true });
    expect(out.checks?.lint?.command).toBe("turbo run lint:strict");
  });
});
