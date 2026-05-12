import type { RedisCommandCallback } from "@nigel/agent";
import Redis from "ioredis";
import {
  type RedisConnectionConfig,
  type RedisConnectionSecrets,
  type ResolvedConnection,
  resolveToolConnection,
} from "@/lib/tool-connections";
import { clampPositive, scopeAllows } from "./query-shared";

// Read-only enforcement for Redis is a command allowlist. Unlike the
// SQL tools, Redis doesn't have a server-side read-only role we can
// flip per-connection, and the command surface is flat (no nested
// "writes inside reads"), so an allowlist is both simpler and tighter
// than a keyword denylist. Commands are matched case-insensitively
// on the entire command name; multi-word commands (CLIENT GETNAME,
// CONFIG GET, OBJECT ENCODING) are matched by their full canonical
// form to keep the allowlist explicit.
const READ_ONLY_COMMAND_ALLOWLIST: ReadonlySet<string> = new Set([
  // String / generic key reads
  "get",
  "mget",
  "getrange",
  "strlen",
  "exists",
  "type",
  "ttl",
  "pttl",
  "expiretime",
  "pexpiretime",
  "object encoding",
  "object freq",
  "object idletime",
  "object refcount",
  "dump",
  // Hashes
  "hget",
  "hmget",
  "hgetall",
  "hkeys",
  "hvals",
  "hlen",
  "hexists",
  "hstrlen",
  "hrandfield",
  // Sets
  "smembers",
  "sismember",
  "smismember",
  "scard",
  "srandmember",
  "sdiff",
  "sinter",
  "sunion",
  // Sorted sets
  "zrange",
  "zrevrange",
  "zrangebyscore",
  "zrevrangebyscore",
  "zrangebylex",
  "zrevrangebylex",
  "zscore",
  "zmscore",
  "zcard",
  "zcount",
  "zlexcount",
  "zrank",
  "zrevrank",
  "zrandmember",
  // Lists
  "lrange",
  "llen",
  "lindex",
  "lpos",
  // Bitmaps / bitfields (read-only forms)
  "bitcount",
  "bitpos",
  "getbit",
  // HyperLogLog (PFCOUNT is read-only; PFADD/PFMERGE are writes)
  "pfcount",
  // Geo (read forms)
  "geopos",
  "geodist",
  "geohash",
  "geosearch",
  // Scanning
  "keys",
  "scan",
  "hscan",
  "sscan",
  "zscan",
  // Server / instance metadata
  "dbsize",
  "info",
  "ping",
  "echo",
  "time",
  "client getname",
  "client id",
  "client info",
  "client list",
  "config get",
  "command",
  "command count",
  "command info",
  "command list",
  "lastsave",
  "memory usage",
  "memory stats",
  "latency latest",
  "latency history",
  "latency graph",
  "debug object",
  "wait",
  // Cluster / replication metadata
  "cluster info",
  "cluster nodes",
  "cluster slots",
  "cluster shards",
  "cluster countkeysinslot",
  "cluster keyslot",
  "cluster myid",
  "role",
]);

// Some multi-word allowlist entries (CLIENT GETNAME, OBJECT ENCODING)
// span two tokens. Split the caller's `command` string and the args
// into a normalized form so we can do a deterministic lookup.
function normalizeCommandSpec(
  command: string,
  args: ReadonlyArray<string | number>,
): { canonical: string; trailingArgs: ReadonlyArray<string | number> } {
  const lowerCommand = command.trim().toLowerCase();
  if (lowerCommand.length === 0) {
    return { canonical: "", trailingArgs: args };
  }
  // Look for a two-word match (e.g. `CLIENT GETNAME`) where the
  // second word is the first arg. Falls back to the bare verb.
  const firstArg =
    args.length > 0 && typeof args[0] === "string"
      ? args[0].trim().toLowerCase()
      : null;
  if (firstArg) {
    const twoWord = `${lowerCommand} ${firstArg}`;
    if (READ_ONLY_COMMAND_ALLOWLIST.has(twoWord)) {
      return { canonical: twoWord, trailingArgs: args.slice(1) };
    }
  }
  return { canonical: lowerCommand, trailingArgs: args };
}

export class RedisCommandError extends Error {
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
    this.name = "RedisCommandError";
    this.code = code;
  }
}

const HARD_TIMEOUT_MS_CAP = 60_000;

export type CreateRedisCommandCallbackInput = {
  specialistName: string;
};

