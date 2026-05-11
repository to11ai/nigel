import {
  type LocalStackCommandError,
  type LocalStackExec,
  type ResolvedProfile,
  resolveProfile,
  type RunStartupInput,
  type RunTeardownInput,
  runLocalStackStartup,
  runLocalStackTeardown,
} from "@/lib/local-stack";
import type { RepoConfig } from "@/lib/repo-config/types";
import type { ResolvedSpecialist } from "@/lib/specialists";
import { loadRepoConfigFromSandbox } from "./repo-config-from-sandbox";
import type { ProvisionedSandbox } from "./sandbox-coordinator";

export class LocalStackPrepareError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LocalStackPrepareError";
  }
}

export type LocalStackTeardown = () => Promise<void>;

// Lifecycle bound to a single dispatch. Implementations are
// responsible for: loading the repo's local_stack config, resolving
// the right profile for the specialist, running startup_commands +
// the profile's post_up before the specialist executes, and returning
// a teardown closure the caller invokes from `finally`.
//
// `prepare()` is a no-op for specialists with `needsLocalStack:
// false` — it returns an immediately-resolved teardown that does
// nothing. Callers always invoke the returned closure, regardless of
// whether the specialist needed the stack.
export interface LocalStackLifecycle {
  prepare(input: PrepareInput): Promise<LocalStackTeardown>;
}

export type PrepareInput = {
  specialist: ResolvedSpecialist;
  provisioned: ProvisionedSandbox;
  parentRepoRef: string | null;
};

const NOOP_TEARDOWN: LocalStackTeardown = async () => {
  // intentional no-op
};

// Test-injectable dependencies. Default values bind to the
// production implementations; the lifecycle factory below lets tests
// substitute any of them without touching the real DB / sandbox.
export type LifecycleDeps = {
  loadRepoConfig: (input: {
    repoFullName: string;
    workingDirectory: string;
    exec: LocalStackExec;
  }) => Promise<RepoConfig>;
  runStartup: (input: RunStartupInput) => Promise<void>;
  runTeardown: (input: RunTeardownInput) => Promise<LocalStackCommandError[]>;
};

const DEFAULT_LIFECYCLE_DEPS: LifecycleDeps = {
  loadRepoConfig: loadRepoConfigFromSandbox,
  runStartup: runLocalStackStartup,
  runTeardown: runLocalStackTeardown,
};

// Builds a LocalStackLifecycle bound to the supplied dependencies.
// Production code reaches the same behavior through
// `defaultLocalStackLifecycle` (which curries the default deps);
// tests pass custom stubs to drive partial-startup and
// teardown-failure paths without hitting the DB or a real sandbox.
export function createLocalStackLifecycle(
  overrides: Partial<LifecycleDeps> = {},
): LocalStackLifecycle {
  const deps: LifecycleDeps = { ...DEFAULT_LIFECYCLE_DEPS, ...overrides };
  return {
    prepare: (input) => prepare(deps, input),
  };
}

// Production default. Loads .nigel.yaml from the sandbox (with DB
// fallback), resolves the profile, runs startup. Returns a closure
// that runs teardown_commands when called and logs (without
// throwing) any teardown failures so they're observable but don't
// mask the original outcome.
export const defaultLocalStackLifecycle: LocalStackLifecycle =
  createLocalStackLifecycle();

async function prepare(
  deps: LifecycleDeps,
  { specialist, provisioned, parentRepoRef }: PrepareInput,
): Promise<LocalStackTeardown> {
  if (!specialist.needsLocalStack) return NOOP_TEARDOWN;
  if (!parentRepoRef) {
    throw new LocalStackPrepareError(
      `specialist '${specialist.name}' requires a local stack but the parent run has no repoRef`,
    );
  }
  const exec = bindExec(provisioned);
  let config: RepoConfig;
  try {
    config = await deps.loadRepoConfig({
      repoFullName: parentRepoRef,
      workingDirectory: provisioned.workingDirectory,
      exec,
    });
  } catch (err) {
    throw new LocalStackPrepareError(
      `failed to load repo config for '${parentRepoRef}'`,
      { cause: err },
    );
  }
  const localStack = config.local_stack;
  if (!localStack) {
    throw new LocalStackPrepareError(
      `specialist '${specialist.name}' requires a local stack but repo '${parentRepoRef}' has no local_stack block`,
    );
  }
  let profile: ResolvedProfile;
  try {
    const maybe = resolveProfile({ specialist, localStack });
    if (!maybe) {
      // resolveProfile only returns null when needsLocalStack is
      // false or a per-call `none` opt-out is set. Neither applies
      // here, so treat this as a contract violation.
      throw new LocalStackPrepareError(
        `local stack profile resolved to null for specialist '${specialist.name}'`,
      );
    }
    profile = maybe;
  } catch (err) {
    if (err instanceof LocalStackPrepareError) throw err;
    throw new LocalStackPrepareError(
      `failed to resolve local stack profile for '${specialist.name}'`,
      { cause: err },
    );
  }
  try {
    await deps.runStartup({
      exec,
      workingDirectory: provisioned.workingDirectory,
      localStack,
      profile,
    });
  } catch (err) {
    // Partial startup leaks otherwise: dispatch.ts only awaits the
    // teardown returned by a *successful* prepare(), so a throw here
    // means anything startup_commands already brought up never gets
    // torn down. Best-effort teardown before rethrowing — the
    // teardown sequence is designed to be safe to call even when
    // resources weren't fully provisioned.
    try {
      const failures = await deps.runTeardown({
        exec,
        workingDirectory: provisioned.workingDirectory,
        localStack,
      });
      if (failures.length > 0) {
        console.error(
          `[local-stack] post-failure teardown produced ${failures.length} failure(s) for repo '${parentRepoRef}'`,
          failures.map((f) => ({
            command: f.command,
            exitCode: f.exitCode,
            stderr: f.stderr.slice(0, 500),
          })),
        );
      }
    } catch (teardownErr) {
      console.error(
        `[local-stack] post-failure teardown threw for repo '${parentRepoRef}'; resources may be leaked`,
        teardownErr,
      );
    }
    throw new LocalStackPrepareError(
      `local stack startup failed for '${specialist.name}' (profile '${profile.name}')`,
      { cause: err },
    );
  }

  return async () => {
    try {
      const failures = await deps.runTeardown({
        exec,
        workingDirectory: provisioned.workingDirectory,
        localStack,
      });
      if (failures.length > 0) {
        console.error(
          `[local-stack] teardown produced ${failures.length} failure(s) for repo '${parentRepoRef}'; resources may be leaked`,
          failures.map((f) => ({
            command: f.command,
            exitCode: f.exitCode,
            stderr: f.stderr.slice(0, 500),
          })),
        );
      }
    } catch (err) {
      // The runner contract is "teardown must not throw" — it
      // collects LocalStackCommandError into the returned array
      // rather than escaping. Anything reaching this catch is a
      // contract violation (refactor regression, non-runner error)
      // that we must log unconditionally so it doesn't disappear
      // silently.
      console.error(
        `[local-stack] teardown threw for repo '${parentRepoRef}'; resources may be leaked`,
        err,
      );
    }
  };
}

function bindExec(provisioned: ProvisionedSandbox): LocalStackExec {
  return (command, cwd, timeoutMs, options) =>
    provisioned.sandbox.exec(command, cwd, timeoutMs, options);
}
