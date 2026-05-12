import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { db } from "@/lib/db/client";
import { toolConnections } from "@/lib/db/schema";
import { createToolConnection } from "@/lib/tool-connections";
import { resetEncryptionKeyCacheForTests } from "@/lib/tool-connections/encryption";
import { createRedisCommandCallback, RedisCommandError } from "./redis-command";

const ORIGINAL_KEY = process.env.TOOL_CONNECTIONS_ENC_KEY;
const TEST_KEY_B64 = randomBytes(32).toString("base64");

beforeEach(async () => {
  process.env.TOOL_CONNECTIONS_ENC_KEY = TEST_KEY_B64;
  resetEncryptionKeyCacheForTests();
  await db.delete(toolConnections);
});

afterEach(() => {
  if (ORIGINAL_KEY === undefined) {
    delete process.env.TOOL_CONNECTIONS_ENC_KEY;
  } else {
    process.env.TOOL_CONNECTIONS_ENC_KEY = ORIGINAL_KEY;
  }
  resetEncryptionKeyCacheForTests();
});

const seedRedisConnection = async (
  overrides: {
    name?: string;
    scope?: { kind: "global" } | { kind: "specialist"; specialistName: string };
    readOnly?: boolean;
  } = {},
) => {
  return createToolConnection({
    name: overrides.name ?? "test-redis",
    kind: "redis",
    config: {
      host: "127.0.0.1",
      // Pick a port nothing listens on so the executor fails fast.
      port: 16379,
      tls: false,
      readOnly: overrides.readOnly ?? true,
    },
    secrets: { password: "ignored-the-callback-never-connects-in-these-tests" },
    ...(overrides.scope ? { scope: overrides.scope } : {}),
  });
};

describe("createRedisCommandCallback — pre-execute checks", () => {
  test("throws connection_not_resolvable for an unknown name", async () => {
    const cb = createRedisCommandCallback({ specialistName: "data-analyst" });
    try {
      await cb({ connectionName: "no_such", command: "GET", args: ["k"] });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RedisCommandError);
      expect((err as RedisCommandError).code).toBe("connection_not_resolvable");
    }
  });

  test("throws wrong_kind for a postgres-kind connection", async () => {
    await createToolConnection({
      name: "test-pg",
      kind: "postgres",
      config: { host: "127.0.0.1", database: "appdb", user: "reader" },
      secrets: { password: "x" },
    });
    const cb = createRedisCommandCallback({ specialistName: "data-analyst" });
    try {
      await cb({ connectionName: "test-pg", command: "GET", args: ["k"] });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RedisCommandError);
      expect((err as RedisCommandError).code).toBe("wrong_kind");
    }
  });

  test("throws scope_denied when specialist scope mismatches", async () => {
    await seedRedisConnection({
      scope: { kind: "specialist", specialistName: "other-analyst" },
    });
    const cb = createRedisCommandCallback({ specialistName: "data-analyst" });
    try {
      await cb({ connectionName: "test-redis", command: "GET", args: ["k"] });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RedisCommandError);
      expect((err as RedisCommandError).code).toBe("scope_denied");
    }
  });

  test("permits a global-scoped connection regardless of specialist name", async () => {
    await seedRedisConnection({ scope: { kind: "global" } });
    const cb = createRedisCommandCallback({ specialistName: "data-analyst" });
    try {
      await cb({ connectionName: "test-redis", command: "GET", args: ["k"] });
      throw new Error("expected throw");
    } catch (err) {
      // Scope passes; allowlist check passes (GET is read-only);
      // executor then fails because no Redis at 127.0.0.1:16379.
      expect((err as RedisCommandError).code).toBe("execution_failed");
    }
  });
});