export function createRedisCommandCallback(
  input: CreateRedisCommandCallbackInput,
): RedisCommandCallback {
  return async (call) => {
    const resolved = await tryResolveConnection(call.connectionName);
    if (resolved.kind !== "redis") {
      throw new RedisCommandError(
        "wrong_kind",
        `connection '${call.connectionName}' is kind '${resolved.kind}', not 'redis'`,
      );
    }
    if (!scopeAllows(resolved.scope, input.specialistName)) {
      throw new RedisCommandError(
        "scope_denied",
        `connection '${call.connectionName}' is not in scope for specialist '${input.specialistName}'`,
      );
    }
    const { canonical, trailingArgs } = normalizeCommandSpec(
      call.command,
      call.args ?? [],
    );
    if (
      resolved.config.readOnly &&
      !READ_ONLY_COMMAND_ALLOWLIST.has(canonical)
    ) {
      throw new RedisCommandError(
        "read_only_violation",
        `connection '${call.connectionName}' is read-only; command '${canonical}' is not on the read-only allowlist`,
      );
    }
    return executeCommand({
      config: resolved.config,
      secrets: resolved.secrets,
      command: canonical,
      args: trailingArgs,
      timeoutMs: clampPositive(
        call.timeoutMs ?? resolved.config.defaultCommandTimeoutMs,
        HARD_TIMEOUT_MS_CAP,
      ),
    });
  };
}

async function tryResolveConnection(name: string): Promise<ResolvedConnection> {
  try {
    return await resolveToolConnection(name);
  } catch (err) {
    throw new RedisCommandError(
      "connection_not_resolvable",
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function executeCommand(input: {
  config: RedisConnectionConfig;
  secrets: RedisConnectionSecrets;
  command: string;
  args: ReadonlyArray<string | number>;
  timeoutMs: number;
}): Promise<{
  resultType: "string" | "number" | "array" | "object" | "null" | "boolean";
  result: unknown;
}> {
  const client = new Redis({
    host: input.config.host,
    port: input.config.port,
    db: input.config.db,
    ...(input.config.username !== undefined
      ? { username: input.config.username }
      : {}),
    ...(input.secrets.password !== undefined
      ? { password: input.secrets.password }
      : {}),
    tls: input.config.tls ? {} : undefined,
    // Short-circuit reconnects so a single bad call fails fast rather
    // than churning. The specialist run is short-lived; reconnect
    // logic belongs in long-running services, not per-call clients.
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: Math.min(input.timeoutMs, 5_000),
    commandTimeout: input.timeoutMs,
    lazyConnect: false,
  });
  // ioredis emits `error` events on the underlying EventEmitter
  // (ECONNREFUSED, TLS mismatch, DNS failure, AUTH rejection, etc.).
  // Without a listener Node treats it as an uncaught exception and
  // crashes the process — the try/catch around `client.call()` does
  // NOT catch EventEmitter errors. Attach a swallowing listener so
  // the failure surfaces only via the call rejection.
  client.on("error", () => {
    // Intentional no-op. The connection-failure detail comes back
    // through the rejected `client.call()` promise below.
  });
  try {
    // ioredis exposes generic command dispatch via `.call(command,
    // ...args)`. The command name may be multi-word (e.g.
    // "client getname"); split into a verb + remaining args so the
    // RESP frame is well-formed.
    const verbTokens = input.command.split(/\s+/);
    const verb = verbTokens[0]!;
    const subTokens = verbTokens.slice(1);
    const allArgs = [...subTokens, ...input.args].map((a) =>
      typeof a === "number" ? String(a) : a,
    );
    const raw = await client.call(verb, ...allArgs);
    return classifyResult(raw);
  } catch (err) {
    throw new RedisCommandError(
      "execution_failed",
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    // `disconnect()` is synchronous and closes the socket immediately.
    // `quit()` would wait for in-flight commands which is unnecessary
    // for our single-command, single-use client.
    client.disconnect();
  }
}

function classifyResult(value: unknown): {
  resultType: "string" | "number" | "array" | "object" | "null" | "boolean";
  result: unknown;
} {
  if (value === null) return { resultType: "null", result: null };
  if (typeof value === "string") return { resultType: "string", result: value };
  if (typeof value === "number") return { resultType: "number", result: value };
  if (typeof value === "boolean") {
    return { resultType: "boolean", result: value };
  }
  if (Array.isArray(value)) {
    return {
      resultType: "array",
      result: value.map((v) => normalizeElement(v)),
    };
  }
  if (Buffer.isBuffer(value)) {
    return { resultType: "string", result: value.toString("utf8") };
  }
  if (typeof value === "object") {
    return { resultType: "object", result: value };
  }
  // Coerce anything else (BigInt, etc.) to a string so the discriminated
  // output union stays well-formed.
  return { resultType: "string", result: String(value) };
}

// Element-wise normalization for arbitrarily-nested ioredis replies.
// SCAN/HSCAN/SSCAN/ZSCAN return `[cursor, [keys...]]` — flattening
// the inner array with `String(v)` would turn the key list into a
// comma-joined blob and silently corrupt every scanning result. Same
// for any future command that returns nested arrays.
function normalizeElement(value: unknown): unknown {
  if (value === null) return null;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (Array.isArray(value)) return value.map((v) => normalizeElement(v));
  if (typeof value === "object") return value;
  return String(value);
}
