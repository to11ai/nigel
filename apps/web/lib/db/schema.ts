import { sql } from "drizzle-orm";
import type { SandboxState } from "@nigel/sandbox";
import type { ModelVariant } from "@/lib/model-variants";
import type { RepoConfig } from "@/lib/repo-config/types";
import type { GlobalSkillRef } from "@/lib/skills/global-skill-refs";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// users
export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    username: text("username").notNull(),
    email: text("email"),
    emailVerified: boolean("email_verified").notNull().default(false),
    name: text("name"),
    avatarUrl: text("avatar_url"),
    isAdmin: boolean("is_admin").notNull().default(false),
    // Linear user ID, set when the user authenticates via Linear OAuth
    // (Phase 6 L5) or when an admin manually maps a user. Phase 6 L2
    // looks this up during webhook handling to resolve `event.actor`
    // → Nigel `humanOwnerId`. Nullable because most users never get a
    // Linear identity associated with their Nigel account.
    linearUserId: text("linear_user_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    lastLoginAt: timestamp("last_login_at").defaultNow().notNull(),
  },
  (table) => [
    // Partial unique on Linear ID — multiple rows with NULL are
    // allowed (most users don't have a Linear identity) but two
    // users with the same non-null Linear ID would corrupt
    // actor-resolution and is rejected at write time.
    uniqueIndex("users_linear_user_id_idx")
      .on(table.linearUserId)
      .where(sql`${table.linearUserId} IS NOT NULL`),
  ],
);

// oauth provider accounts
export const accounts = pgTable("accounts", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// better-auth sessions
export const authSessions = pgTable("auth_sessions", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
});

// better-auth verification tokens
export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const githubInstallations = pgTable(
  "github_installations",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    installationId: integer("installation_id").notNull(),
    accountLogin: text("account_login").notNull(),
    accountType: text("account_type", {
      enum: ["User", "Organization"],
    }).notNull(),
    repositorySelection: text("repository_selection", {
      enum: ["all", "selected"],
    }).notNull(),
    installationUrl: text("installation_url"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("github_installations_user_installation_idx").on(
      table.userId,
      table.installationId,
    ),
    uniqueIndex("github_installations_user_account_idx").on(
      table.userId,
      table.accountLogin,
    ),
  ],
);

export const vercelProjectLinks = pgTable(
  "vercel_project_links",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    repoOwner: text("repo_owner").notNull(),
    repoName: text("repo_name").notNull(),
    projectId: text("project_id").notNull(),
    projectName: text("project_name").notNull(),
    teamId: text("team_id"),
    teamSlug: text("team_slug"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.userId, table.repoOwner, table.repoName],
    }),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    status: text("status", {
      enum: ["running", "completed", "failed", "archived"],
    })
      .notNull()
      .default("running"),
    // Repository info
    repoOwner: text("repo_owner"),
    repoName: text("repo_name"),
    branch: text("branch"),
    cloneUrl: text("clone_url"),
    vercelProjectId: text("vercel_project_id"),
    vercelProjectName: text("vercel_project_name"),
    vercelTeamId: text("vercel_team_id"),
    vercelTeamSlug: text("vercel_team_slug"),
    // Whether this session uses a new auto-generated branch
    isNewBranch: boolean("is_new_branch").default(false).notNull(),
    // Optional per-session override for auto commit + push behavior.
    // null means "use the user's default preference".
    autoCommitPushOverride: boolean("auto_commit_push_override"),
    // Optional per-session override for auto PR creation after auto-commit.
    // null means "use the user's default preference".
    autoCreatePrOverride: boolean("auto_create_pr_override"),
    globalSkillRefs: jsonb("global_skill_refs")
      .$type<GlobalSkillRef[]>()
      .notNull()
      .default([]),
    // Unified sandbox state
    sandboxState: jsonb("sandbox_state").$type<SandboxState>(),
    // Lifecycle orchestration state for sandbox management
    lifecycleState: text("lifecycle_state", {
      enum: [
        "provisioning",
        "active",
        "hibernating",
        "hibernated",
        "restoring",
        "archived",
        "failed",
      ],
    }),
    lifecycleVersion: integer("lifecycle_version").notNull().default(0),
    lastActivityAt: timestamp("last_activity_at"),
    sandboxExpiresAt: timestamp("sandbox_expires_at"),
    hibernateAfter: timestamp("hibernate_after"),
    lifecycleRunId: text("lifecycle_run_id"),
    lifecycleError: text("lifecycle_error"),
    // Git stats (for display in session list)
    linesAdded: integer("lines_added").default(0),
    linesRemoved: integer("lines_removed").default(0),
    // PR info if created
    prNumber: integer("pr_number"),
    prStatus: text("pr_status", {
      enum: ["open", "merged", "closed"],
    }),
    // Snapshot info (for cached snapshots feature)
    snapshotUrl: text("snapshot_url"),
    snapshotCreatedAt: timestamp("snapshot_created_at"),
    snapshotSizeBytes: integer("snapshot_size_bytes"),
    // Cached diff for offline viewing
    cachedDiff: jsonb("cached_diff"),
    cachedDiffUpdatedAt: timestamp("cached_diff_updated_at"),
    // Timestamps
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [index("sessions_user_id_idx").on(table.userId)],
);

