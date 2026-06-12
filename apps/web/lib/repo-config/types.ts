import { z } from "zod";

// A single command in a startup_commands / teardown_commands /
// post_up sequence. A plain string is the simple case; the object
// form lets a repo author bound a slow or flaky command with its own
// per-command timeout and retry count — provisioning Neon / Upstash /
// ClickHouse / etc. has the same transient-failure characteristics
// that motivated post_up's object shape.
const CommandStepSchema = z.union([
  z.string(),
  z.object({
    cmd: z.string(),
    timeout_seconds: z.number().int().positive().optional(),
    retry: z.number().int().nonnegative().optional(),
  }),
]);

export type CommandStep = z.infer<typeof CommandStepSchema>;

// Opt-in Docker bootstrap. Vercel Sandbox can host Docker (Firecracker
// microVM, full caps; added 2026-05-29), so a repo can run its real
// containers as backing services instead of provisioning cloud infra.
// When present, the runner installs + boots dockerd before any
// startup_commands; with `compose_file` set it also brings the stack up
// (and tears it down). Without `compose_file`, startup_commands drive
// docker directly.
const DockerSchema = z.object({
  // Path, relative to the working directory, to a compose file the runner
  // brings up with `docker compose ... up -d --wait` before
  // startup_commands and tears down on Run end.
  compose_file: z.string().optional(),
  // Mount the per-sandbox proxy CA into every compose service and export
  // the standard CA env vars (NODE_EXTRA_CA_CERTS / SSL_CERT_FILE /
  // REQUESTS_CA_BUNDLE / CURL_CA_BUNDLE). Containers do NOT inherit the
  // host trust store, so without this a container that reaches a firewall
  // transform-host fails TLS. Default on; opt out for stacks whose
  // containers never make such outbound HTTPS calls.
  mount_proxy_ca: z.boolean().optional().default(true),
  // Per-command cap for `dnf install -y docker` (default 180s).
  install_timeout_seconds: z.number().int().positive().optional(),
  // Cap for the `docker info` readiness poll after dockerd boots
  // (default 60s).
  ready_timeout_seconds: z.number().int().positive().optional(),
});

const ProfileSchema = z.object({
  description: z.string().optional(),
  post_up: z.array(CommandStepSchema).optional().default([]),
});

const LocalStackSchema = z
  .object({
    // Commands run once per Run, before any profile's post_up, to
    // provision the backing infra the repo needs. Each command is
    // responsible for its own readiness (no `wait_for` step; bake it
    // into the command). A repo wanting Postgres can either provision a
    // Neon branch (or whatever it uses in prod) via its own script, or —
    // since Vercel Sandbox added Docker support 2026-05-29 — install and
    // boot docker here and run a container. The command list supports both.
    startup_commands: z.array(CommandStepSchema).optional().default([]),
    teardown_commands: z.array(CommandStepSchema).optional().default([]),
    docker: DockerSchema.optional(),
    env_file: z.string().optional(),
    startup_timeout_seconds: z.number().int().positive().optional(),
    teardown_timeout_seconds: z.number().int().positive().optional(),
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

// Sandbox isolation for a phase. Mirrors `sandboxPolicySchema` in
// `@/lib/runs/types` (duplicated as a plain literal set so this pure-data
// module doesn't import the Drizzle-backed runs types). Keep in sync.
const PHASE_SANDBOX_POLICIES = ["inherit", "fresh", "fresh_clean"] as const;

// What happens when a phase's gate is not satisfied:
// - `stop`: halt the pipeline; the Run transitions to blocked /
//   awaiting_approval (a required gate the runner refuses to skip).
// - `continue`: record the failure and proceed to the next phase.
// - `repair`: dispatch `repair_with` to fix, then re-run the phase, up to
//   `max_repairs` times before treating it as a `stop`.
const GateSchema = z
  .object({
    required: z.boolean().optional().default(true),
    on_fail: z.enum(["stop", "continue", "repair"]).optional().default("stop"),
    max_repairs: z.number().int().positive().optional(),
    repair_with: z.string().min(1).optional(),
  })
  // `repair` is meaningless without a fixer to dispatch — the runner guards
  // the repair dispatch on `repair_with`, so a missing one would silently
  // degrade to re-running the same failing steps. Reject it at parse time.
  .refine((g) => g.on_fail !== "repair" || g.repair_with !== undefined, {
    message: 'gate.on_fail "repair" requires gate.repair_with',
    path: ["repair_with"],
  });

// A single specialist dispatch within a phase. `budget_usd` is authored in
// dollars (human-friendly); the runner converts to the micros the dispatch
// layer expects.
const PhaseStepSchema = z.object({
  specialist: z.string().min(1),
  sandbox_policy: z.enum(PHASE_SANDBOX_POLICIES).optional(),
  local_stack_profile: z.string().optional(),
  budget_usd: z.number().positive().optional(),
});

// One phase of the pipeline. Either a single specialist (fields inline) or a
// `parallel` fan-out of 2+ steps dispatched as concurrent child Runs. The
// `gate`/`when`/`independent` fields are the orchestration contract the
// pipeline runner enforces deterministically — they replace the planner's
// LLM discretion with code-enforced sequencing and gates.
const PhaseSchema = z
  .object({
    id: z.string().min(1),
    specialist: z.string().min(1).optional(),
    sandbox_policy: z.enum(PHASE_SANDBOX_POLICIES).optional(),
    local_stack_profile: z.string().optional(),
    budget_usd: z.number().positive().optional(),
    parallel: z.array(PhaseStepSchema).min(2).optional(),
    // Force an isolated, context-free sandbox (fresh_clean) regardless of
    // sandbox_policy — the in-code guarantee behind independent validation.
    independent: z.boolean().optional().default(false),
    // Predicate gating whether this phase runs at all (e.g.
    // `touches_frontend`, `classification:bug`). Evaluated by the runner's
    // predicate registry; unknown predicates fail closed (phase skipped).
    when: z.string().optional(),
    // Store this phase's output under the runner context for later `when`
    // checks and task templating.
    sets: z.string().optional(),
    gate: GateSchema.optional(),
  })
  .refine((p) => (p.specialist === undefined) !== (p.parallel === undefined), {
    message: "phase must set exactly one of `specialist` or `parallel`",
    path: ["specialist"],
  });

const PipelineSchema = z
  .object({
    phases: z.array(PhaseSchema).min(1),
    on_terminal: z
      .object({
        babysit: z.boolean().optional().default(false),
        finalize: z
          .object({
            teardown: z.boolean().optional().default(false),
            linear_done: z.boolean().optional().default(false),
            delete_branch: z.boolean().optional().default(false),
          })
          .optional(),
      })
      .optional(),
  })
  .refine(
    (p) => new Set(p.phases.map((ph) => ph.id)).size === p.phases.length,
    { message: "pipeline phase ids must be unique", path: ["phases"] },
  );

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
  // Declarative phase pipeline. When present, the Run executes these phases
  // in order (with gates) instead of handing the whole task to the planner.
  // Omitted → the runtime falls back to the single-planner default.
  pipeline: PipelineSchema.optional(),
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
export type Pipeline = z.infer<typeof PipelineSchema>;
export type PipelinePhase = z.infer<typeof PhaseSchema>;
export type PipelinePhaseStep = z.infer<typeof PhaseStepSchema>;

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
