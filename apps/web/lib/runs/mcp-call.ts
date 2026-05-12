import type { McpCallCallback } from "@nigel/agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  type McpConnectionConfig,
  type McpConnectionSecrets,
  type ResolvedConnection,
  resolveToolConnection,
} from "@/lib/tool-connections";
import { clampPositive, scopeAllows } from "./query-shared";

// Production wiring for the `mcp_call` tool: resolve the registered
// MCP connection, spin up a one-shot Client over the configured
// transport, perform the requested operation, and tear the client
// down. Scope and kind checks mirror the data-store tools; there is
// no read-only enforcement here because MCP tools are arbitrary —
// the server itself decides what each tool does.

export class McpCallError extends Error {
  readonly code:
    | "connection_not_resolvable"
    | "wrong_kind"
    | "scope_denied"
    | "transport_unsupported"
    | "execution_failed";
  constructor(
    code:
      | "connection_not_resolvable"
      | "wrong_kind"
      | "scope_denied"
      | "transport_unsupported"
      | "execution_failed",
    message: string,
  ) {
    super(message);
    this.name = "McpCallError";
    this.code = code;
  }
}

const HARD_TIMEOUT_MS_CAP = 300_000; // 5 minutes
const CLIENT_NAME = "nigel-mcp-call";
const CLIENT_VERSION = "0.1.0";

export type CreateMcpCallCallbackInput = {
  specialistName: string;
};

export function createMcpCallCallback(
  input: CreateMcpCallCallbackInput,
): McpCallCallback {
  return async (call) => {
    const resolved = await tryResolveConnection(call.connectionName);
    if (resolved.kind !== "mcp") {
      throw new McpCallError(
        "wrong_kind",
        `connection '${call.connectionName}' is kind '${resolved.kind}', not 'mcp'`,
      );
    }
    if (!scopeAllows(resolved.scope, input.specialistName)) {
      throw new McpCallError(
        "scope_denied",
        `connection '${call.connectionName}' is not in scope for specialist '${input.specialistName}'`,
      );
    }
    const timeoutMs = clampPositive(
      call.timeoutMs ?? resolved.config.defaultTimeoutMs,
      HARD_TIMEOUT_MS_CAP,
    );
    return runOperation({
      config: resolved.config,
      secrets: resolved.secrets,
      operation: call.operation,
      timeoutMs,
    });
  };
}

async function tryResolveConnection(name: string): Promise<ResolvedConnection> {
  try {
    return await resolveToolConnection(name);
  } catch (err) {
    throw new McpCallError(
      "connection_not_resolvable",
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function runOperation(input: {
  config: McpConnectionConfig;
  secrets: McpConnectionSecrets;
  operation:
    | { type: "list_tools" }
    | {
        type: "call_tool";
        toolName: string;
        arguments?: Readonly<Record<string, unknown>>;
      };
  timeoutMs: number;
}): Promise<
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
> {
  const transport = await openTransport(input.config, input.secrets);
  const client = new Client(
    { name: CLIENT_NAME, version: CLIENT_VERSION },
    { capabilities: {} },
  );
  try {
    // `timeoutMs` is the **total** budget for the whole operation
    // (connect + list/call). The SDK's `connect()` runs the
    // `initialize` handshake using its own 60s default and doesn't
    // accept a per-call timeout, so we wrap it with our own race;
    // then we subtract elapsed wall-clock from the budget before
    // passing the remainder to `listTools` / `callTool`. Without
    // this split, a slow connect at the cap (5 min) would let the
    // request phase consume another full 5 min — 10 min total.
    const deadline = Date.now() + input.timeoutMs;
    await withTimeout(
      client.connect(transport),
      input.timeoutMs,
      "mcp connect",
    );
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new McpCallError(
        "execution_failed",
        `mcp operation exhausted its ${input.timeoutMs}ms budget during connect`,
      );
    }
    if (input.operation.type === "list_tools") {
      const res = await client.listTools(undefined, { timeout: remainingMs });
      return {
        operation: "list_tools",
        tools: res.tools.map((t) => ({
          name: t.name,
          ...(t.description !== undefined
            ? { description: t.description }
            : {}),
          inputSchema: t.inputSchema,
        })),
      };
    }
    const res = await client.callTool(
      {
        name: input.operation.toolName,
        ...(input.operation.arguments !== undefined
          ? { arguments: { ...input.operation.arguments } }
          : {}),
      },
      undefined,
      { timeout: remainingMs },
    );
    // The SDK's `CallToolResult` shape carries `content` typed
    // loosely; widen to a plain array of records here since the LLM
    // consumes the parts verbatim and the per-part schema varies by
    // tool.
    const rawContent = (res.content ?? []) as ReadonlyArray<
      Record<string, unknown>
    >;
    return {
      operation: "call_tool",
      toolName: input.operation.toolName,
      isError: res.isError === true,
      content: rawContent.map((part) => ({ ...part })),
    };
  } catch (err) {
    if (err instanceof McpCallError) throw err;
    throw new McpCallError(
      "execution_failed",
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    // `close()` here flushes any pending stdio buffers and tears
    // down the SSE connection / process. Errors during close are
    // swallowed — the call already produced its result (or its
    // error) and the client is one-shot.
    await client.close().catch(() => undefined);
  }
}

// Race the supplied promise against a timer. The timer resolves
// (with a sentinel symbol) rather than rejecting, so we never
// construct a "Promise that only rejects" — the throw on timeout
// happens here at the await site instead, where it's easier to read
// and reason about. `clearTimeout` in the finally avoids a leaked
// handle when the inner promise wins the race.
const TIMEOUT_SENTINEL = Symbol("mcp-call-timeout");

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT_SENTINEL), ms);
  });
  try {
    const winner = await Promise.race([promise, timeoutPromise]);
    if (winner === TIMEOUT_SENTINEL) {
      throw new McpCallError(
        "execution_failed",
        `${label} timed out after ${ms}ms`,
      );
    }
    return winner;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function openTransport(
  config: McpConnectionConfig,
  secrets: McpConnectionSecrets,
): Promise<Transport> {
  if (config.transport === "http") {
    // The MCP HTTP transport handles both the modern Streamable HTTP
    // mode and falls back to plain request/response when the server
    // doesn't advertise SSE. Headers / bearer go via the
    // `requestInit` option; the SDK applies them to every fetch.
    const headers: Record<string, string> = {};
    if (secrets.bearerToken) {
      headers.Authorization = `Bearer ${secrets.bearerToken}`;
    }
    for (const [k, v] of Object.entries(secrets.env ?? {})) {
      headers[k] = v;
    }
    return new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: { headers },
    });
  }
  if (config.transport === "stdio") {
    // Spawn the configured command. The `env` from secrets is passed
    // through so MCP servers that authenticate via env vars (GitHub
    // MCP with GITHUB_TOKEN, Linear MCP with LINEAR_API_KEY, etc.)
    // can read them. Note: this only works in runtimes that allow
    // `child_process.spawn` — Vercel serverless does, but the binary
    // has to be present in the function's filesystem. In practice
    // stdio MCP is for trusted first-party servers we control the
    // packaging of.
    return new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: {
        ...process.env,
        ...secrets.env,
      } as Record<string, string>,
    });
  }
  // The discriminated union is exhaustive at the Zod layer, but TS
  // can't prove that across `Transport`'s return type. Defensive
  // throw covers the unreachable branch.
  throw new McpCallError(
    "transport_unsupported",
    `unknown MCP transport: ${(config as { transport: string }).transport}`,
  );
}
