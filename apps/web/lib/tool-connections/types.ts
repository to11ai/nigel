import { z } from "zod";

// Non-secret config shapes per connection kind. Anything sensitive
// (password, token, signing secret) is encrypted into
// `secretsCiphertext` instead. These schemas validate the public
// half on insert/update so the resolver can trust the data it
// reads back.

const PostgresConfigSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().positive().max(65535).default(5432),
  database: z.string().min(1),
  user: z.string().min(1),
  // SSL mode follows libpq conventions. `require` is the default
  // because most cloud Postgres providers require TLS; admins can
  // explicitly downgrade for local dev databases.
  sslMode: z
    .enum(["disable", "require", "verify-ca", "verify-full"])
    .default("require"),
  // Optional read-only enforcement marker. Tools that consume the
  // connection (e.g. `database_query`) may refuse write statements
  // when this is true. Independent of any role-level grants in the
  // database itself.
  readOnly: z.boolean().default(true),
  // Per-call defaults. Tools that don't override these use them as
  // the upper bound on resource use.
  defaultStatementTimeoutMs: z.number().int().positive().default(30_000),
  defaultRowLimit: z.number().int().positive().default(1000),
});

const PostgresSecretsSchema = z.object({
  password: z.string().min(1),
});

const ClickhouseConfigSchema = z.object({
  host: z.string().min(1),
  // ClickHouse's HTTP interface defaults to 8123 (cleartext) and 8443
  // (TLS). The kind's transport is HTTP either way; `protocol` picks
  // between them so operators don't have to remember the port.
  protocol: z.enum(["http", "https"]).default("https"),
  port: z.number().int().positive().max(65535).default(8443),
  database: z.string().min(1),
  user: z.string().min(1),
  // Same intent as Postgres' read-only marker. ClickHouse enforces
  // this server-side via the `readonly=2` setting (passed in the URL
  // query string by `runs/clickhouse-query.ts`), so a misbehaving
  // caller can't bypass it even if our prompt-side keyword scan
  // misses something. `readonly=2` blocks DML / DDL / admin while
  // still permitting per-request setting overrides like
  // `max_result_rows` and `max_execution_time` — `readonly=1` would
  // additionally block those overrides and break every query.
  readOnly: z.boolean().default(true),
  defaultStatementTimeoutMs: z.number().int().positive().default(60_000),
  defaultRowLimit: z.number().int().positive().default(1000),
});

const ClickhouseSecretsSchema = z.object({
  password: z.string().min(1),
});

// Two distinct transport shapes for MCP servers. Modeled as a
// discriminated union so the schema rejects nonsense rows at insert
// time — an `http` row without `url` or a `stdio` row without
// `command` would otherwise pass validation and only fail when a
// consumer tries to use it.
const McpHttpConfigSchema = z.object({
  transport: z.literal("http"),
  // URL the MCP client POSTs to.
  url: z.string().url(),
  defaultTimeoutMs: z.number().int().positive().default(60_000),
});

const McpStdioConfigSchema = z.object({
  transport: z.literal("stdio"),
  // Command + args to spawn. Used only for trusted first-party MCP
  // servers — never user-provided binaries.
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  defaultTimeoutMs: z.number().int().positive().default(60_000),
});

const McpConfigSchema = z.discriminatedUnion("transport", [
  McpHttpConfigSchema,
  McpStdioConfigSchema,
]);

const McpSecretsSchema = z.object({
  // HTTP transport typically carries an OAuth/bearer token; stdio
  // transport rarely needs one but allow for sidecar credentials.
  // Both fields are optional so an unauthenticated dev MCP server
  // can still be represented — callers who don't have a token
  // should omit the field entirely. An empty string is rejected
  // because it'd ship as a literal "Authorization: Bearer " header
  // that produces a baffling 401 only when the tool runs.
  bearerToken: z.string().min(1).optional(),
  // Free-form key/value bag for transports that need extra headers
  // or environment variables (e.g. `GITHUB_TOKEN`, `LINEAR_API_KEY`).
  // Stored encrypted alongside the bearer token. Empty keys / values
  // are rejected for the same reason as `bearerToken`.
  env: z.record(z.string().min(1), z.string().min(1)).optional(),
});

const SlackConfigSchema = z.object({
  // Channel ID or webhook target description. The webhook URL itself
  // is a secret (it carries authentication).
  channel: z.string().min(1),
  // Optional bot display name override. Empty strings are rejected
  // (same rationale as the MCP optionals): callers who don't want a
  // custom name should omit the field.
  username: z.string().min(1).optional(),
});

const SlackSecretsSchema = z.object({
  webhookUrl: z.string().url(),
});

export const TOOL_CONNECTION_KINDS = [
  "postgres",
  "clickhouse",
  "mcp",
  "slack",
] as const;
export type ToolConnectionKind = (typeof TOOL_CONNECTION_KINDS)[number];

const KIND_CONFIG_SCHEMAS = {
  postgres: PostgresConfigSchema,
  clickhouse: ClickhouseConfigSchema,
  mcp: McpConfigSchema,
  slack: SlackConfigSchema,
} as const;

const KIND_SECRETS_SCHEMAS = {
  postgres: PostgresSecretsSchema,
  clickhouse: ClickhouseSecretsSchema,
  mcp: McpSecretsSchema,
  slack: SlackSecretsSchema,
} as const;

