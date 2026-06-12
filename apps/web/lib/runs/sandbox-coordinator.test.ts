import { describe, expect, test } from "bun:test";
import {
  type ProvisionedSandbox,
  provisionSandboxForRun,
  SandboxCoordinatorError,
  snapshotProvisionedSandbox,
} from "./sandbox-coordinator";

describe("provisionSandboxForRun", () => {
  test("throws SandboxCoordinatorError when inheritFrom is null", async () => {
    await expect(provisionSandboxForRun({ inheritFrom: null })).rejects.toThrow(
      SandboxCoordinatorError,
    );
  });

  // The "happy path" (connect to an existing SandboxState) requires the
  // Vercel Sandbox API; that's covered indirectly by the dispatch
  // integration test in Task 6, which mocks the sandbox layer.
});

function stubHandle(
  sandbox: Partial<ProvisionedSandbox["sandbox"]>,
): ProvisionedSandbox {
  return {
    sandbox: sandbox as ProvisionedSandbox["sandbox"],
    workingDirectory: "/work",
    ownedByThisRun: true,
    toAgentContext: () => ({ state: {} as never, workingDirectory: "/work" }),
    stop: async () => undefined,
  };
}

describe("snapshotProvisionedSandbox", () => {
  test("returns the snapshot id from the underlying sandbox", async () => {
    const handle = stubHandle({
      snapshot: async () => ({ snapshotId: "snap_abc" }),
    });
    expect(await snapshotProvisionedSandbox(handle)).toBe("snap_abc");
  });

  test("throws when the sandbox does not support snapshot()", async () => {
    const handle = stubHandle({});
    await expect(snapshotProvisionedSandbox(handle)).rejects.toThrow(
      SandboxCoordinatorError,
    );
  });
});
