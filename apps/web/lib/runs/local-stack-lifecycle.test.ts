import { describe, expect, mock, test } from "bun:test";
import type { RepoConfig } from "@/lib/repo-config/types";
import type { ResolvedSpecialist } from "@/lib/specialists";
import {
  createLocalStackLifecycle,
  defaultLocalStackLifecycle,
  LocalStackPrepareError,
} from "./local-stack-lifecycle";
import type { ProvisionedSandbox } from "./sandbox-coordinator";

function fakeSpecialist(
  overrides: Partial<ResolvedSpecialist> = {},
): ResolvedSpecialist {
  return {
    name: "e2e-tester",
    kind: "preset",
    systemPrompt: "...",
    model: "anthropic/claude-sonnet-4.6",
    toolAllowlist: ["file", "search", "shell"],
    sandboxPolicy: "fresh",
    mayRecurse: false,
    maxChildren: 0,
    budgetUsdDefaultMicros: 5_000_000,
    needsLocalStack: true,
    ...overrides,
  };
}

function fakeProvisioned(
  execImpl: ProvisionedSandbox["sandbox"]["exec"],
): ProvisionedSandbox {
  // The lifecycle only touches `.workingDirectory` and `.sandbox.exec`.
  // Everything else is unused; cast it explicitly to keep the test
  // focused on what the SUT actually depends on.
  return {
    sandbox: { exec: execImpl } as unknown as ProvisionedSandbox["sandbox"],
    workingDirectory: "/work",
    ownedByThisRun: false,
    toAgentContext: () => ({
      state: { type: "vercel", sandboxId: "s1", expiresAt: 1 } as never,
      workingDirectory: "/work",
    }),
    stop: async () => undefined,
  };
}

describe("defaultLocalStackLifecycle.prepare", () => {
  test("returns a no-op teardown when specialist does not need the stack", async () => {
    const exec = mock(async () => ({
      success: false,
      exitCode: 1,
      stdout: "",
      stderr: "",
      truncated: false,
    }));
    const teardown = await defaultLocalStackLifecycle.prepare({
      specialist: fakeSpecialist({ needsLocalStack: false }),
      provisioned: fakeProvisioned(exec),
      parentRepoRef: "owner/repo",
    });
    expect(typeof teardown).toBe("function");
    await teardown();
    // No exec calls means the no-op shortcut fired (no config read,
    // no startup, no teardown).
    expect(exec).not.toHaveBeenCalled();
  });

  test("throws LocalStackPrepareError when parent has no repoRef", async () => {
    const exec = mock(async () => ({
      success: false,
      exitCode: 1,
      stdout: "",
      stderr: "",
      truncated: false,
    }));
    await expect(
      defaultLocalStackLifecycle.prepare({
        specialist: fakeSpecialist(),
        provisioned: fakeProvisioned(exec),
        parentRepoRef: null,
      }),
    ).rejects.toBeInstanceOf(LocalStackPrepareError);
  });
});

const configWithStack: RepoConfig = {
  version: 1,
  setup: [],
  local_stack: {
    startup_commands: ["s1", "s2"],
    teardown_commands: ["t1"],
    teardown_on_exit: true,
    profiles: { default: { post_up: [] } },
    default_profile: "default",
  },
};

