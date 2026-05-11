import type {
  DatabaseQueryCallback,
  DatabaseQueryResultRow,
} from "@nigel/agent";
import postgres from "postgres";
import {
  type PostgresConnectionConfig,
  type PostgresConnectionSecrets,
  type ResolvedConnection,
  resolveToolConnection,
  type ToolConnectionScope,
} from "@/lib/tool-connections";

// Read-only enforcement: when the connection's config has
// `readOnly: true`, the only verbs we accept are SELECT, WITH, and
// EXPLAIN. We strip leading comments and whitespace before
// classifying so an LLM that prefixes its SQL with a `/* … */` block
// doesn't accidentally tunnel writes past us. This is a defense
// layer; the actual GRANTs in the target database should also limit
// the user to read-only. Both layers together make a write
// substantially less likely.
const READ_ONLY_VERB_REGEX = /^\s*(?:select|with|explain)\b/i;

// Strip /* … */ block comments and -- line comments from the head of
// the statement before checking the leading verb. We don't try to
// fully parse SQL — a determined attacker could still craft something
// the GRANTs would block — but we close the obvious holes (multi-line
// header comments, leading whitespace).
function stripLeadingComments(sql: string): string {
  let cursor = 0;
  while (cursor < sql.length) {
    // Skip whitespace.
    while (cursor < sql.length && /\s/.test(sql[cursor]!)) cursor++;
    if (sql.startsWith("--", cursor)) {
      const newline = sql.indexOf("\n", cursor);
      if (newline === -1) return "";
      cursor = newline + 1;
      continue;
    }
    if (sql.startsWith("/*", cursor)) {
      const end = sql.indexOf("*/", cursor + 2);
      if (end === -1) return "";
      cursor = end + 2;
      continue;
    }
    break;
  }
  return sql.slice(cursor);
}

export class DatabaseQueryError extends Error {
  readonly code:
    | "connection_not_resolvable"
    | "wrong_kind"
    | "scope_denied"
    | "read_only_violation"
    | "execution_failed";
  constructor(
    code:
      | "connection_not_resolvable"
      | "wrong_kind"
      | "scope_denied"
      | "read_only_violation"
      | "execution_failed",
    message: string,
  ) {
    super(message);
    this.name = "DatabaseQueryError";
    this.code = code;
  }
}

// Hard caps that override the connection's configured maxima. A
// well-meaning admin (or a malicious one) shouldn't be able to set
// the row limit to 10M and lock up the agent's context budget. These
// match what a single agent step can reasonably digest.
const HARD_ROW_LIMIT_CAP = 10_000;
const HARD_STATEMENT_TIMEOUT_MS_CAP = 300_000; // 5 minutes

export type CreateDatabaseQueryCallbackInput = {
  specialistName: string;
};

// Builds the production callback. Capturing the specialist name in
// the closure means the tool can't be tricked into resolving a
// connection scoped to a different specialist — even if the LLM
// supplies an arbitrary `connection_name`, the scope check below
// catches it before we open a socket.
export function createDatabaseQueryCallback(
  input: CreateDatabaseQueryCallbackInput,
): DatabaseQueryCallback {
  return async (call) => {
    const resolved = await tryResolveConnection(call.connectionName);
    if (resolved.kind !== "postgres") {
      throw new DatabaseQueryError(
        "wrong_kind",
        `connection '${call.connectionName}' is kind '${resolved.kind}', not 'postgres'`,
      );
    }
    if (!scopeAllows(resolved.scope, input.specialistName)) {
      throw new DatabaseQueryError(
        "scope_denied",
        `connection '${call.connectionName}' is not in scope for specialist '${input.specialistName}'`,
      );
    }
    if (resolved.config.readOnly) {
      const stripped = stripLeadingComments(call.sql);
      if (!READ_ONLY_VERB_REGEX.test(stripped)) {
        throw new DatabaseQueryError(
          "read_only_violation",
          `connection '${call.connectionName}' is read-only; only SELECT, WITH, and EXPLAIN statements are accepted`,
        );
      }
    }
    return executeQuery({
      config: resolved.config,
      secrets: resolved.secrets,
      sql: call.sql,
      params: call.params,
      rowLimit: clampPositive(
        call.rowLimit ?? resolved.config.defaultRowLimit,
        HARD_ROW_LIMIT_CAP,
      ),
      statementTimeoutMs: clampPositive(
        call.statementTimeoutMs ?? resolved.config.defaultStatementTimeoutMs,
        HARD_STATEMENT_TIMEOUT_MS_CAP,
      ),
    });
  };
}

