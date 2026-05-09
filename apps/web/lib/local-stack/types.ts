import type { RepoConfig } from "@/lib/repo-config";

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
