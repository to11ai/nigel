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

// Read-only enforcement is two-step:
//
//   1. The leading verb (after stripping leading whitespace + comments)
//      must be SELECT, WITH, or EXPLAIN.
//   2. NO data-modifying keyword may appear anywhere in the statement
//      (after stripping all comments and string/identifier literals).
//
// Step 2 is the important one. Postgres lets data-modifying statements
// live inside CTEs — `WITH deleted AS (DELETE FROM users RETURNING *)
// SELECT * FROM deleted` starts with `WITH` and would pass step 1 alone
// but executes a DELETE. Treat the `readOnly` flag as a real
// enforcement layer, not just a hint to GRANT-config the database with.
//
// This is still defense in depth: the target database's GRANTs are the
// authoritative layer (e.g. via a dedicated read-only role). Operators
// who set `readOnly: true` and ALSO restrict the connection's user to
// SELECT-only get the tightest guarantee.
const READ_ONLY_LEADING_VERB_REGEX = /^(?:select|with|explain)\b/i;
const FORBIDDEN_WRITE_KEYWORDS = [
  "insert",
  "update",
  "delete",
  "merge",
  "truncate",
  "drop",
  "alter",
  "create",
  "grant",
  "revoke",
  "lock",
  "vacuum",
  "analyze",
  "reindex",
  "cluster",
  "copy",
  "comment",
  "do",
  "call",
  "refresh",
  "reset",
  "set",
  "discard",
];
const WRITE_KEYWORD_REGEX = new RegExp(
  `\\b(?:${FORBIDDEN_WRITE_KEYWORDS.join("|")})\\b`,
  "i",
);

// Strip /* … */ block comments, -- line comments, single-quoted
// strings, dollar-quoted strings ($tag$...$tag$), and double-quoted
// identifiers from the SQL. The result is positionally meaningless
// but preserves keyword presence/absence for the read-only scan, so
// `WHERE name = 'INSERT INTO'` no longer registers as a write.
// Comment + string stripping is done with hand-written tokenization
// because the postgres lexer is more nuanced than a single regex.
function stripCommentsAndLiterals(sql: string): string {
  const out: string[] = [];
  let cursor = 0;
  while (cursor < sql.length) {
    const ch = sql[cursor]!;
    // -- line comment
    if (ch === "-" && sql[cursor + 1] === "-") {
      const nl = sql.indexOf("\n", cursor + 2);
      cursor = nl === -1 ? sql.length : nl;
      continue;
    }
    // /* block comment */ — nesting matters in Postgres.
    if (ch === "/" && sql[cursor + 1] === "*") {
      let depth = 1;
      cursor += 2;
      while (cursor < sql.length && depth > 0) {
        if (sql[cursor] === "/" && sql[cursor + 1] === "*") {
          depth++;
          cursor += 2;
        } else if (sql[cursor] === "*" && sql[cursor + 1] === "/") {
          depth--;
          cursor += 2;
        } else {
          cursor++;
        }
      }
      continue;
    }
    // 'single-quoted string' — Postgres escapes a literal quote by
    // doubling it (''). Skip until an unescaped closing quote.
    if (ch === "'") {
      cursor++;
      while (cursor < sql.length) {
        if (sql[cursor] === "'" && sql[cursor + 1] === "'") {
          cursor += 2;
          continue;
        }
        if (sql[cursor] === "'") {
          cursor++;
          break;
        }
        cursor++;
      }
      continue;
    }
    // "double-quoted identifier" — same doubling rule for embedded ".
    if (ch === '"') {
      cursor++;
      while (cursor < sql.length) {
        if (sql[cursor] === '"' && sql[cursor + 1] === '"') {
          cursor += 2;
          continue;
        }
        if (sql[cursor] === '"') {
          cursor++;
          break;
        }
        cursor++;
      }
      continue;
    }
    // $tag$ ... $tag$ — Postgres dollar-quoted strings. Tag may be empty.
    if (ch === "$") {
      const tagEnd = sql.indexOf("$", cursor + 1);
      // The tag may contain letters/digits/underscores only. Anything
      // else (e.g. `$1` for a parameter placeholder) means this isn't
      // a dollar-quote opening.
      if (
        tagEnd !== -1 &&
        /^[a-zA-Z0-9_]*$/.test(sql.slice(cursor + 1, tagEnd))
      ) {
        const tag = sql.slice(cursor, tagEnd + 1);
        const close = sql.indexOf(tag, tagEnd + 1);
        cursor = close === -1 ? sql.length : close + tag.length;
        continue;
      }
    }
    out.push(ch);
    cursor++;
  }
  return out.join("");
}

// Returns a typed reason when the SQL should be refused. `null` means
// the statement passes both gates and may proceed to the executor.
function classifyReadOnlyViolation(sql: string): string | null {
  const stripped = stripCommentsAndLiterals(sql).trim();
  if (!READ_ONLY_LEADING_VERB_REGEX.test(stripped)) {
    return "only SELECT, WITH, and EXPLAIN statements are accepted";
  }
  const match = WRITE_KEYWORD_REGEX.exec(stripped);
  if (match) {
    return `forbidden keyword '${match[0]}' is not permitted (CTEs and other data-modifying constructs are blocked even when the leading verb is SELECT/WITH/EXPLAIN)`;
  }
  return null;
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
      const reason = classifyReadOnlyViolation(call.sql);
      if (reason) {
        throw new DatabaseQueryError(
          "read_only_violation",
          `connection '${call.connectionName}' is read-only; ${reason}`,
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
    // Cursor instead of buffered `sql.unsafe(...)` so a SELECT without
    // a LIMIT can't OOM the agent process before our row-limit slice
    // runs. We pull one row at a time and stop the iterator as soon
    // as we've collected `rowLimit + 1` (the extra row is how we
    // detect truncation without fetching more than necessary).
    const rows: DatabaseQueryResultRow[] = [];
    let truncated = false;
    const cursor = sql
      .unsafe(input.sql, params as never[])
      .cursor() as AsyncIterable<Record<string, unknown>>;
    for await (const row of cursor) {
      if (rows.length >= input.rowLimit) {
        truncated = true;
        break;
      }
      rows.push({ ...row });
    }
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
  const host = formatHostForUrl(config.host);
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

// URL hosts can't be percent-encoded the way path/query components
// can: `encodeURIComponent` mangles IPv6 (`::1` → `%3A%3A1`) and the
// brackets that wrap it. Treat the host as opaque and only normalize
// the IPv6 bracket convention. Named hosts and IPv4 addresses pass
// through unchanged; bare IPv6 gets wrapped in `[...]` so the URL
// parser splits host from port correctly.
function formatHostForUrl(host: string): string {
  if (host.startsWith("[") && host.endsWith("]")) {
    return host;
  }
  // IPv6 addresses contain colons but no dots (an IPv4-mapped IPv6
  // address like ::ffff:1.2.3.4 still contains colons, so the dot
  // check would mis-classify it as v4 — fall back to "contains colon"
  // as the signal).
  if (host.includes(":")) {
    return `[${host}]`;
  }
  return host;
}
