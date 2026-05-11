import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { createToolConnection } from "@/lib/tool-connections";
import { resetEncryptionKeyCacheForTests } from "@/lib/tool-connections/encryption";
import { db } from "@/lib/db/client";
import { toolConnections } from "@/lib/db/schema";
import {
  createDatabaseQueryCallback,
  DatabaseQueryError,
} from "./database-query";

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

const seedPostgresConnection = async (
  overrides: {
    name?: string;
    scope?: { kind: "global" } | { kind: "specialist"; specialistName: string };
    readOnly?: boolean;
  } = {},
) => {
  return createToolConnection({
    name: overrides.name ?? "test-pg",
    kind: "postgres",
    config: {
      host: "127.0.0.1",
      database: "appdb",
      user: "reader",
      readOnly: overrides.readOnly ?? true,
    },
    secrets: { password: "ignored-the-callback-never-connects-in-these-tests" },
    ...(overrides.scope ? { scope: overrides.scope } : {}),
  });
};

describe("createDatabaseQueryCallback — pre-execute checks", () => {
  test("throws connection_not_resolvable for an unknown name", async () => {
    const cb = createDatabaseQueryCallback({ specialistName: "db-analyst" });
    try {
      await cb({ connectionName: "no_such", sql: "SELECT 1" });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DatabaseQueryError);
      expect((err as DatabaseQueryError).code).toBe(
        "connection_not_resolvable",
      );
    }
  });

  test("throws scope_denied when specialist scope mismatches", async () => {
    await seedPostgresConnection({
      scope: { kind: "specialist", specialistName: "different-analyst" },
    });
    const cb = createDatabaseQueryCallback({ specialistName: "db-analyst" });
    try {
      await cb({ connectionName: "test-pg", sql: "SELECT 1" });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DatabaseQueryError);
      expect((err as DatabaseQueryError).code).toBe("scope_denied");
    }
  });

  test("permits a global-scoped connection regardless of specialist name", async () => {
    await seedPostgresConnection({ scope: { kind: "global" } });
    const cb = createDatabaseQueryCallback({ specialistName: "db-analyst" });
    // We don't actually connect; we just want the read-only check to
    // not throw before that point. A SELECT on a read-only connection
    // passes the verb check and proceeds to the connect attempt,
    // which will then fail with an execution_failed error. That tells
    // us the scope check passed.
    try {
      await cb({ connectionName: "test-pg", sql: "SELECT 1" });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DatabaseQueryError);
      expect((err as DatabaseQueryError).code).toBe("execution_failed");
    }
  });

  test("permits a specialist-scoped connection whose name matches", async () => {
    await seedPostgresConnection({
      scope: { kind: "specialist", specialistName: "db-analyst" },
    });
    const cb = createDatabaseQueryCallback({ specialistName: "db-analyst" });
    try {
      await cb({ connectionName: "test-pg", sql: "SELECT 1" });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DatabaseQueryError);
      expect((err as DatabaseQueryError).code).toBe("execution_failed");
    }
  });
});

describe("createDatabaseQueryCallback — read-only enforcement", () => {
  test("rejects INSERT on a read-only connection", async () => {
    await seedPostgresConnection({ readOnly: true });
    const cb = createDatabaseQueryCallback({ specialistName: "db-analyst" });
    try {
      await cb({
        connectionName: "test-pg",
        sql: "INSERT INTO t (a) VALUES (1)",
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DatabaseQueryError);
      expect((err as DatabaseQueryError).code).toBe("read_only_violation");
    }
  });

  test("rejects UPDATE on a read-only connection", async () => {
    await seedPostgresConnection({ readOnly: true });
    const cb = createDatabaseQueryCallback({ specialistName: "db-analyst" });
    await expect(
      cb({ connectionName: "test-pg", sql: "UPDATE t SET a = 1" }),
    ).rejects.toMatchObject({ code: "read_only_violation" });
  });

  test("strips leading /* … */ comments before classifying the verb", async () => {
    await seedPostgresConnection({ readOnly: true });
    const cb = createDatabaseQueryCallback({ specialistName: "db-analyst" });
    await expect(
      cb({
        connectionName: "test-pg",
        sql: "/* try to sneak past */ INSERT INTO t (a) VALUES (1)",
      }),
    ).rejects.toMatchObject({ code: "read_only_violation" });
  });

  test("strips leading -- comments before classifying the verb", async () => {
    await seedPostgresConnection({ readOnly: true });
    const cb = createDatabaseQueryCallback({ specialistName: "db-analyst" });
    await expect(
      cb({
        connectionName: "test-pg",
        sql: "-- sneaky\nDELETE FROM t",
      }),
    ).rejects.toMatchObject({ code: "read_only_violation" });
  });

  test("accepts SELECT prefixed with leading whitespace + comments", async () => {
    await seedPostgresConnection({ readOnly: true });
    const cb = createDatabaseQueryCallback({ specialistName: "db-analyst" });
    // Passes the verb check → proceeds to connect → execution_failed
    // because there's no real Postgres at 127.0.0.1.
    try {
      await cb({
        connectionName: "test-pg",
        sql: "  /* header */\n-- comment\nSELECT 1",
      });
      throw new Error("expected execution failure");
    } catch (err) {
      expect((err as DatabaseQueryError).code).toBe("execution_failed");
    }
  });

  test("accepts WITH … SELECT (CTE) on a read-only connection", async () => {
    await seedPostgresConnection({ readOnly: true });
    const cb = createDatabaseQueryCallback({ specialistName: "db-analyst" });
    try {
      await cb({
        connectionName: "test-pg",
        sql: "WITH x AS (SELECT 1) SELECT * FROM x",
      });
      throw new Error("expected execution failure");
    } catch (err) {
      expect((err as DatabaseQueryError).code).toBe("execution_failed");
    }
  });

  test("does not enforce read-only on a writable connection", async () => {
    await seedPostgresConnection({ readOnly: false });
    const cb = createDatabaseQueryCallback({ specialistName: "db-analyst" });
    // INSERT now reaches the executor stage (which then fails to
    // connect to the fake host) — proves the read-only gate was
    // skipped.
    try {
      await cb({
        connectionName: "test-pg",
        sql: "INSERT INTO t (a) VALUES (1)",
      });
      throw new Error("expected execution failure");
    } catch (err) {
      expect((err as DatabaseQueryError).code).toBe("execution_failed");
    }
  });
});

describe("createDatabaseQueryCallback — non-postgres kinds", () => {
  test("throws wrong_kind on a non-postgres connection", async () => {
    await createToolConnection({
      name: "test-slack",
      kind: "slack",
      config: { channel: "#ops" },
      secrets: { webhookUrl: "https://hooks.slack.com/services/T/B/X" },
    });
    const cb = createDatabaseQueryCallback({ specialistName: "db-analyst" });
    try {
      await cb({ connectionName: "test-slack", sql: "SELECT 1" });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DatabaseQueryError);
      expect((err as DatabaseQueryError).code).toBe("wrong_kind");
    }
  });
});
