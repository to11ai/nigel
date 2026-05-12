import { tool } from "ai";
import { z } from "zod";

// Same callback-via-experimental_context pattern as the data-store
// tools. The agent package doesn't know how to speak MCP / JSON-RPC;
// the dispatching layer (apps/web) supplies a curried callback that
// owns connection resolution, transport selection, and the actual
// wire protocol.
//
// Two operations supported:
//   - `list_tools` — return the tools the MCP server exposes, with
//     their JSON-schema input definitions. This is how a specialist
//     discovers what it can call.
//   - `call_tool` — invoke a named tool with arguments. The
//     server's response (a list of content parts: text / image /
//     resource references) is returned verbatim.
//
// The argument shape is deliberately untyped at the agent layer:
// every MCP server defines its own per-tool schema and the LLM
// negotiates against `list_tools` output to construct valid calls.
export type McpCallCallback = (input: {
  connectionName: string;
  operation:
    | { type: "list_tools" }
    | {
        type: "call_tool";
        toolName: string;
        arguments?: Readonly<Record<string, unknown>>;
      };
  timeoutMs?: number;
}) => Promise<
  | {
      operation: "list_tools";
      tools: Array<{
        name: string;
        description?: string;
        inputSchema: unknown;
      }>;
    }
  | {
      operation: "call_tool";
      toolName: string;
      isError: boolean;
      content: Array<Record<string, unknown>>;
    }
>;

interface McpCallContext {
  mcpCall?: McpCallCallback;
}

const mcpCallInputSchema = z.object({
  connection_name: z
    .string()
    .min(1)
    .describe(
      "Name of a tool_connection of kind 'mcp' to talk to. Must be a connection your specialist's scope can resolve.",
    ),
  operation: z
    .discriminatedUnion("type", [
      z.object({
        type: z.literal("list_tools"),
      }),
      z.object({
        type: z.literal("call_tool"),
        tool_name: z.string().min(1),
        arguments: z.record(z.string(), z.unknown()).optional(),
      }),
    ])
    .describe(
      "Either `list_tools` to discover the server's tool surface, or `call_tool` with the chosen tool's name and an arguments object that matches the server's schema for it.",
    ),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Optional override of the connection's default per-call timeout (ms). Capped by the connection's configured maximum.",
    ),
});

const mcpCallOutputSchema = z.discriminatedUnion("success", [
  z.object({
    success: z.literal(true),
    connection: z.string(),
    operation: z.enum(["list_tools", "call_tool"]),
    tool_name: z.string().optional(),
    is_error: z.boolean().optional(),
    tools: z
      .array(
        z.object({
          name: z.string(),
          description: z.string().optional(),
          input_schema: z.unknown(),
        }),
      )
      .optional(),
    content: z.array(z.record(z.string(), z.unknown())).optional(),
  }),
  z.object({
    success: z.literal(false),
    connection: z.string(),
    operation: z.string(),
    error: z.string(),
  }),
]);

export const mcpCallTool = tool({
  description: `Talk to a registered MCP (Model Context Protocol) server.

Two operations:
- \`list_tools\`: Returns the tools the server exposes and their JSON-schema input definitions. Always call this first when working with an unfamiliar connection — the server tells you what arguments each of its tools expects.
- \`call_tool\`: Invoke a tool by name. The \`arguments\` object must match the schema returned by \`list_tools\` for that tool.

Important:
- The MCP server's response shape varies by tool. \`call_tool\` returns the server's \`content\` array (typed parts: text, image, resource reference). Read what came back rather than assuming a fixed shape.
- When \`is_error\` is true, the call reached the server but the server reported failure. The agent should read the error content and decide whether the situation is recoverable.
- If the connection name doesn't exist or your specialist's scope can't reach it, the tool returns a configuration error — that's not something to retry.`,
  inputSchema: mcpCallInputSchema,
  outputSchema: mcpCallOutputSchema,
  execute: async (
    { connection_name, operation, timeout_ms },
    { experimental_context },
  ) => {
    const context = experimental_context as McpCallContext | undefined;
    const callback = context?.mcpCall;
    if (!callback) {
      return {
        success: false as const,
        connection: connection_name,
        operation: operation.type,
        error:
          "mcp_call tool not wired: no callback in experimental_context. This is a runtime configuration bug, not something the agent can fix.",
      };
    }
    try {
      const result = await callback({
        connectionName: connection_name,
        operation:
          operation.type === "list_tools"
            ? { type: "list_tools" }
            : {
                type: "call_tool",
                toolName: operation.tool_name,
                ...(operation.arguments !== undefined
                  ? { arguments: operation.arguments }
                  : {}),
              },
        ...(timeout_ms !== undefined ? { timeoutMs: timeout_ms } : {}),
      });
      if (result.operation === "list_tools") {
        return {
          success: true as const,
          connection: connection_name,
          operation: "list_tools" as const,
          tools: result.tools.map((t) => ({
            name: t.name,
            ...(t.description !== undefined
              ? { description: t.description }
              : {}),
            input_schema: t.inputSchema,
          })),
        };
      }
      return {
        success: true as const,
        connection: connection_name,
        operation: "call_tool" as const,
        tool_name: result.toolName,
        is_error: result.isError,
        content: result.content,
      };
    } catch (err) {
      return {
        success: false as const,
        connection: connection_name,
        operation: operation.type,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
});

export type McpCallInput = z.infer<typeof mcpCallInputSchema>;
