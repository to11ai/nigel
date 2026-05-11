import type { ExecResult } from "@nigel/sandbox";
import type { RepoLocalStack, ResolvedProfile } from "./types";

// Minimal exec interface the runner needs. Matches the signature of
// `Sandbox.exec` from `@nigel/sandbox` so dispatch.ts can pass
// `provisioned.sandbox.exec` directly (bound), and tests can stub it
// without depending on a real Sandbox.
export type LocalStackExec = (
  command: string,
  cwd: string,
  timeoutMs: number,
  options?: { signal?: AbortSignal },
) => Promise<ExecResult>;

export type LocalStackPhase = "startup" | "post_up" | "teardown";

export class LocalStackCommandError extends Error {
  readonly phase: LocalStackPhase;
  readonly command: string;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  constructor(input: {
    phase: LocalStackPhase;
    command: string;
    exitCode: number | null;
    stdout: string;
    stderr: string;
  }) {
    const head = input.stderr.trim() || input.stdout.trim() || "(no output)";
    super(
      `local stack ${input.phase} command failed (exit ${input.exitCode}): ${input.command}\n${head}`,
    );
    this.name = "LocalStackCommandError";
    this.phase = input.phase;
    this.command = input.command;
    this.exitCode = input.exitCode;
    this.stdout = input.stdout;
    this.stderr = input.stderr;
  }
}

// Per-command bounds. When the repo config doesn't specify a
// timeout, fall back to a phase-level default (set at call time from
// `local_stack.startup_timeout_seconds` / `teardown_timeout_seconds`)
// and ultimately to a conservative built-in for cases the config left
// unset entirely.
const FALLBACK_TIMEOUT_SECONDS = 300;

export type RunStartupInput = {
  exec: LocalStackExec;
  workingDirectory: string;
  localStack: RepoLocalStack;
  profile: ResolvedProfile;
  signal?: AbortSignal;
};

export type RunTeardownInput = {
  exec: LocalStackExec;
  workingDirectory: string;
  localStack: RepoLocalStack;
  signal?: AbortSignal;
};

// Run the repo's `startup_commands` then the resolved profile's
// `post_up`, in order. Per the spec, each command is responsible for
// its own readiness — no `wait_for` step. We honor per-command
// timeouts and retries; on final failure we throw so the dispatch
// path can fail the child run cleanly.
export async function runLocalStackStartup(
  input: RunStartupInput,
): Promise<void> {
  const { exec, workingDirectory, localStack, profile, signal } = input;
  const defaultStartupTimeoutMs =
    (localStack.startup_timeout_seconds ?? FALLBACK_TIMEOUT_SECONDS) * 1000;

  for (const step of localStack.startup_commands) {
    await runOne({
      exec,
      workingDirectory,
      phase: "startup",
      command: typeof step === "string" ? step : step.cmd,
      timeoutMs:
        typeof step === "string"
          ? defaultStartupTimeoutMs
          : (step.timeout_seconds ?? 0) * 1000 || defaultStartupTimeoutMs,
      retries: typeof step === "string" ? 0 : (step.retry ?? 0),
      signal,
    });
  }

  for (const step of profile.postUp) {
    await runOne({
      exec,
      workingDirectory,
      phase: "post_up",
      command: step.cmd,
      timeoutMs: (step.timeoutSeconds ?? 0) * 1000 || defaultStartupTimeoutMs,
      retries: step.retry ?? 0,
      signal,
    });
  }
}

// Run the repo's `teardown_commands`. Honors `teardown_on_exit` (true
// by default in the schema). Teardown errors do not throw — teardown
// runs in a `finally` and crashing it would mask the original outcome.
// Caller is responsible for logging via the returned error list.
export async function runLocalStackTeardown(
  input: RunTeardownInput,
): Promise<LocalStackCommandError[]> {
  const { exec, workingDirectory, localStack, signal } = input;
  if (!localStack.teardown_on_exit) return [];

  const defaultTeardownTimeoutMs =
    (localStack.teardown_timeout_seconds ?? FALLBACK_TIMEOUT_SECONDS) * 1000;
  const failures: LocalStackCommandError[] = [];

  for (const step of localStack.teardown_commands) {
    try {
      await runOne({
        exec,
        workingDirectory,
        phase: "teardown",
        command: typeof step === "string" ? step : step.cmd,
        timeoutMs:
          typeof step === "string"
            ? defaultTeardownTimeoutMs
            : (step.timeout_seconds ?? 0) * 1000 || defaultTeardownTimeoutMs,
        retries: typeof step === "string" ? 0 : (step.retry ?? 0),
        signal,
      });
    } catch (err) {
      if (err instanceof LocalStackCommandError) {
        failures.push(err);
        // Keep running subsequent teardown commands. A failed
        // resource-delete step shouldn't prevent the rest of the
        // teardown sequence from attempting cleanup.
        continue;
      }
      throw err;
    }
  }
  return failures;
}

async function runOne(input: {
  exec: LocalStackExec;
  workingDirectory: string;
  phase: LocalStackPhase;
  command: string;
  timeoutMs: number;
  retries: number;
  signal?: AbortSignal;
}): Promise<void> {
  const attempts = input.retries + 1;
  let lastError: LocalStackCommandError | null = null;
  for (let i = 0; i < attempts; i++) {
    const result = await input.exec(
      input.command,
      input.workingDirectory,
      input.timeoutMs,
      input.signal ? { signal: input.signal } : undefined,
    );
    if (result.success) return;
    lastError = new LocalStackCommandError({
      phase: input.phase,
      command: input.command,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }
  // attempts >= 1, so at least one attempt has run and lastError is set.
  throw lastError as LocalStackCommandError;
}