export const chats = pgTable(
  "chats",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    modelId: text("model_id").default("openai/gpt-5-codex"),
    activeStreamId: text("active_stream_id"),
    lastAssistantMessageAt: timestamp("last_assistant_message_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [index("chats_session_id_idx").on(table.sessionId)],
);

export const shares = pgTable(
  "shares",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [uniqueIndex("shares_chat_id_idx").on(table.chatId)],
);

export const chatMessages = pgTable("chat_messages", {
  id: text("id").primaryKey(),
  chatId: text("chat_id")
    .notNull()
    .references(() => chats.id, { onDelete: "cascade" }),
  role: text("role", {
    enum: ["user", "assistant"],
  }).notNull(),
  // Store the full message parts as JSON for flexibility
  parts: jsonb("parts").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const chatReads = pgTable(
  "chat_reads",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    lastReadAt: timestamp("last_read_at").notNull().defaultNow(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.chatId] }),
    index("chat_reads_chat_id_idx").on(table.chatId),
  ],
);

export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    modelId: text("model_id"),
    status: text("status", {
      enum: ["completed", "aborted", "failed"],
    }).notNull(),
    startedAt: timestamp("started_at").notNull(),
    finishedAt: timestamp("finished_at").notNull(),
    totalDurationMs: integer("total_duration_ms").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("workflow_runs_chat_id_idx").on(table.chatId),
    index("workflow_runs_session_id_idx").on(table.sessionId),
    index("workflow_runs_user_id_idx").on(table.userId),
  ],
);

