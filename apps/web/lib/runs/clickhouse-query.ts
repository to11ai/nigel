import type {
  ClickhouseQueryCallback,
  ClickhouseQueryResultRow,
} from "@nigel/agent";
import { withToolSpan } from "@/lib/observability/tool-span";
import {
  type ClickhouseConnectionConfig,
  type ClickhouseConnectionSecrets,
  type ResolvedConnection,
  resolveToolConnection,
} from "@/lib/tool-connections";
import { clampPositive, formatHostForUrl, scopeAllows } from "./query-shared";

// Read-only enforcement mirrors `database-query.ts`: leading-verb gate
// + keyword denylist (after stripping comments + string/identifier
// literals). ClickHouse's verb surface is a superset of standard SQL,
// so we add its server-side admin commands and the lightweight DML
// forms.
// `desc\b` would match `DESC TABLE x` but NOT `DESCRIBE TABLE x`
// because `\b` requires a non-word char after `desc` and the next
// char in `DESCRIBE` is `r` (a word char). ClickHouse treats DESC
// and DESCRIBE as synonyms; match both.
const READ_ONLY_LEADING_VERB_REGEX =
  /^(?:select|with|explain|show|desc(?:ribe)?)\b/i;
// Three things shape this list:
//   1. The leading-verb gate already rejects standalone admin
//      statements that don't start SELECT/WITH/EXPLAIN/SHOW/DESC —
//      so SYSTEM RELOAD, OPTIMIZE TABLE, KILL QUERY, etc. as a whole
//      statement are already blocked, and we don't need to re-list
//      those verbs here as long as they couldn't appear *inside* a
//      legitimate SELECT.
//   2. Keywords that ARE legitimate inside SELECTs (the `system.*`
//      metadata tables, the `merge()` table function, the
//      `replace()` / `replaceAll()` string functions) MUST be left
//      out — otherwise `SELECT * FROM system.tables` and friends
//      get rejected. Word boundaries don't help: `\bsystem\b`
//      matches inside `system.tables` because `.` is a non-word char.
//   3. Anything that could appear inside a CTE / subquery and write
//      data (INSERT/UPDATE/DELETE/MERGE-INTO/CREATE/DROP/ALTER/
//      ATTACH/DETACH/EXCHANGE/RENAME/TRUNCATE/GRANT/REVOKE/SET/USE/
//      INTO) MUST be listed.
const FORBIDDEN_WRITE_KEYWORDS = [
  // Core DML (note: `merge` is omitted on purpose — it's a legit
  // table function in SELECTs; `MERGE INTO` is blocked via `into`).
  "insert",
  "update",
  "delete",
  "truncate",
  // DDL
  "drop",
  "alter",
  "create",
  "rename",
  "attach",
  "detach",
  "exchange",
  // Access control
  "grant",
  "revoke",
  // Session / settings mutation
  "set",
  "use",
  // Same `INTO` rationale as Postgres — `SELECT … INTO OUTFILE`
  // writes to disk; block it. Also covers `INSERT INTO` (which is
  // already caught by `insert`) and `MERGE INTO` (which is the only
  // way `merge` performs writes from inside a SELECT context).
  "into",
];
const WRITE_KEYWORD_REGEX = new RegExp(
  `\\b(?:${FORBIDDEN_WRITE_KEYWORDS.join("|")})\\b`,
  "i",
);

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
    // /* block comment */ — ClickHouse allows nesting.
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
    // 'single-quoted string' with backslash escapes (ClickHouse) and
    // doubled-quote escapes (`''`).
    if (ch === "'") {
      cursor++;
      while (cursor < sql.length) {
        if (sql[cursor] === "\\" && cursor + 1 < sql.length) {
          cursor += 2;
          continue;
        }
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
    // "double-quoted identifier" and `backtick identifiers` — both are
    // accepted by ClickHouse for column / table names.
    if (ch === '"' || ch === "`") {
      const closer = ch;
      cursor++;
      while (cursor < sql.length) {
        if (sql[cursor] === closer && sql[cursor + 1] === closer) {
          cursor += 2;
          continue;
        }
        if (sql[cursor] === closer) {
          cursor++;
          break;
        }
        cursor++;
      }
      continue;
    }
    out.push(ch);
    cursor++;
  }
  return out.join("");
}

