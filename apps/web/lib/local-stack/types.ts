import type { RepoConfig } from "@/lib/repo-config";

// A `post_up` step in resolved form. Mirrors the Zod-inferred schema
// shape but flattened to a discriminated union for ergonomics.
export type PostUpStep =
  | { kind: "shell"; cmd: string }
  | {
      kind: "shell";
      cmd: string;
      timeoutSeconds?: number;
      retry?: number;
    };

// A profile after the resolver has picked one. The `name` is the profile's
// key in `local_stack.profiles`; callers use it for logs/snapshots.
export type ResolvedProfile = {
  name: string;
  description: string | null;
  postUp: ResolvedPostUpStep[];
};

export type ResolvedPostUpStep = {
  cmd: string;
  timeoutSeconds: number | null;
  retry: number | null;
};

// The local_stack block from a fully-validated RepoConfig. Non-null.
export type RepoLocalStack = NonNullable<RepoConfig["local_stack"]>;