export const workflowRunSteps = pgTable(
  "workflow_run_steps",
  {
    id: text("id").primaryKey(),
    workflowRunId: text("workflow_run_id")
      .notNull()
      .references(() => workflowRuns.id, { onDelete: "cascade" }),
    stepNumber: integer("step_number").notNull(),
    startedAt: timestamp("started_at").notNull(),
    finishedAt: timestamp("finished_at").notNull(),
    durationMs: integer("duration_ms").notNull(),
    finishReason: text("finish_reason"),
    rawFinishReason: text("raw_finish_reason"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("workflow_run_steps_run_id_idx").on(table.workflowRunId),
    uniqueIndex("workflow_run_steps_run_step_idx").on(
      table.workflowRunId,
      table.stepNumber,
    ),
  ],
);

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type VercelProjectLink = typeof vercelProjectLinks.$inferSelect;
export type NewVercelProjectLink = typeof vercelProjectLinks.$inferInsert;
export type Chat = typeof chats.$inferSelect;
export type NewChat = typeof chats.$inferInsert;
export type Share = typeof shares.$inferSelect;
export type NewShare = typeof shares.$inferInsert;
export type ChatMessage = typeof chatMessages.$inferSelect;
export type NewChatMessage = typeof chatMessages.$inferInsert;
export type ChatRead = typeof chatReads.$inferSelect;
export type NewChatRead = typeof chatReads.$inferInsert;
export type WorkflowRun = typeof workflowRuns.$inferSelect;
export type NewWorkflowRun = typeof workflowRuns.$inferInsert;
export type WorkflowRunStep = typeof workflowRunSteps.$inferSelect;
export type NewWorkflowRunStep = typeof workflowRunSteps.$inferInsert;
export type GitHubInstallation = typeof githubInstallations.$inferSelect;
export type NewGitHubInstallation = typeof githubInstallations.$inferInsert;

// agent_runs — the unifying execution primitive (Phase 1).
// One row per agent execution: top-level (chat, linear-triggered, cron) or
// chained sub-agent. Tree structure via parent_run_id; root_run_id is
// denormalized for cost-rollup queries.
export const agentRuns = pgTable(
  "agent_runs",
  {
    id: text("id").primaryKey(),
    parentRunId: text("parent_run_id"),
    rootRunId: text("root_run_id").notNull(),
    depth: integer("depth").notNull().default(0),

    triggerSource: text("trigger_source", {
      enum: ["chat", "linear", "chained", "cron"],
    }).notNull(),
    triggerRef: text("trigger_ref"),

    specialistId: text("specialist_id"),
    sandboxPolicy: text("sandbox_policy", {
      enum: ["inherit", "fresh", "fresh_clean"],
    })
      .notNull()
      .default("inherit"),

    humanOwnerId: text("human_owner_id").references(() => users.id, {
      onDelete: "set null",
    }),

    repoRef: text("repo_ref"),
    sandboxId: text("sandbox_id"),
    workflowRunId: text("workflow_run_id"),
    chatId: text("chat_id").references(() => chats.id, {
      onDelete: "set null",
    }),

    // bigint to allow >$2k caps; mode:"number" keeps the JS surface as
    // `number` since per-run costs comfortably fit in a double's 53-bit
    // safe-integer range (max safe int ≈ $9 quadrillion micros).
    budgetUsdCapMicros: bigint("budget_usd_cap_micros", { mode: "number" })
      .notNull()
      .default(0),
    costUsdActualMicros: bigint("cost_usd_actual_micros", { mode: "number" })
      .notNull()
      .default(0),

    status: text("status", {
      enum: [
        "pending",
        "running",
        "blocked",
        "awaiting_approval",
        "completed",
        "failed",
        "cancelled",
      ],
    })
      .notNull()
      .default("pending"),
    blockedReason: text("blocked_reason"),

    approvalRequired: boolean("approval_required").notNull().default(false),
    approvedBy: text("approved_by").references(() => users.id, {
      onDelete: "set null",
    }),
    approvedAt: timestamp("approved_at"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    startedAt: timestamp("started_at"),
    endedAt: timestamp("ended_at"),
  },
  (table) => [
    index("agent_runs_parent_idx").on(table.parentRunId),
    index("agent_runs_root_idx").on(table.rootRunId),
    index("agent_runs_owner_idx").on(table.humanOwnerId),
    index("agent_runs_chat_idx").on(table.chatId),
    index("agent_runs_workflow_idx").on(table.workflowRunId),
    index("agent_runs_status_idx").on(table.status),
    index("agent_runs_trigger_idx").on(table.triggerSource),
  ],
);

// run_messages — chat/conversation messages owned by a Run.
// In Phase 1 the chat path keeps writing to chat_messages; this table is the
// landing zone for messages emitted by sub-agents and future trigger sources.
export const runMessages = pgTable(
  "run_messages",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["user", "assistant", "system"] }).notNull(),
    parts: jsonb("parts").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("run_messages_run_idx").on(table.runId)],
);

