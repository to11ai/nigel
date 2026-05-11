import type {
  ClickhouseQueryCallback,
  ClickhouseQueryResultRow,
} from "@nigel/agent";
import {
  type ClickhouseConnectionConfig,
  type ClickhouseConnectionSecrets,
  type ResolvedConnection,
  resolveToolConnection,
  type ToolConnectionScope,
} from "@/lib/tool-connections";

// Read-only enforcement mirrors `database-query.ts`: leading-verb gate
// + keyword denylist (after stripping comments + string/identifier
// literals). ClickHouse's verb surface is a superset of standard SQL,
// so we add its server-side admin commands and the lightweight DML
// forms.
const READ_ONLY_LEADING_VERB_REGEX = /^(?:select|with|explain|show|desc)\b/i;
const FORBIDDEN_WRITE_KEYWORDS = [
  // Core DML
  "insert",
  "update",
  "delete",
  "merge",
  "truncate",
  // DDL
  "drop",
  "alter",
  "create",
  "rename",
  "attach",
  "detach",
  "exchange",
  // Server-side admin / maintenance
  "optimize",
  "system",
  "kill",
  "check",
  "freeze",
  "unfreeze",
  "fetch",
  "replace",
  // Access control
  "grant",
  "revoke",
  // Session / settings mutation
  "set",
  "use",
  // Same `INTO` rationale as Postgres — `SELECT … INTO OUTFILE` writes
  // to disk; block it.
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

function classifyReadOnlyViolation(sql: string): string | null {
  const stripped = stripCommentsAndLiterals(sql).trim();
  if (!READ_ONLY_LEADING_VERB_REGEX.test(stripped)) {
    return "only SELECT, WITH, EXPLAIN, SHOW, and DESC statements are accepted";
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
    throw new ClickhouseQueryError(
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
  const url = new URL(
    `${input.config.protocol}://${input.config.host}:${input.config.port}/`,
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
    // `readonly=1` blocks all DML/DDL/admin server-side, so even if
    // our prompt-side gate ever misses something, the server still
    // refuses to write.
    url.searchParams.set("readonly", "1");
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