describe("createRedisCommandCallback — read-only allowlist", () => {
  test("accepts GET on a read-only connection", async () => {
    await seedRedisConnection({ readOnly: true });
    const cb = createRedisCommandCallback({ specialistName: "data-analyst" });
    try {
      await cb({ connectionName: "test-redis", command: "GET", args: ["k"] });
      throw new Error("expected execution failure");
    } catch (err) {
      expect((err as RedisCommandError).code).toBe("execution_failed");
    }
  });

  test("accepts SCAN on a read-only connection", async () => {
    await seedRedisConnection({ readOnly: true });
    const cb = createRedisCommandCallback({ specialistName: "data-analyst" });
    try {
      await cb({
        connectionName: "test-redis",
        command: "SCAN",
        args: [0, "MATCH", "user:*", "COUNT", 100],
      });
      throw new Error("expected execution failure");
    } catch (err) {
      expect((err as RedisCommandError).code).toBe("execution_failed");
    }
  });

  test("accepts case-insensitive command names (get / Get / GET)", async () => {
    await seedRedisConnection({ readOnly: true });
    const cb = createRedisCommandCallback({ specialistName: "data-analyst" });
    for (const c of ["get", "Get", "GET"]) {
      try {
        await cb({ connectionName: "test-redis", command: c, args: ["k"] });
        throw new Error("expected execution failure");
      } catch (err) {
        expect((err as RedisCommandError).code).toBe("execution_failed");
      }
    }
  });

  test("accepts multi-word allowlist entries (CLIENT GETNAME)", async () => {
    await seedRedisConnection({ readOnly: true });
    const cb = createRedisCommandCallback({ specialistName: "data-analyst" });
    try {
      await cb({
        connectionName: "test-redis",
        command: "CLIENT",
        args: ["GETNAME"],
      });
      throw new Error("expected execution failure");
    } catch (err) {
      expect((err as RedisCommandError).code).toBe("execution_failed");
    }
  });

  test("accepts CONFIG GET (multi-word) on a read-only connection", async () => {
    await seedRedisConnection({ readOnly: true });
    const cb = createRedisCommandCallback({ specialistName: "data-analyst" });
    try {
      await cb({
        connectionName: "test-redis",
        command: "CONFIG",
        args: ["GET", "maxmemory"],
      });
      throw new Error("expected execution failure");
    } catch (err) {
      expect((err as RedisCommandError).code).toBe("execution_failed");
    }
  });

  test("rejects SET on a read-only connection", async () => {
    await seedRedisConnection({ readOnly: true });
    const cb = createRedisCommandCallback({ specialistName: "data-analyst" });
    await expect(
      cb({
        connectionName: "test-redis",
        command: "SET",
        args: ["k", "v"],
      }),
    ).rejects.toMatchObject({ code: "read_only_violation" });
  });

  test("rejects DEL on a read-only connection", async () => {
    await seedRedisConnection({ readOnly: true });
    const cb = createRedisCommandCallback({ specialistName: "data-analyst" });
    await expect(
      cb({ connectionName: "test-redis", command: "DEL", args: ["k"] }),
    ).rejects.toMatchObject({ code: "read_only_violation" });
  });

  test("rejects FLUSHDB on a read-only connection", async () => {
    await seedRedisConnection({ readOnly: true });
    const cb = createRedisCommandCallback({ specialistName: "data-analyst" });
    await expect(
      cb({ connectionName: "test-redis", command: "FLUSHDB" }),
    ).rejects.toMatchObject({ code: "read_only_violation" });
  });

  test("rejects CLIENT SETNAME (multi-word write) on a read-only connection", async () => {
    await seedRedisConnection({ readOnly: true });
    const cb = createRedisCommandCallback({ specialistName: "data-analyst" });
    await expect(
      cb({
        connectionName: "test-redis",
        command: "CLIENT",
        args: ["SETNAME", "agent"],
      }),
    ).rejects.toMatchObject({ code: "read_only_violation" });
  });

  test("rejects EVAL on a read-only connection (script could write)", async () => {
    await seedRedisConnection({ readOnly: true });
    const cb = createRedisCommandCallback({ specialistName: "data-analyst" });
    await expect(
      cb({
        connectionName: "test-redis",
        command: "EVAL",
        args: ["return 1", 0],
      }),
    ).rejects.toMatchObject({ code: "read_only_violation" });
  });

  test("rejects empty command on a read-only connection", async () => {
    await seedRedisConnection({ readOnly: true });
    const cb = createRedisCommandCallback({ specialistName: "data-analyst" });
    await expect(
      cb({ connectionName: "test-redis", command: "   " }),
    ).rejects.toMatchObject({ code: "read_only_violation" });
  });

  test("does not enforce allowlist on a writable connection", async () => {
    await seedRedisConnection({ readOnly: false });
    const cb = createRedisCommandCallback({ specialistName: "data-analyst" });
    // SET is normally blocked; on a writable connection it should
    // reach the executor (which then fails to connect to the fake
    // host).
    try {
      await cb({
        connectionName: "test-redis",
        command: "SET",
        args: ["k", "v"],
      });
      throw new Error("expected execution failure");
    } catch (err) {
      expect((err as RedisCommandError).code).toBe("execution_failed");
    }
  });
});
