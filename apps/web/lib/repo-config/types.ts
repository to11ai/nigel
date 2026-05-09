import { z } from "zod";

const PostUpStepSchema = z.union([
  z.string(),
  z.object({
    cmd: z.string(),
    timeout_seconds: z.number().int().positive().optional(),
    retry: z.number().int().nonnegative().optional(),
  }),
]);

const ProfileSchema = z.object({
  description: z.string().optional(),
  post_up: z.array(PostUpStepSchema).optional().default([]),
});

const LocalStackSchema = z
  .object({
    compose_file: z.string(),
    wait_for: z
      .array(z.object({ service: z.string(), cmd: z.string() }))
      .optional()
      .default([]),
    env_file: z.string().optional(),
    startup_timeout_seconds: z.number().int().positive().optional(),
    teardown_on_exit: z.boolean().optional().default(true),
    profiles: z.record(z.string(), ProfileSchema),
    default_profile: z.string(),
  })
  .refine((s) => Object.hasOwn(s.profiles, s.default_profile), {
    message:
      "local_stack.default_profile must reference a key in local_stack.profiles",
    path: ["default_profile"],
  });

const CheckSchema = z.object({
  command: z.string().optional(),
  local_stack_profile: z.string().optional(),
  needs: z.array(z.string()).optional(),
});

const TurboSchema = z.object({
  enabled: z.boolean().optional(),
  remote_cache_token: z.string().optional(),
  affected: z.boolean().optional().default(false),
  task_map: z
    .object({
      lint: z.string().optional(),
      format: z.string().optional(),
      type_check: z.string().optional(),
      unit_test: z.string().optional(),
      e2e_test: z.string().optional(),
      dev: z.string().optional(),
    })
    .optional(),
});

export const RepoConfigSchema = z.object({
  version: z.literal(1),
  setup: z.array(z.string()).optional().default([]),
  dev_server: z
    .object({
      command: z.string().optional(),
      port: z.number().int().positive().optional(),
      ready_check: z.string().optional(),
      ready_timeout_seconds: z.number().int().positive().optional(),
    })
    .optional(),
  turbo: TurboSchema.optional(),
  checks: z
    .object({
      lint: CheckSchema.optional(),
      format: CheckSchema.optional(),
      type_check: CheckSchema.optional(),
      unit_test: CheckSchema.optional(),
      e2e_test: CheckSchema.optional(),
    })
    .strict()
    .optional(),
  local_stack: LocalStackSchema.optional(),
  routes_for_visual_prover: z
    .array(z.object({ path: z.string(), auth: z.enum(["none", "required"]) }))
    .optional(),
  frontend_globs: z.array(z.string()).optional(),
  monorepo: z
    .object({
      workspaces: z.array(z.string()),
      default_workspace: z.string().optional(),
    })
    .refine(
      (m) =>
        m.default_workspace === undefined ||
        m.workspaces.includes(m.default_workspace),
      {
        message:
          "monorepo.default_workspace must reference an entry in monorepo.workspaces",
        path: ["default_workspace"],
      },
    )
    .optional(),
});

export type RepoConfig = z.infer<typeof RepoConfigSchema>;

export type PackageJsonLike = {
  name?: string;
  workspaces?: string[] | { packages?: string[] };
};

export type TurboJsonLike = {
  tasks?: Record<string, unknown>;
};

export type RepoConfigSource = "file" | "db" | "inferred";

// The DB row's `source` cannot be "file" — the resolver short-circuits on a
// committed `.nigel.yaml` and never persists. Use this tighter type for any
// API that touches the stored column.
export type StoredRepoConfigSource = "db" | "inferred";

export type LoadRepoConfigResult =
  | { source: "file"; config: RepoConfig }
  | { source: "db"; config: RepoConfig }
  | { source: "inferred"; config: RepoConfig; warning: string };