describe("createLocalStackLifecycle — partial startup recovery", () => {
  test("runs teardown when startup throws, then rethrows", async () => {
    const exec = mock(async () => ({
      success: true,
      exitCode: 0,
      stdout: "",
      stderr: "",
      truncated: false,
    }));
    const startupError = new Error("start-server failed");
    const runStartup = mock(async () => {
      throw startupError;
    });
    const runTeardown = mock(async () => []);
    const lifecycle = createLocalStackLifecycle({
      loadRepoConfig: async () => configWithStack,
      runStartup,
      runTeardown,
    });
    await expect(
      lifecycle.prepare({
        specialist: fakeSpecialist(),
        provisioned: fakeProvisioned(exec),
        parentRepoRef: "owner/repo",
      }),
    ).rejects.toBeInstanceOf(LocalStackPrepareError);
    expect(runStartup).toHaveBeenCalledTimes(1);
    expect(runTeardown).toHaveBeenCalledTimes(1);
  });

  test("startup-failure recovery: rethrows the original startup error as cause even if teardown also throws", async () => {
    const exec = mock(async () => ({
      success: true,
      exitCode: 0,
      stdout: "",
      stderr: "",
      truncated: false,
    }));
    const startupError = new Error("start-server failed");
    const lifecycle = createLocalStackLifecycle({
      loadRepoConfig: async () => configWithStack,
      runStartup: async () => {
        throw startupError;
      },
      runTeardown: async () => {
        throw new Error("teardown also failed");
      },
    });
    try {
      await lifecycle.prepare({
        specialist: fakeSpecialist(),
        provisioned: fakeProvisioned(exec),
        parentRepoRef: "owner/repo",
      });
      throw new Error("expected prepare to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(LocalStackPrepareError);
      expect((err as Error & { cause?: unknown }).cause).toBe(startupError);
    }
  });
});

describe("createLocalStackLifecycle — happy-path teardown", () => {
  test("returned teardown invokes runTeardown with the resolved profile's localStack", async () => {
    const exec = mock(async () => ({
      success: true,
      exitCode: 0,
      stdout: "",
      stderr: "",
      truncated: false,
    }));
    const runTeardown = mock(async () => []);
    const lifecycle = createLocalStackLifecycle({
      loadRepoConfig: async () => configWithStack,
      runStartup: async () => undefined,
      runTeardown,
    });
    const teardown = await lifecycle.prepare({
      specialist: fakeSpecialist(),
      provisioned: fakeProvisioned(exec),
      parentRepoRef: "owner/repo",
    });
    await teardown();
    expect(runTeardown).toHaveBeenCalledTimes(1);
  });

  test("teardown swallows non-runner errors (must not throw past finally)", async () => {
    const exec = mock(async () => ({
      success: true,
      exitCode: 0,
      stdout: "",
      stderr: "",
      truncated: false,
    }));
    const lifecycle = createLocalStackLifecycle({
      loadRepoConfig: async () => configWithStack,
      runStartup: async () => undefined,
      runTeardown: async () => {
        throw new Error("unexpected teardown contract violation");
      },
    });
    const teardown = await lifecycle.prepare({
      specialist: fakeSpecialist(),
      provisioned: fakeProvisioned(exec),
      parentRepoRef: "owner/repo",
    });
    // Should not throw — the teardown closure logs and returns.
    await expect(teardown()).resolves.toBeUndefined();
  });
});

describe("createLocalStackLifecycle — pre-startup failures", () => {
  test("missing local_stack block throws LocalStackPrepareError", async () => {
    const exec = mock(async () => ({
      success: true,
      exitCode: 0,
      stdout: "",
      stderr: "",
      truncated: false,
    }));
    const lifecycle = createLocalStackLifecycle({
      loadRepoConfig: async () => ({ version: 1, setup: [] }) as RepoConfig,
      runStartup: async () => undefined,
      runTeardown: async () => [],
    });
    await expect(
      lifecycle.prepare({
        specialist: fakeSpecialist(),
        provisioned: fakeProvisioned(exec),
        parentRepoRef: "owner/repo",
      }),
    ).rejects.toBeInstanceOf(LocalStackPrepareError);
  });

  test("loadRepoConfig failure rethrows as LocalStackPrepareError", async () => {
    const exec = mock(async () => ({
      success: true,
      exitCode: 0,
      stdout: "",
      stderr: "",
      truncated: false,
    }));
    const lifecycle = createLocalStackLifecycle({
      loadRepoConfig: async () => {
        throw new Error("sandbox cat failed");
      },
      runStartup: async () => undefined,
      runTeardown: async () => [],
    });
    await expect(
      lifecycle.prepare({
        specialist: fakeSpecialist(),
        provisioned: fakeProvisioned(exec),
        parentRepoRef: "owner/repo",
      }),
    ).rejects.toBeInstanceOf(LocalStackPrepareError);
  });
});
