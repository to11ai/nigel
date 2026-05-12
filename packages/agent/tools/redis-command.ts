import { tool } from "ai";
import { z } from "zod";

// Same callback-via-experimental_context pattern as `database_query`
// and `clickhouse_query`. Redis differs from the SQL tools because its
// API is command-shaped (verb + args), not query-shaped. Read-only
// enforcement is therefore a command allowlist rather than a keyword
// scan of a SQL string.
export type RedisCommandCallback = (input: {
  connectionName: string;
  command: string;
  args?: ReadonlyArray<string | number>;
  timeoutMs?: number;
}) => Promise<{
  // Redis returns a heterogeneous set of value shapes (string, number,
  // array, hash, null). We pass them back unchanged and tag the
  // top-level type so the LLM can branch on it without guessing.
  resultType: "string" | "number" | "array" | "object" | "null" | "boolean";
  result: unknown;
}>;

interface RedisCommandContext {
  redisCommand?: RedisCommandCallback;
}

const redisCommandInputSchema = z.object({
  connection_name: z
    .string()
    .min(1)
    .describe(
      "Name of a tool_connection of kind 'redis' to run against. Must be a connection your specialist's scope can resolve.",
    ),
  command: z
    .string()
    .min(1)
    .describe(
      "The Redis command to run (case-insensitive). On read-only connections, only inspection-shaped commands are accepted (GET / MGET / HGET / HGETALL / HKEYS / HVALS / HLEN / SMEMBERS / SCARD / ZRANGE / ZREVRANGE / ZRANGEBYSCORE / ZSCORE / ZCARD / LRANGE / LLEN / LINDEX / EXISTS / TYPE / TTL / PTTL / STRLEN / OBJECT / KEYS / SCAN / HSCAN / SSCAN / ZSCAN / DBSIZE / INFO / CLIENT GETNAME / CONFIG GET). Anything else (SET / DEL / FLUSHDB / etc.) is refused.",
    ),
  args: z
    .array(z.union([z.string(), z.number()]))
    .optional()
    .describe(
      "Positional arguments for the command. Strings and numbers only; complex types should be JSON-stringified before passing.",
    ),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Optional override of the connection's default command timeout (ms). Capped by the connection's configured maximum.",
    ),
});

const redisCommandOutputSchema = z.discriminatedUnion("success", [
  z.object({
    success: z.literal(true),
    connection: z.string(),
    command: z.string(),
    result_type: z.enum([
      "string",
      "number",
      "array",
      "object",
      "null",
      "boolean",
    ]),
    result: z.unknown(),
  }),
  z.object({
    success: z.literal(false),
    connection: z.string(),
    command: z.string(),
    error: z.string(),
  }),
]);

export const redisCommandTool = tool({
  description: `Run a Redis command against a registered tool_connection of kind 'redis'.

Use this when the task requires reading from a Redis instance the user has registered. The connection's host, port, db number, TLS setting, and credentials live in the tool_connections registry — you only supply the connection's \`connection_name\`.

Important:
- Read-only connections accept only inspection-shaped commands (see the command field for the full list). Mutating commands (SET / DEL / FLUSHDB / EXPIRE / ZADD / LPUSH / etc.) are refused with a typed error; the LLM cannot bypass this by encoding the command differently. The allowlist is the authoritative gate — there is no equivalent of a SQL "read-only role" at the Redis protocol level.
- KEYS scans the entire keyspace and can block the server on a large instance. Prefer SCAN with a MATCH pattern and a COUNT hint for production analysis.
- Result types vary by command (string, number, array, hash-as-object, null). The \`result_type\` field tells you the shape before you parse \`result\`.
- If the connection name doesn't exist or your specialist's scope can't reach it, the tool returns an error explaining which — that's a configuration problem, not something to retry.`,
  inputSchema: redisCommandInputSchema,
  outputSchema: redisCommandOutputSchema,
  execute: async (
    { connection_name, command, args, timeout_ms },
    { experimental_context },
  ) => {
    const context = experimental_context as RedisCommandContext | undefined;
    const callback = context?.redisCommand;
    if (!callback) {
      return {
        success: false as const,
        connection: connection_name,
        command,
        error:
          "redis_command tool not wired: no callback in experimental_context. This is a runtime configuration bug, not something the agent can fix.",
      };
    }
    try {
      const result = await callback({
        connectionName: connection_name,
        command,
        ...(args !== undefined ? { args } : {}),
        ...(timeout_ms !== undefined ? { timeoutMs: timeout_ms } : {}),
      });
      return {
        success: true as const,
        connection: connection_name,
        command,
        result_type: result.resultType,
        result: result.result,
      };
    } catch (err) {
      return {
        success: false as const,
        connection: connection_name,
        command,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
});

export type RedisCommandInput = z.infer<typeof redisCommandInputSchema>;
