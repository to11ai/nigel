import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { db } from "@/lib/db/client";
import { toolConnections } from "@/lib/db/schema";
import { createToolConnection } from "@/lib/tool-connections";
import { resetEncryptionKeyCacheForTests } from "@/lib/tool-connections/encryption";
import {
  ClickhouseQueryError,
  createClickhouseQueryCallback,
} from "./clickhouse-query";

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

const seedClickhouseConnection = async (
  overrides: {
    name?: string;
    scope?: { kind: "global" } | { kind: "specialist"; specialistName: string };
    readOnly?: boolean;
  } = {},
) => {
  return createToolConnection({
    name: overrides.name ?? "test-ch",
    kind: "clickhouse",
    config: {
      host: "127.0.0.1",
      protocol: "http",
      port: 18123,
      database: "default",
      user: "reader",
      readOnly: overrides.readOnly ?? true,
    },
    secrets: { password: "ignored-the-callback-never-connects-in-these-tests" },
    ...(overrides.scope ? { scope: overrides.scope } : {}),
  });
};

describe("createClickhouseQueryCallback — pre-execute checks", () => {
  test("throws connection_not_resolvable for an unknown name", async () => {
    const cb = createClickhouseQueryCallback({
      specialistName: "data-analyst",
    });
    try {
      await cb({ connectionName: "no_such", sql: "SELECT 1" });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ClickhouseQueryError);
      expect((err as ClickhouseQueryError).code).toBe(
        "connection_not_resolvable",
      );
    }
  });

  test("throws wrong_kind for a postgres-kind connection", async () => {
    await createToolConnection({
      name: "test-pg",
      kind: "postgres",
      config: { host: "127.0.0.1", database: "appdb", user: "reader" },
      secrets: { password: "x" },
    });
    const cb = createClickhouseQueryCallback({
      specialistName: "data-analyst",
    });
    try {
      await cb({ connectionName: "test-pg", sql: "SELECT 1" });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ClickhouseQueryError);
      expect((err as ClickhouseQueryError).code).toBe("wrong_kind");
    }
  });

  test("throws scope_denied when specialist scope mismatches", async () => {
    await seedClickhouseConnection({
      scope: { kind: "specialist", specialistName: "other-analyst" },
    });
    const cb = createClickhouseQueryCallback({
      specialistName: "data-analyst",
    });
    try {
      await cb({ connectionName: "test-ch", sql: "SELECT 1" });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ClickhouseQueryError);
      expect((err as ClickhouseQueryError).code).toBe("scope_denied");
    }
  });

  test("permits a global-scoped connection regardless of specialist name", async () => {
    await seedClickhouseConnection({ scope: { kind: "global" } });
    const cb = createClickhouseQueryCallback({
      specialistName: "data-analyst",
    });
    try {
      await cb({ connectionName: "test-ch", sql: "SELECT 1" });
      throw new Error("expected throw");
    } catch (err) {
      // Read-only verb passes; executor then fails because no server
      // listens on 127.0.0.1:18123. That tells us the scope check
      // passed.
      expect((err as ClickhouseQueryError).code).toBe("execution_failed");
    }
  });
});

describe("createClickhouseQueryCallback — read-only enforcement", () => {
  test("rejects INSERT on a read-only connection", async () => {
    await seedClickhouseConnection({ readOnly: true });
    const cb = createClickhouseQueryCallback({
      specialistName: "data-analyst",
    });
    await expect(
      cb({
        connectionName: "test-ch",
        sql: "INSERT INTO events (id) VALUES (1)",
      }),
    ).rejects.toMatchObject({ code: "read_only_violation" });
  });

  test("rejects OPTIMIZE TABLE on a read-only connection", async () => {
    await seedClickhouseConnection({ readOnly: true });
    const cb = createClickhouseQueryCallback({
      specialistName: "data-analyst",
    });
    await expect(
      cb({ connectionName: "test-ch", sql: "OPTIMIZE TABLE events FINAL" }),
    ).rejects.toMatchObject({ code: "read_only_violation" });
  });

  test("rejects SYSTEM RELOAD CONFIG on a read-only connection", async () => {
    await seedClickhouseConnection({ readOnly: true });
    const cb = createClickhouseQueryCallback({
      specialistName: "data-analyst",
    });
    await expect(
      cb({ connectionName: "test-ch", sql: "SYSTEM RELOAD CONFIG" }),
    ).rejects.toMatchObject({ code: "read_only_violation" });
  });

  test("rejects ATTACH TABLE on a read-only connection", async () => {
    await seedClickhouseConnection({ readOnly: true });
    const cb = createClickhouseQueryCallback({
      specialistName: "data-analyst",
    });
    await expect(
      cb({ connectionName: "test-ch", sql: "ATTACH TABLE x" }),
    ).rejects.toMatchObject({ code: "read_only_violation" });
  });

  test("rejects WITH … INSERT CTE on a read-only connection", async () => {
    await seedClickhouseConnection({ readOnly: true });
    const cb = createClickhouseQueryCallback({
      specialistName: "data-analyst",
    });
    await expect(
      cb({
        connectionName: "test-ch",
        sql: "WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x",
      }),
    ).rejects.toMatchObject({ code: "read_only_violation" });
  });

  test("rejects SELECT * INTO OUTFILE on a read-only connection", async () => {
    await seedClickhouseConnection({ readOnly: true });
    const cb = createClickhouseQueryCallback({
      specialistName: "data-analyst",
    });
    await expect(
      cb({
        connectionName: "test-ch",
        sql: "SELECT * INTO OUTFILE '/tmp/x.tsv' FROM events",
      }),
    ).rejects.toMatchObject({ code: "read_only_violation" });
  });

  test("accepts SHOW TABLES on a read-only connection", async () => {
    await seedClickhouseConnection({ readOnly: true });
    const cb = createClickhouseQueryCallback({
      specialistName: "data-analyst",
    });
    try {
      await cb({ connectionName: "test-ch", sql: "SHOW TABLES" });
      throw new Error("expected execution failure");
    } catch (err) {
      expect((err as ClickhouseQueryError).code).toBe("execution_failed");
    }
  });

  test("accepts DESCRIBE TABLE on a read-only connection", async () => {
    await seedClickhouseConnection({ readOnly: true });
    const cb = createClickhouseQueryCallback({
      specialistName: "data-analyst",
    });
    try {
      await cb({ connectionName: "test-ch", sql: "DESC TABLE events" });
      throw new Error("expected execution failure");
    } catch (err) {
      expect((err as ClickhouseQueryError).code).toBe("execution_failed");
    }
  });

  test("does NOT reject a SELECT that contains a write keyword inside a string literal", async () => {
    await seedClickhouseConnection({ readOnly: true });
    const cb = createClickhouseQueryCallback({
      specialistName: "data-analyst",
    });
    try {
      await cb({
        connectionName: "test-ch",
        sql: "SELECT * FROM events WHERE message = 'INSERT INTO logs'",
      });
      throw new Error("expected execution failure");
    } catch (err) {
      expect((err as ClickhouseQueryError).code).toBe("execution_failed");
    }
  });

  test("does NOT reject a SELECT against a backtick-quoted identifier matching a write keyword", async () => {
    await seedClickhouseConnection({ readOnly: true });
    const cb = createClickhouseQueryCallback({
      specialistName: "data-analyst",
    });
    try {
      await cb({
        connectionName: "test-ch",
        sql: "SELECT * FROM `insert_log` WHERE id = 1",
      });
      throw new Error("expected execution failure");
    } catch (err) {
      expect((err as ClickhouseQueryError).code).toBe("execution_failed");
    }
  });
});
