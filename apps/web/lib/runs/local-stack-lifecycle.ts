import {
  type LocalStackExec,
  LocalStackCommandError,
  type ResolvedProfile,
  resolveProfile,
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

// Production default. Loads .nigel.yaml from the sandbox (with DB
// fallback), resolves the profile, runs startup. Returns a closure
// that runs teardown_commands when called and logs (without
// throwing) any teardown failures so they're observable but don't
// mask the original outcome.
export const defaultLocalStackLifecycle: LocalStackLifecycle = {
  async prepare({ specialist, provisioned, parentRepoRef }) {
    if (!specialist.needsLocalStack) return NOOP_TEARDOWN;
    if (!parentRepoRef) {
      throw new LocalStackPrepareError(
        `specialist '${specialist.name}' requires a local stack but the parent run has no repoRef`,
      );
    }
    const exec = bindExec(provisioned);
    let config: RepoConfig;
    try {
      config = await loadRepoConfigFromSandbox({
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
      await runLocalStackStartup({
        exec,
        workingDirectory: provisioned.workingDirectory,
        localStack,
        profile,
      });
    } catch (err) {
      throw new LocalStackPrepareError(
        `local stack startup failed for '${specialist.name}' (profile '${profile.name}')`,
        { cause: err },
      );
    }

    return async () => {
      try {
        const failures = await runLocalStackTeardown({
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
        // Final defensive log. The contract is "teardown must not
        // throw"; we honor it even if a non-LocalStackCommandError
        // escapes the runner.
        if (!(err instanceof LocalStackCommandError)) {
          console.error(
            `[local-stack] teardown threw for repo '${parentRepoRef}'`,
            err,
          );
        }
      }
    };
  },
};

function bindExec(provisioned: ProvisionedSandbox): LocalStackExec {
  return (command, cwd, timeoutMs, options) =>
    provisioned.sandbox.exec(command, cwd, timeoutMs, options);
}