// run_tool_calls — record of every tool invocation under a Run, with its
// cost and outcome. Phase 1 writes are limited to the new chat path when
// the feature flag is on; Phase 2+ adds the dispatch_specialist tool.
export const runToolCalls = pgTable(
  "run_tool_calls",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    toolKind: text("tool_kind").notNull(),
    toolName: text("tool_name").notNull(),
    input: jsonb("input"),
    output: jsonb("output"),
    success: boolean("success"),
    costUsdMicros: bigint("cost_usd_micros", { mode: "number" })
      .notNull()
      .default(0),
    latencyMs: integer("latency_ms"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("run_tool_calls_run_idx").on(table.runId)],
);

// run_artifacts — files, screenshots, logs, pulumi previews, etc. produced
// by a Run. Phase 1 is the table only; producers come in later phases.
export const runArtifacts = pgTable(
  "run_artifacts",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    rootRunId: text("root_run_id").notNull(),
    kind: text("kind", {
      enum: ["screenshot", "html", "log", "file", "pulumi_preview"],
    }).notNull(),
    path: text("path").notNull(),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("run_artifacts_run_idx").on(table.runId),
    index("run_artifacts_root_idx").on(table.rootRunId),
    index("run_artifacts_kind_idx").on(table.kind),
  ],
);

// webhook_events — idempotency log for inbound webhooks (Linear in Phase 6,
// reserved here so the schema is stable). Unique constraint on (source,
// external_id) prevents double-processing.
export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: text("id").primaryKey(),
    source: text("source").notNull(),
    externalId: text("external_id").notNull(),
    receivedAt: timestamp("received_at").defaultNow().notNull(),
    processedAt: timestamp("processed_at"),
    runId: text("run_id").references(() => agentRuns.id, {
      onDelete: "set null",
    }),
  },
  (table) => [
    uniqueIndex("webhook_events_source_external_idx").on(
      table.source,
      table.externalId,
    ),
  ],
);

export type WebhookEvent = typeof webhookEvents.$inferSelect;
export type NewWebhookEvent = typeof webhookEvents.$inferInsert;

// specialists — admin-managed registry. Two kinds:
//   - "custom": admin-created role with no code counterpart. All fields
//     populated.
//   - "override": admin tweak to a code preset (lib/specialists/presets.ts).
//     Only `fields` populated — non-null entries override the preset.
// Resolution order at runtime: code preset > override (merged) > custom.
// `name` must match the code preset's name when kind='override'.
export const specialists = pgTable(
  "specialists",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    kind: text("kind", { enum: ["custom", "override"] }).notNull(),

    systemPrompt: text("system_prompt"),
    model: text("model"),
    toolAllowlist: jsonb("tool_allowlist").$type<string[]>(),
    sandboxPolicy: text("sandbox_policy", {
      enum: ["inherit", "fresh", "fresh_clean"],
    }),
    mayRecurse: boolean("may_recurse"),
    maxChildren: integer("max_children"),
    budgetUsdDefaultMicros: bigint("budget_usd_default_micros", {
      mode: "number",
    }),
    needsLocalStack: boolean("needs_local_stack"),

    createdBy: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("specialists_name_idx").on(table.name),
    index("specialists_kind_idx").on(table.kind),
  ],
);