// `SHOW CREATE ...` is the standard read-only way to inspect a
// table / view / database / dictionary / function / user / role
// / quota / profile / policy DDL in ClickHouse — it returns the
// CREATE statement as a string, it does NOT execute one. Treat it
// as a read and skip the keyword scan that would otherwise reject
// it on `create`. Same logic that lets `EXPLAIN ANALYZE SELECT`
// past the Postgres gate.
const SHOW_CREATE_REGEX = /^show\s+create\b/i;

function classifyReadOnlyViolation(sql: string): string | null {
  const stripped = stripCommentsAndLiterals(sql).trim();
  if (!READ_ONLY_LEADING_VERB_REGEX.test(stripped)) {
    return "only SELECT, WITH, EXPLAIN, SHOW, and DESC statements are accepted";
  }
  if (SHOW_CREATE_REGEX.test(stripped)) {
    return null;
  }
  const match = WRITE_KEYWORD_REGEX.exec(stripped);
  if (match) {
    return `forbidden keyword '${match[0]}' is not permitted (data-modifying and admin keywords are blocked even when the leading verb is read-shaped)`;
  }
  return null;
}

export class ClickhouseQueryError extends Error {
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
    this.name = "ClickhouseQueryError";
    this.code = code;
  }
}

const HARD_ROW_LIMIT_CAP = 10_000;
const HARD_STATEMENT_TIMEOUT_MS_CAP = 300_000;
const FETCH_BUFFER_MS = 5_000;

export type CreateClickhouseQueryCallbackInput = {
  specialistName: string;
};

export function createClickhouseQueryCallback(
  input: CreateClickhouseQueryCallbackInput,
): ClickhouseQueryCallback {
  return async (call) => {
    return withToolSpan(
      "tool.clickhouse_query",
      {
        "nigel.tool.name": "clickhouse_query",
        "nigel.tool.specialist": input.specialistName,
        "nigel.tool.connection": call.connectionName,
        "nigel.tool.sql_length": call.sql.length,
        ...(call.rowLimit !== undefined
          ? { "nigel.tool.row_limit": call.rowLimit }
          : {}),
      },
      async () => {
        const resolved = await tryResolveConnection(call.connectionName);
        if (resolved.kind !== "clickhouse") {
          throw new ClickhouseQueryError(
            "wrong_kind",
            `connection '${call.connectionName}' is kind '${resolved.kind}', not 'clickhouse'`,
          );
        }
        if (!scopeAllows(resolved.scope, input.specialistName)) {
          throw new ClickhouseQueryError(
            "scope_denied",
            `connection '${call.connectionName}' is not in scope for specialist '${input.specialistName}'`,
          );
        }
        if (resolved.config.readOnly) {
          const reason = classifyReadOnlyViolation(call.sql);
          if (reason) {
            throw new ClickhouseQueryError(
              "read_only_violation",
              `connection '${call.connectionName}' is read-only; ${reason}`,
            );
          }
        }
        return executeQuery({
          config: resolved.config,
          secrets: resolved.secrets,
          sql: call.sql,
          parameters: call.parameters,
          rowLimit: clampPositive(
            call.rowLimit ?? resolved.config.defaultRowLimit,
            HARD_ROW_LIMIT_CAP,
          ),
          statementTimeoutMs: clampPositive(
            call.statementTimeoutMs ??
              resolved.config.defaultStatementTimeoutMs,
            HARD_STATEMENT_TIMEOUT_MS_CAP,
          ),
        });
      },
    );
  };
}

