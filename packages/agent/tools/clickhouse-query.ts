import { tool } from "ai";
import { z } from "zod";

// Same pattern as `database_query`: the agent package has no notion of
// the tool_connections registry or ClickHouse's HTTP API; the
// dispatching layer (apps/web) supplies a curried callback via
// `experimental_context`. The callback owns connection resolution,
// read-only enforcement, and the actual HTTP query.
//
// Distinct from `database_query` because ClickHouse SQL is a different
// dialect (FORMAT clause, ReplacingMergeTree FINAL, sampling, table
// engines), uses **named** parameters (`{name:Type}`) rather than
// Postgres' positional `$1` / `$2`, and exposes its own server-side
// read-only enforcement that the callback opts into. A single tool
// straddling both would either erase those affordances or build a
// translation layer that gets in the way of the analyst's intent.
export type ClickhouseQueryResultRow = Readonly<Record<string, unknown>>;

export type ClickhouseQueryCallback = (input: {
  connectionName: string;
  sql: string;
  parameters?: Readonly<Record<string, string | number | boolean | null>>;
  rowLimit?: number;
  statementTimeoutMs?: number;
}) => Promise<{
  rows: ClickhouseQueryResultRow[];
  columnNames: string[];
  columnTypes: string[];
  rowCount: number;
  truncated: boolean;
}>;

interface ClickhouseQueryContext {
  clickhouseQuery?: ClickhouseQueryCallback;
}

const clickhouseQueryInputSchema = z.object({
  connection_name: z
    .string()
    .min(1)
    .describe(
      "Name of a tool_connection of kind 'clickhouse' to query against. Must be a connection your specialist's scope can resolve.",
    ),
  sql: z
    .string()
    .min(1)
    .describe(
      "ClickHouse SQL to run. Use named parameter placeholders ({name:Type}, e.g. {user_id:UInt64}) for any user-controlled value. Do NOT append a FORMAT clause — the tool sets the format. Connections flagged read-only refuse data-modifying statements and SYSTEM/OPTIMIZE/ATTACH/DETACH/KILL/etc.",
    ),
  parameters: z
    .record(
      z.string(),
      z.union([z.string(), z.number(), z.boolean(), z.null()]),
    )
    .optional()
    .describe(
      "Named parameters substituted into the SQL by ClickHouse via the URL's `param_<name>` query string. Use these for every user-controlled or untrusted value.",
    ),
  row_limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Optional override of the connection's default row limit. Capped by the connection's configured maximum.",
    ),
  statement_timeout_ms: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Optional override of the connection's default statement timeout (ms). Capped by the connection's configured maximum.",
    ),
});

const clickhouseQueryOutputSchema = z.discriminatedUnion("success", [
  z.object({
    success: z.literal(true),
    connection: z.string(),
    rows: z.array(z.record(z.string(), z.unknown())),
    column_names: z.array(z.string()),
    column_types: z.array(z.string()),
    row_count: z.number().int().nonnegative(),
    truncated: z.boolean(),
  }),
  z.object({
    success: z.literal(false),
    connection: z.string(),
    error: z.string(),
  }),
]);

export const clickhouseQueryTool = tool({
  description: `Run a ClickHouse query against a registered tool_connection of kind 'clickhouse'.

Use this when the task requires reading from a ClickHouse cluster the user has registered. The connection's host, port, protocol, database, user, and credentials live in the tool_connections registry — you only supply the connection's \`connection_name\`.

Important:
- Use named parameter placeholders (\`{name:Type}\`) for values. Examples: \`SELECT * FROM events WHERE user_id = {uid:UInt64} AND name = {ev:String}\`. The driver supplies the type for each placeholder; you list it in \`parameters\`.
- Do NOT append a \`FORMAT\` clause — the tool sets the response format itself.
- Connections flagged read-only refuse INSERT/ALTER/CREATE/DROP/TRUNCATE/OPTIMIZE/SYSTEM/ATTACH/DETACH/KILL/RENAME and ClickHouse's lightweight DELETE/UPDATE. Read-only is also enforced server-side via the \`readonly=2\` setting — even a prompt-injected attempt to write is refused by the server.
- The result is row-limited (default 1000, capped by the connection's configured maximum) and ClickHouse stops the result stream at the cap via \`result_overflow_mode=break\`. When \`truncated: true\` the output was cut short — refine your query (sampling, GROUP BY, narrower WHERE) rather than asking for more rows.
- If the connection name doesn't exist or your specialist's scope can't reach it, the tool returns an error explaining which — that's a configuration problem, not something to retry.`,
  inputSchema: clickhouseQueryInputSchema,
  outputSchema: clickhouseQueryOutputSchema,
  execute: async (
    { connection_name, sql, parameters, row_limit, statement_timeout_ms },
    { experimental_context },
  ) => {
    const context = experimental_context as ClickhouseQueryContext | undefined;
    const callback = context?.clickhouseQuery;
    if (!callback) {
      return {
        success: false as const,
        connection: connection_name,
        error:
          "clickhouse_query tool not wired: no callback in experimental_context. This is a runtime configuration bug, not something the agent can fix.",
      };
    }
    try {
      const result = await callback({
        connectionName: connection_name,
        sql,
        ...(parameters !== undefined ? { parameters } : {}),
        ...(row_limit !== undefined ? { rowLimit: row_limit } : {}),
        ...(statement_timeout_ms !== undefined
          ? { statementTimeoutMs: statement_timeout_ms }
          : {}),
      });
      return {
        success: true as const,
        connection: connection_name,
        rows: result.rows,
        column_names: result.columnNames,
        column_types: result.columnTypes,
        row_count: result.rowCount,
        truncated: result.truncated,
      };
    } catch (err) {
      return {
        success: false as const,
        connection: connection_name,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
});

export type ClickhouseQueryInput = z.infer<typeof clickhouseQueryInputSchema>;
