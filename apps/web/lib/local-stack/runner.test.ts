import { describe, expect, mock, test } from "bun:test";
import type { RepoLocalStack, ResolvedProfile } from "./types";
import {
  type LocalStackExec,
  LocalStackCommandError,
  runLocalStackStartup,
  runLocalStackTeardown,
} from "./runner";

type ExecCall = { command: string; cwd: string; timeoutMs: number };

function makeExec(
  responses: Array<{
    success: boolean;
    exitCode?: number;
    stderr?: string;
    stdout?: string;
  }>,
): { exec: LocalStackExec; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  let i = 0;
  const exec: LocalStackExec = async (command, cwd, timeoutMs) => {
    calls.push({ command, cwd, timeoutMs });
    const r = responses[i++] ?? { success: true };
    return {
      success: r.success,
      exitCode: r.exitCode ?? (r.success ? 0 : 1),
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      truncated: false,
    };
  };
  return { exec, calls };
}

const baseStack: RepoLocalStack = {
  startup_commands: [],
  teardown_commands: [],
  teardown_on_exit: true,
  profiles: { default: { post_up: [] } },
  default_profile: "default",
};

const emptyProfile: ResolvedProfile = {
  name: "default",
  description: null,
  postUp: [],
};

describe("runLocalStackStartup", () => {
  test("runs startup_commands then profile.postUp in order", async () => {
    const { exec, calls } = makeExec([
      { success: true }, // startup #1
      { success: true }, // startup #2
      { success: true }, // post_up #1
    ]);
    await runLocalStackStartup({
      exec,
      workingDirectory: "/work",
      localStack: {
        ...baseStack,
        startup_commands: ["s1", "s2"],
      },
      profile: {
        ...emptyProfile,
        postUp: [{ cmd: "p1", timeoutSeconds: null, retry: null }],
      },
    });
    expect(calls.map((c) => c.command)).toEqual(["s1", "s2", "p1"]);
    expect(calls.every((c) => c.cwd === "/work")).toBe(true);
  });

  test("falls back to startup_timeout_seconds when a step lacks its own timeout", async () => {
    const { exec, calls } = makeExec([{ success: true }]);
    await runLocalStackStartup({
      exec,
      workingDirectory: "/work",
      localStack: {
        ...baseStack,
        startup_commands: ["bun run provision"],
        startup_timeout_seconds: 60,
      },
      profile: emptyProfile,
    });
    expect(calls[0]?.timeoutMs).toBe(60_000);
  });

  test("respects per-step timeout_seconds and retry", async () => {
    const { exec, calls } = makeExec([
      { success: false }, // attempt 1
      { success: false }, // attempt 2
      { success: true }, // attempt 3
    ]);
    await runLocalStackStartup({
      exec,
      workingDirectory: "/w",
      localStack: {
        ...baseStack,
        startup_commands: [{ cmd: "flaky", timeout_seconds: 5, retry: 2 }],
      },
      profile: emptyProfile,
    });
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.command === "flaky")).toBe(true);
    expect(calls[0]?.timeoutMs).toBe(5_000);
  });

  test("throws LocalStackCommandError after retries exhausted", async () => {
    const { exec } = makeExec([
      { success: false, exitCode: 2, stderr: "boom" },
      { success: false, exitCode: 2, stderr: "boom" },
    ]);
    await expect(
      runLocalStackStartup({
        exec,
        workingDirectory: "/w",
        localStack: {
          ...baseStack,
          startup_commands: [{ cmd: "broken", retry: 1 }],
        },
        profile: emptyProfile,
      }),
    ).rejects.toBeInstanceOf(LocalStackCommandError);
  });

  test("post_up errors are tagged with phase 'post_up'", async () => {
    const { exec } = makeExec([
      { success: true }, // startup
      { success: false, exitCode: 1, stderr: "post_up failed" }, // post_up
    ]);
    try {
      await runLocalStackStartup({
        exec,
        workingDirectory: "/w",
        localStack: {
          ...baseStack,
          startup_commands: ["s1"],
        },
        profile: {
          ...emptyProfile,
          postUp: [{ cmd: "p1", timeoutSeconds: null, retry: null }],
        },
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(LocalStackCommandError);
      expect((err as LocalStackCommandError).phase).toBe("post_up");
    }
  });
});

describe("runLocalStackTeardown", () => {
  test("skips entirely when teardown_on_exit is false", async () => {
    const { exec, calls } = makeExec([]);
    const failures = await runLocalStackTeardown({
      exec,
      workingDirectory: "/w",
      localStack: {
        ...baseStack,
        teardown_commands: ["never run"],
        teardown_on_exit: false,
      },
    });
    expect(calls).toEqual([]);
    expect(failures).toEqual([]);
  });

  test("runs teardown_commands sequentially when teardown_on_exit is true", async () => {
    const { exec, calls } = makeExec([{ success: true }, { success: true }]);
    const failures = await runLocalStackTeardown({
      exec,
      workingDirectory: "/w",
      localStack: {
        ...baseStack,
        teardown_commands: ["t1", "t2"],
      },
    });
    expect(calls.map((c) => c.command)).toEqual(["t1", "t2"]);
    expect(failures).toEqual([]);
  });

  test("continues after a failing step and returns the collected errors", async () => {
    const { exec, calls } = makeExec([
      { success: false, exitCode: 3, stderr: "first failed" },
      { success: true },
    ]);
    const failures = await runLocalStackTeardown({
      exec,
      workingDirectory: "/w",
      localStack: {
        ...baseStack,
        teardown_commands: ["t1", "t2"],
      },
    });
    expect(calls.map((c) => c.command)).toEqual(["t1", "t2"]);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.command).toBe("t1");
    expect(failures[0]?.phase).toBe("teardown");
  });

  test("uses teardown_timeout_seconds when step lacks its own timeout", async () => {
    const { exec, calls } = makeExec([{ success: true }]);
    await runLocalStackTeardown({
      exec,
      workingDirectory: "/w",
      localStack: {
        ...baseStack,
        teardown_commands: ["t1"],
        teardown_timeout_seconds: 30,
      },
    });
    expect(calls[0]?.timeoutMs).toBe(30_000);
  });

  test("re-throws non-LocalStackCommandError thrown by exec", async () => {
    const boom = new Error("connection lost");
    const exec: LocalStackExec = mock(async () => {
      throw boom;
    });
    await expect(
      runLocalStackTeardown({
        exec,
        workingDirectory: "/w",
        localStack: {
          ...baseStack,
          teardown_commands: ["t1"],
        },
      }),
    ).rejects.toBe(boom);
  });
});
