import { describe, expect, test } from "bun:test";
import {
  provisionSandboxForRun,
  SandboxCoordinatorError,
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
