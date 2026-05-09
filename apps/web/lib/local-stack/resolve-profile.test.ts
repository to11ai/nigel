import { describe, expect, test } from "bun:test";
import type { ResolvedSpecialist } from "@/lib/specialists";
import {
  LocalStackProfileNotResolvedError,
  resolveProfile,
} from "./resolve-profile";
import type { RepoLocalStack } from "./types";

const specialistNoStack = (): ResolvedSpecialist => ({
  name: "echo",
  kind: "scripted",
  systemPrompt: null,
  model: null,
  toolAllowlist: [],
  sandboxPolicy: "fresh",
  mayRecurse: false,
  maxChildren: 0,
  budgetUsdDefaultMicros: 0,
  needsLocalStack: false,
});

const specialistNeedsStack = (): ResolvedSpecialist => ({
  ...specialistNoStack(),
  name: "e2e-tester",
  needsLocalStack: true,
});

const sampleStack = (): RepoLocalStack => ({
  compose_file: "docker-compose.yaml",
  wait_for: [],
  teardown_on_exit: true,
  profiles: {
    bare: { description: "minimal", post_up: [] },
    onboarded: {
      description: "default users",
      post_up: ["bun run db:seed"],
    },
  },
  default_profile: "bare",
});

describe("resolveProfile", () => {
  test("returns null when specialist does not need a stack", () => {
    expect(
      resolveProfile({
        specialist: specialistNoStack(),
        localStack: sampleStack(),
      }),
    ).toBeNull();
  });

  test("returns null when specialist does not need a stack even if no local_stack defined", () => {
    expect(
      resolveProfile({
        specialist: specialistNoStack(),
        localStack: null,
      }),
    ).toBeNull();
  });

  test("throws when specialist needs a stack but repo has no local_stack", () => {
    expect(() =>
      resolveProfile({
        specialist: specialistNeedsStack(),
        localStack: null,
      }),
    ).toThrow(LocalStackProfileNotResolvedError);
  });

  test("dispatch override wins over check and default", () => {
    const profile = resolveProfile({
      specialist: specialistNeedsStack(),
      dispatch: { local_stack_profile: "onboarded" },
      check: { local_stack_profile: "bare" },
      localStack: sampleStack(),
    });
    expect(profile?.name).toBe("onboarded");
  });

  test("dispatch 'none' opts out", () => {
    expect(
      resolveProfile({
        specialist: specialistNeedsStack(),
        dispatch: { local_stack_profile: "none" },
        localStack: sampleStack(),
      }),
    ).toBeNull();
  });

  test("check override wins over default when no dispatch override", () => {
    const profile = resolveProfile({
      specialist: specialistNeedsStack(),
      check: { local_stack_profile: "onboarded" },
      localStack: sampleStack(),
    });
    expect(profile?.name).toBe("onboarded");
  });

  test("check 'none' opts out", () => {
    expect(
      resolveProfile({
        specialist: specialistNeedsStack(),
        check: { local_stack_profile: "none" },
        localStack: sampleStack(),
      }),
    ).toBeNull();
  });

  test("falls back to default_profile when no overrides", () => {
    const profile = resolveProfile({
      specialist: specialistNeedsStack(),
      localStack: sampleStack(),
    });
    expect(profile?.name).toBe("bare");
  });

  test("throws when dispatch references an unknown profile", () => {
    expect(() =>
      resolveProfile({
        specialist: specialistNeedsStack(),
        dispatch: { local_stack_profile: "missing" },
        localStack: sampleStack(),
      }),
    ).toThrow(LocalStackProfileNotResolvedError);
  });

  test("throws when check references an unknown profile", () => {
    expect(() =>
      resolveProfile({
        specialist: specialistNeedsStack(),
        check: { local_stack_profile: "missing" },
        localStack: sampleStack(),
      }),
    ).toThrow(LocalStackProfileNotResolvedError);
  });

  test("normalizes post_up entries (string and object) into ResolvedPostUpStep[]", () => {
    const stack: RepoLocalStack = {
      ...sampleStack(),
      profiles: {
        full: {
          description: "full",
          post_up: [
            "bun run db:migrate",
            { cmd: "bun run db:seed", timeout_seconds: 30, retry: 2 },
          ],
        },
      },
      default_profile: "full",
    };
    const profile = resolveProfile({
      specialist: specialistNeedsStack(),
      localStack: stack,
    });
    expect(profile?.postUp).toEqual([
      { cmd: "bun run db:migrate", timeoutSeconds: null, retry: null },
      { cmd: "bun run db:seed", timeoutSeconds: 30, retry: 2 },
    ]);
  });
});