async function tryResolveConnection(name: string): Promise<ResolvedConnection> {
  try {
    return await resolveToolConnection(name);
  } catch (err) {
    throw new ClickhouseQueryError(
      "connection_not_resolvable",
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function executeQuery(input: {
  config: ClickhouseConnectionConfig;
  secrets: ClickhouseConnectionSecrets;
  sql: string;
  parameters:
    | Readonly<Record<string, string | number | boolean | null>>
    | undefined;
  rowLimit: number;
  statementTimeoutMs: number;
}): Promise<{
  rows: ClickhouseQueryResultRow[];
  columnNames: string[];
  columnTypes: string[];
  rowCount: number;
  truncated: boolean;
}> {
  // IPv6 hosts must be bracketed in URL form (`http://[::1]:8123/`).
  // Mirrors the same helper `database-query.ts` uses for Postgres URLs.
  const host = formatHostForUrl(input.config.host);
  const url = new URL(
    `${input.config.protocol}://${host}:${input.config.port}/`,
  );
  url.searchParams.set("database", input.config.database);
  // Structured JSON response: ClickHouse returns {meta, data, rows,
  // statistics}. JSON-with-meta is the only format that hands us
  // column types alongside the data without a separate DESCRIBE.
  url.searchParams.set("default_format", "JSON");
  // Server-side row limit with `break` overflow mode: ClickHouse stops
  // streaming at the cap and returns what it has, no error. We ask
  // for `rowLimit + 1` so we can detect truncation by comparing the
  // returned count against `rowLimit`.
  url.searchParams.set("max_result_rows", String(input.rowLimit + 1));
  url.searchParams.set("result_overflow_mode", "break");
  // ClickHouse's max_execution_time is in seconds. Round up so a
  // sub-second timeout still gets at least 1 second on the server.
  url.searchParams.set(
    "max_execution_time",
    String(Math.max(1, Math.ceil(input.statementTimeoutMs / 1000))),
  );
  if (input.config.readOnly) {
    // Defense in depth on top of the keyword scan: ClickHouse's
    // `readonly` setting blocks DDL/DML server-side, so even if our
    // prompt-side gate misses something, the server still refuses
    // the write. We use `readonly=2` — NOT `readonly=1` — because
    // `readonly=1` rejects ALL setting overrides in the same
    // request, which would make `max_result_rows`,
    // `result_overflow_mode`, and `max_execution_time` (set above)
    // fail with "Cannot override setting in readonly mode" and break
    // every query. `readonly=2` blocks the same DML/DDL surface but
    // permits the read-side setting overrides we need.
    url.searchParams.set("readonly", "2");
  }
  // Named parameter bindings — ClickHouse pulls these out of the URL
  // query string and substitutes them into `{name:Type}` placeholders
  // in the SQL. Driver-side substitution, no string concatenation.
  for (const [key, value] of Object.entries(input.parameters ?? {})) {
    url.searchParams.set(
      `param_${key}`,
      value === null ? "\\N" : String(value),
    );
  }

  const auth = `Basic ${Buffer.from(`${input.config.user}:${input.secrets.password}`).toString("base64")}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: auth,
        "content-type": "text/plain; charset=UTF-8",
      },
      body: input.sql,
      signal: AbortSignal.timeout(input.statementTimeoutMs + FETCH_BUFFER_MS),
    });
  } catch (err) {
    throw new ClickhouseQueryError(
      "execution_failed",
      err instanceof Error ? err.message : String(err),
    );
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new ClickhouseQueryError(
      "execution_failed",
      `clickhouse responded with HTTP ${response.status}: ${text.slice(0, 500)}`,
    );
  }

  let payload: ClickhouseJsonResponse;
  try {
    payload = (await response.json()) as ClickhouseJsonResponse;
  } catch (err) {
    throw new ClickhouseQueryError(
      "execution_failed",
      `clickhouse response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const data = payload.data ?? [];
  const truncated = data.length > input.rowLimit;
  const rows = truncated ? data.slice(0, input.rowLimit) : data;
  const meta = payload.meta ?? [];
  return {
    rows: rows.map((r) => ({ ...r })),
    columnNames: meta.map((m) => m.name),
    columnTypes: meta.map((m) => m.type),
    rowCount: rows.length,
    truncated,
  };
}

type ClickhouseJsonResponse = {
  meta?: Array<{ name: string; type: string }>;
  data?: Array<Record<string, unknown>>;
  rows?: number;
};
