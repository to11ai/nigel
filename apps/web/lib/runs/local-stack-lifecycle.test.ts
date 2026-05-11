import { describe, expect, mock, test } from "bun:test";
import type { ResolvedSpecialist } from "@/lib/specialists";
import {
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
