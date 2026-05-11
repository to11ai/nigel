import { tool } from "ai";
import { z } from "zod";

// The agent package has no access to Nigel's tool_connections registry
// or to `postgres-js`. Same pattern as `dispatch_specialist`: the
// dispatching layer (apps/web's specialist-execution wrapper) supplies
// a curried callback via `experimental_context`. The callback owns
// connection resolution, read-only enforcement, and the actual SQL
// execution; this tool just validates input and formats output.
export type DatabaseQueryResultRow = Readonly<Record<string, unknown>>;

export type DatabaseQueryCallback = (input: {
  connectionName: string;
  sql: string;
  params?: ReadonlyArray<string | number | boolean | null>;
  rowLimit?: number;
  statementTimeoutMs?: number;
}) => Promise<{
  rows: DatabaseQueryResultRow[];
  columnNames: string[];
  rowCount: number;
  truncated: boolean;
}>;

interface DatabaseQueryContext {
  databaseQuery?: DatabaseQueryCallback;
}

const databaseQueryInputSchema = z.object({
  connection_name: z
    .string()
    .min(1)
    .describe(
      "Name of a tool_connection of kind 'postgres' to query against. Must be a connection your specialist's scope can resolve.",
    ),
  sql: z
    .string()
    .min(1)
    .describe(
      "The SQL statement to run. Use parameter placeholders ($1, $2, ...) for values rather than string concatenation. Connections flagged read-only refuse non-SELECT/WITH/EXPLAIN statements.",
    ),
  params: z
    .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .optional()
    .describe(
      "Positional parameters substituted into the SQL via the driver. Use these for every user-controlled or untrusted value.",
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

const databaseQueryOutputSchema = z.discriminatedUnion("success", [
  z.object({
    success: z.literal(true),
    connection: z.string(),
    rows: z.array(z.record(z.string(), z.unknown())),
    column_names: z.array(z.string()),
    row_count: z.number().int().nonnegative(),
    truncated: z.boolean(),
  }),
  z.object({
    success: z.literal(false),
    connection: z.string(),
    error: z.string(),
  }),
]);

export const databaseQueryTool = tool({
  description: `Run a SQL query against a registered tool_connection of kind 'postgres'.

Use this when the task requires reading from a Postgres database the user has registered. The connection's host, database, user, SSL mode, and credentials live in the tool_connections registry — you only supply the connection's \`connection_name\`.

Important:
- Always use parameter placeholders (\`$1\`, \`$2\`, ...) for values. Never concatenate untrusted strings into SQL.
- Connections flagged read-only refuse anything other than SELECT / WITH / EXPLAIN; an INSERT/UPDATE/DELETE returns an error from the tool, it does not silently no-op.
- The result is row-limited (default 1000, capped by the connection's configured maximum). When \`truncated: true\` the output was cut short — refine your query rather than asking for more rows.
- If the connection name doesn't exist or your specialist's scope can't reach it, the tool returns an error explaining which — that's a configuration problem, not something to retry.`,
  inputSchema: databaseQueryInputSchema,
  outputSchema: databaseQueryOutputSchema,
  execute: async (
    { connection_name, sql, params, row_limit, statement_timeout_ms },
    { experimental_context },
  ) => {
    const context = experimental_context as DatabaseQueryContext | undefined;
    const callback = context?.databaseQuery;
    if (!callback) {
      return {
        success: false as const,
        connection: connection_name,
        error:
          "database_query tool not wired: no callback in experimental_context. This is a runtime configuration bug, not something the agent can fix.",
      };
    }
    try {
      const result = await callback({
        connectionName: connection_name,
        sql,
        ...(params !== undefined ? { params } : {}),
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

export type DatabaseQueryInput = z.infer<typeof databaseQueryInputSchema>;