// repo_configs — DB fallback for repos without a .nigel.yaml committed.
// Populated either by admin via UI ('db' source) or auto-inferred from
// package.json / turbo.json on first encounter ('inferred' source).
// The resolver always prefers a checked-in `.nigel.yaml` over either DB row.
export const repoConfigs = pgTable(
  "repo_configs",
  {
    id: text("id").primaryKey(),
    repoFullName: text("repo_full_name").notNull(),
    configJson: jsonb("config_json").$type<RepoConfig>().notNull(),
    // The resolver short-circuits on a committed `.nigel.yaml` and never
    // persists a "file" row; only `db` (admin-set) or `inferred` (auto-detected)
    // sources are valid here.
    source: text("source", { enum: ["db", "inferred"] }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("repo_configs_repo_full_name_idx").on(table.repoFullName),
  ],
);

// sandbox_snapshots — cache of local-stack bootstrap states. A row records
// the upstream Vercel Sandbox snapshot id captured after `compose up` +
// post-up scripts ran successfully, keyed by repo + profile + a hash over
// the files that, if changed, force a fresh bootstrap (compose file,
// lockfile, migration files, seed scripts). The set of files contributing
// to `invalidation_keys` is the caller's choice; the cache lookup compares
// the full hash, not individual entries.
export const sandboxSnapshots = pgTable(
  "sandbox_snapshots",
  {
    id: text("id").primaryKey(),
    repoFullName: text("repo_full_name").notNull(),
    branchOrSha: text("branch_or_sha").notNull(),
    profile: text("profile").notNull(),
    baseSnapshotId: text("base_snapshot_id"),
    invalidationKeys: jsonb("invalidation_keys")
      .$type<Record<string, string>>()
      .notNull(),
    keysHash: text("keys_hash").notNull(),
    builtAt: timestamp("built_at").defaultNow().notNull(),
    ttlUntil: timestamp("ttl_until"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
  },
  (table) => [
    uniqueIndex("sandbox_snapshots_lookup_idx").on(
      table.repoFullName,
      table.profile,
      table.keysHash,
    ),
    index("sandbox_snapshots_built_at_idx").on(table.builtAt),
  ],
);

// User preferences for settings
export const userPreferences = pgTable("user_preferences", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  defaultModelId: text("default_model_id").default("openai/gpt-5-codex"),
  defaultSubagentModelId: text("default_subagent_model_id"),
  defaultSandboxType: text("default_sandbox_type", {
    enum: ["vercel"],
  }).default("vercel"),
  defaultDiffMode: text("default_diff_mode", {
    enum: ["unified", "split"],
  }).default("unified"),
  autoCommitPush: boolean("auto_commit_push").notNull().default(false),
  autoCreatePr: boolean("auto_create_pr").notNull().default(false),
  alertsEnabled: boolean("alerts_enabled").notNull().default(true),
  alertSoundEnabled: boolean("alert_sound_enabled").notNull().default(true),
  publicUsageEnabled: boolean("public_usage_enabled").notNull().default(false),
  globalSkillRefs: jsonb("global_skill_refs")
    .$type<GlobalSkillRef[]>()
    .notNull()
    .default([]),
  modelVariants: jsonb("model_variants")
    .$type<ModelVariant[]>()
    .notNull()
    .default([]),
  enabledModelIds: jsonb("enabled_model_ids")
    .$type<string[]>()
    .notNull()
    .default([]),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type UserPreferences = typeof userPreferences.$inferSelect;
export type NewUserPreferences = typeof userPreferences.$inferInsert;

// Usage tracking — one row per assistant turn (append-only)
export const usageEvents = pgTable("usage_events", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  // `source` mirrors `agent_runs.trigger_source` so Linear / cron /
  // chained runs land alongside chat ("web") activity. TypeScript
  // enum was originally `["web"]` only because the table was
  // populated solely by the chat path; the DB column is plain text
  // and accepts any string. The run-persistence layer (added when
  // Phase 7-visibility shipped) stamps "linear", "chained", etc.
  source: text("source").notNull().default("web"),
  // "specialist" added for Linear-triggered planner + child runs
  // that flow through `executeSpecialistViaLLM`.
  agentType: text("agent_type").notNull().default("main"),
  provider: text("provider"),
  modelId: text("model_id"),
  inputTokens: integer("input_tokens").notNull().default(0),
  cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  toolCallCount: integer("tool_call_count").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type UsageEvent = typeof usageEvents.$inferSelect;
export type NewUsageEvent = typeof usageEvents.$inferInsert;

// tool_connections — admin-managed registry of named credential bundles
// used by agent tools (database query, MCP server, Slack webhook, etc.).
// Non-secret config (host, server URL, dbname) lives in `configJson` so
// it's queryable; the secret half (password, API token, signing key)
// is stored as AES-256-GCM ciphertext in `secretsCiphertext` and
// decrypted only when the tool actually executes. Encryption key comes
// from TOOL_CONNECTIONS_ENC_KEY at runtime; rotating the key requires
// a re-encrypt migration (not in scope here).
//
// `scope` controls which runs may select a connection. `"global"`
// means any specialist can resolve it; `"specialist:<name>"` ties the
// connection to a single preset. We keep the field a plain string
// rather than enum'ing it so future scope schemes (per-repo, per-
// human-owner) don't need a migration.
export const toolConnections = pgTable(
  "tool_connections",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    kind: text("kind", {
      enum: ["postgres", "clickhouse", "redis", "mcp", "slack"],
    }).notNull(),
    description: text("description"),
    configJson: jsonb("config_json").notNull(),
    secretsCiphertext: text("secrets_ciphertext").notNull(),
    secretsNonce: text("secrets_nonce").notNull(),
    secretsAuthTag: text("secrets_auth_tag").notNull(),
    keyVersion: integer("key_version").notNull().default(1),
    scope: text("scope").notNull().default("global"),
    createdBy: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("tool_connections_name_idx").on(table.name),
    index("tool_connections_kind_idx").on(table.kind),
    index("tool_connections_scope_idx").on(table.scope),
  ],
);

export type ToolConnection = typeof toolConnections.$inferSelect;
export type NewToolConnection = typeof toolConnections.$inferInsert;

// linear_workspace — the Nigel deployment's Linear integration row.
// Phase 6 spec: "Linear integration is org-level; one Linear workspace
// per Nigel deployment." There is at most one row here; enforced via a
// unique constraint on `workspace_id` plus the convention that admin
// UI updates the existing row rather than inserting new ones.
//
// Encryption: secrets (OAuth access token, webhook signing secret) are
// AES-256-GCM encrypted at rest using the same `TOOL_CONNECTIONS_ENC_KEY`
// the tool_connections rows use. Reusing the key keeps the operator
// surface flat — one key to rotate, one Pulumi secret to provision.
// `secrets_ciphertext` holds the JSON payload `{ webhookSecret,
// accessToken, ...rotation_metadata }` rather than separate columns
// per field, mirroring the tool_connections shape so the
// encryption/decryption code path is shared.
//
// `team_repo_map` is the Linear team → GitHub repo binding used during
// webhook handling (see spec section 3, repo-resolution chain). Plain
// JSONB because it's not sensitive — anyone with DB access can already
// read which repos this deployment talks to.
export const linearWorkspace = pgTable(
  "linear_workspace",
  {
    id: text("id").primaryKey(),
    // Linear's own opaque workspace ID. Unique because we only support
    // one workspace per deployment; a second row with the same
    // workspace_id is a config bug, not a use case.
    workspaceId: text("workspace_id").notNull(),
    // The Linear user ID whose assignment triggers a Nigel Run. Set
    // once during OAuth + bot-user pairing in /admin/linear.
    botUserId: text("bot_user_id").notNull(),
    secretsCiphertext: text("secrets_ciphertext").notNull(),
    secretsNonce: text("secrets_nonce").notNull(),
    secretsAuthTag: text("secrets_auth_tag").notNull(),
    keyVersion: integer("key_version").notNull().default(1),
    // {linear_team_id: "owner/repo"}. Empty {} is valid — repo
    // resolution falls back to the issue's native GitHub link or a
    // `repo:owner/name` label when the team isn't mapped.
    teamRepoMap: jsonb("team_repo_map").notNull().default({}),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("linear_workspace_workspace_id_idx").on(table.workspaceId),
  ],
);

export type LinearWorkspace = typeof linearWorkspace.$inferSelect;
export type NewLinearWorkspace = typeof linearWorkspace.$inferInsert;