async function tryResolveConnection(name: string): Promise<ResolvedConnection> {
  try {
    return await resolveToolConnection(name);
  } catch (err) {
    throw new DatabaseQueryError(
      "connection_not_resolvable",
      err instanceof Error ? err.message : String(err),
    );
  }
}

function scopeAllows(
  scope: ToolConnectionScope,
  specialistName: string,
): boolean {
  if (scope.kind === "global") return true;
  return scope.specialistName === specialistName;
}

function clampPositive(value: number, cap: number): number {
  if (!Number.isFinite(value) || value <= 0) return cap;
  return Math.min(value, cap);
}

// Opens a single-use postgres connection, runs the query, returns
// rows truncated to the configured limit, and closes the connection.
// We do not pool: each specialist run is short-lived, the registry
// row gets the auth credentials, and pooling would complicate scope
// enforcement (a pool keyed on connection name would have to track
// which specialist last used it). Plenty of headroom to add pooling
// later if dedicated long-running analysts emerge.
async function executeQuery(input: {
  config: PostgresConnectionConfig;
  secrets: PostgresConnectionSecrets;
  sql: string;
  params: ReadonlyArray<string | number | boolean | null> | undefined;
  rowLimit: number;
  statementTimeoutMs: number;
}): Promise<{
  rows: DatabaseQueryResultRow[];
  columnNames: string[];
  rowCount: number;
  truncated: boolean;
}> {
  // postgres-js's typed Options surface is picky about generic
  // parameters; the URL form sidesteps the constraint without losing
  // any of the connection knobs we care about. SSL maps directly
  // through libpq's `sslmode` query param.
  const url = buildConnectionUrl(input.config, input.secrets);
  const sql = postgres(url, { max: 1 });
  try {
    // Per-connection statement timeout. SET (not SET LOCAL) so it
    // applies to every subsequent statement on this short-lived
    // client, which only ever runs the one user query after this.
    await sql.unsafe(`SET statement_timeout = ${input.statementTimeoutMs}`);
    const params = (input.params ?? []) as readonly unknown[];
    const result = await sql.unsafe(input.sql, params as never[]);
    const truncated = result.length > input.rowLimit;
    const rows = (truncated ? result.slice(0, input.rowLimit) : result).map(
      (r) => ({ ...(r as Record<string, unknown>) }),
    );
    const columnNames = rows.length > 0 ? Object.keys(rows[0]!) : [];
    return {
      rows,
      columnNames,
      rowCount: rows.length,
      truncated,
    };
  } catch (err) {
    throw new DatabaseQueryError(
      "execution_failed",
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function buildConnectionUrl(
  config: PostgresConnectionConfig,
  secrets: PostgresConnectionSecrets,
): string {
  const user = encodeURIComponent(config.user);
  const password = encodeURIComponent(secrets.password);
  const host = encodeURIComponent(config.host);
  const database = encodeURIComponent(config.database);
  const url = new URL(
    `postgres://${user}:${password}@${host}:${config.port}/${database}`,
  );
  // libpq sslmode values pass through unchanged. `disable` maps to no
  // TLS; `require` accepts any cert; `verify-ca` / `verify-full` add
  // chain + hostname validation on top.
  url.searchParams.set("sslmode", config.sslMode);
  return url.toString();
}
