import type { ResolvedSpecialist } from "@/lib/specialists";
import type {
  RepoLocalStack,
  ResolvedPostUpStep,
  ResolvedProfile,
} from "./types";

export type ResolveProfileInput = {
  specialist: ResolvedSpecialist;
  dispatch?: { local_stack_profile?: string };
  check?: { local_stack_profile?: string };
  localStack: RepoLocalStack | null;
};

export class LocalStackProfileNotResolvedError extends Error {
  readonly specialistName: string;
  readonly chain: string[];
  constructor(specialistName: string, chain: string[], reason: string) {
    super(
      `local stack profile not resolved for specialist '${specialistName}': ${reason} (tried: ${chain.join(" -> ")})`,
    );
    this.name = "LocalStackProfileNotResolvedError";
    this.specialistName = specialistName;
    this.chain = chain;
  }
}

const NONE = "none";

export function resolveProfile(
  input: ResolveProfileInput,
): ResolvedProfile | null {
  const { specialist, dispatch, check, localStack } = input;

  if (!specialist.needsLocalStack) return null;

  // Per-call opt-out beats every other check, including a missing
  // local_stack block. A specialist that flags `needs_local_stack: true`
  // by default but is being dispatched with `none` must succeed even on
  // repos that haven't (or can't) declare a stack.
  if (dispatch?.local_stack_profile === NONE) return null;
  if (check?.local_stack_profile === NONE) return null;

  if (localStack === null) {
    throw new LocalStackProfileNotResolvedError(
      specialist.name,
      ["repo.local_stack"],
      "specialist requires a local stack but the repo's RepoConfig has no `local_stack` block",
    );
  }

  if (dispatch?.local_stack_profile) {
    return lookupOrThrow(dispatch.local_stack_profile, localStack, specialist, [
      "dispatch.local_stack_profile",
    ]);
  }

  if (check?.local_stack_profile) {
    return lookupOrThrow(check.local_stack_profile, localStack, specialist, [
      "check.local_stack_profile",
    ]);
  }

  return lookupOrThrow(localStack.default_profile, localStack, specialist, [
    "repo.default_profile",
  ]);
}

function lookupOrThrow(
  name: string,
  localStack: RepoLocalStack,
  specialist: ResolvedSpecialist,
  chain: string[],
): ResolvedProfile {
  const entry = localStack.profiles[name];
  if (!entry) {
    throw new LocalStackProfileNotResolvedError(
      specialist.name,
      chain,
      `profile '${name}' not found in repo.local_stack.profiles`,
    );
  }
  return {
    name,
    description: entry.description ?? null,
    postUp: entry.post_up.map(normalizePostUp),
  };
}

function normalizePostUp(
  step: RepoLocalStack["profiles"][string]["post_up"][number],
): ResolvedPostUpStep {
  if (typeof step === "string") {
    return { cmd: step, timeoutSeconds: null, retry: null };
  }
  return {
    cmd: step.cmd,
    timeoutSeconds: step.timeout_seconds ?? null,
    retry: step.retry ?? null,
  };
}