export type PostgresConnectionConfig = z.infer<typeof PostgresConfigSchema>;
export type PostgresConnectionSecrets = z.infer<typeof PostgresSecretsSchema>;
export type ClickhouseConnectionConfig = z.infer<typeof ClickhouseConfigSchema>;
export type ClickhouseConnectionSecrets = z.infer<
  typeof ClickhouseSecretsSchema
>;
export type McpConnectionConfig = z.infer<typeof McpConfigSchema>;
export type McpConnectionSecrets = z.infer<typeof McpSecretsSchema>;
export type SlackConnectionConfig = z.infer<typeof SlackConfigSchema>;
export type SlackConnectionSecrets = z.infer<typeof SlackSecretsSchema>;

// Tagged discriminated union of (config, secrets) keyed on kind. The
// resolver hands one of these back to a tool, fully validated.
// `scope` is the parsed shape (not the raw string column) so callers
// can match without re-parsing on every tool invocation.
export type ResolvedConnection =
  | {
      id: string;
      name: string;
      kind: "postgres";
      scope: ToolConnectionScope;
      config: PostgresConnectionConfig;
      secrets: PostgresConnectionSecrets;
    }
  | {
      id: string;
      name: string;
      kind: "clickhouse";
      scope: ToolConnectionScope;
      config: ClickhouseConnectionConfig;
      secrets: ClickhouseConnectionSecrets;
    }
  | {
      id: string;
      name: string;
      kind: "mcp";
      scope: ToolConnectionScope;
      config: McpConnectionConfig;
      secrets: McpConnectionSecrets;
    }
  | {
      id: string;
      name: string;
      kind: "slack";
      scope: ToolConnectionScope;
      config: SlackConnectionConfig;
      secrets: SlackConnectionSecrets;
    };

// Single error class for every shape-level validation failure so this
// file stays under the "one class per file" lint rule. Discriminate
// via `code` to react to a specific cause.
export class ToolConnectionValidationError extends Error {
  readonly code: "config" | "secrets" | "scope";
  readonly kind?: string;
  readonly issues?: z.ZodIssue[];
  constructor(input: {
    code: "config" | "secrets" | "scope";
    message: string;
    kind?: string;
    issues?: z.ZodIssue[];
  }) {
    super(input.message);
    this.name = "ToolConnectionValidationError";
    this.code = input.code;
    if (input.kind !== undefined) this.kind = input.kind;
    if (input.issues !== undefined) this.issues = input.issues;
  }
}

export function validateConfigForKind<K extends ToolConnectionKind>(
  kind: K,
  config: unknown,
): z.infer<(typeof KIND_CONFIG_SCHEMAS)[K]> {
  const schema = KIND_CONFIG_SCHEMAS[kind];
  const result = schema.safeParse(config);
  if (!result.success) {
    throw new ToolConnectionValidationError({
      code: "config",
      kind,
      issues: result.error.issues,
      message: `tool_connections.config_json for kind '${kind}' failed validation: ${formatIssues(result.error.issues)}`,
    });
  }
  return result.data as z.infer<(typeof KIND_CONFIG_SCHEMAS)[K]>;
}

export function validateSecretsForKind<K extends ToolConnectionKind>(
  kind: K,
  secrets: unknown,
): z.infer<(typeof KIND_SECRETS_SCHEMAS)[K]> {
  const schema = KIND_SECRETS_SCHEMAS[kind];
  const result = schema.safeParse(secrets);
  if (!result.success) {
    throw new ToolConnectionValidationError({
      code: "secrets",
      kind,
      issues: result.error.issues,
      message: `tool_connections secrets payload for kind '${kind}' failed validation: ${formatIssues(result.error.issues)}`,
    });
  }
  return result.data as z.infer<(typeof KIND_SECRETS_SCHEMAS)[K]>;
}

// Scope syntax — kept as a parsed shape so callers can match by
// specialist name without re-parsing the string everywhere. `global`
// matches any caller; `specialist:<name>` matches only when the
// caller's specialist name equals `<name>`.
export type ToolConnectionScope =
  | { kind: "global" }
  | { kind: "specialist"; specialistName: string };

export function parseScope(raw: string): ToolConnectionScope {
  if (raw === "global") return { kind: "global" };
  if (raw.startsWith("specialist:")) {
    const specialistName = raw.slice("specialist:".length);
    if (!specialistName) {
      throw new ToolConnectionValidationError({
        code: "scope",
        message: `tool_connections.scope value '${raw}' is invalid: specialist name is empty`,
      });
    }
    return { kind: "specialist", specialistName };
  }
  throw new ToolConnectionValidationError({
    code: "scope",
    message: `tool_connections.scope value '${raw}' is invalid: expected 'global' or 'specialist:<name>'`,
  });
}

export function formatScope(scope: ToolConnectionScope): string {
  if (scope.kind === "global") return "global";
  // Guard against the asymmetric case where `formatScope` would
  // happily write `"specialist:"` to the row but `parseScope` later
  // rejects that same string — the connection would be persisted
  // but permanently unresolvable. Reject here instead.
  if (!scope.specialistName) {
    throw new ToolConnectionValidationError({
      code: "scope",
      message:
        "tool_connections.scope: specialistName must be non-empty for kind='specialist'",
    });
  }
  return `specialist:${scope.specialistName}`;
}

function formatIssues(issues: z.ZodIssue[]): string {
  return issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
}
