import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { db } from "@/lib/db/client";
import { toolConnections } from "@/lib/db/schema";
import { createToolConnection } from "@/lib/tool-connections";
import { resetEncryptionKeyCacheForTests } from "@/lib/tool-connections/encryption";
import { createMcpCallCallback, McpCallError } from "./mcp-call";

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

const seedHttpMcpConnection = async (
  overrides: {
    name?: string;
    scope?: { kind: "global" } | { kind: "specialist"; specialistName: string };
    url?: string;
  } = {},
) => {
  return createToolConnection({
    name: overrides.name ?? "test-mcp-http",
    kind: "mcp",
    config: {
      transport: "http",
      url: overrides.url ?? "http://127.0.0.1:1/mcp",
    },
    secrets: {},
    ...(overrides.scope ? { scope: overrides.scope } : {}),
  });
};

describe("createMcpCallCallback — pre-execute checks", () => {
  test("throws connection_not_resolvable for an unknown name", async () => {
    const cb = createMcpCallCallback({ specialistName: "data-analyst" });
    try {
      await cb({
        connectionName: "no_such",
        operation: { type: "list_tools" },
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(McpCallError);
      expect((err as McpCallError).code).toBe("connection_not_resolvable");
    }
  });

  test("throws wrong_kind for a postgres-kind connection", async () => {
    await createToolConnection({
      name: "test-pg",
      kind: "postgres",
      config: { host: "127.0.0.1", database: "appdb", user: "reader" },
      secrets: { password: "x" },
    });
    const cb = createMcpCallCallback({ specialistName: "data-analyst" });
    try {
      await cb({
        connectionName: "test-pg",
        operation: { type: "list_tools" },
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(McpCallError);
      expect((err as McpCallError).code).toBe("wrong_kind");
    }
  });

  test("throws scope_denied when specialist scope mismatches", async () => {
    await seedHttpMcpConnection({
      scope: { kind: "specialist", specialistName: "other" },
    });
    const cb = createMcpCallCallback({ specialistName: "data-analyst" });
    try {
      await cb({
        connectionName: "test-mcp-http",
        operation: { type: "list_tools" },
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(McpCallError);
      expect((err as McpCallError).code).toBe("scope_denied");
    }
  });

  test("permits a global-scoped connection regardless of specialist name", async () => {
    await seedHttpMcpConnection({ scope: { kind: "global" } });
    const cb = createMcpCallCallback({ specialistName: "data-analyst" });
    try {
      await cb({
        connectionName: "test-mcp-http",
        operation: { type: "list_tools" },
      });
      throw new Error("expected execution failure");
    } catch (err) {
      // Scope + kind pass; the transport then fails to connect to
      // 127.0.0.1:1 because nothing's listening. That tells us the
      // pre-execute gates passed.
      expect((err as McpCallError).code).toBe("execution_failed");
    }
  });

  test("permits a specialist-scoped connection whose name matches", async () => {
    await seedHttpMcpConnection({
      scope: { kind: "specialist", specialistName: "data-analyst" },
    });
    const cb = createMcpCallCallback({ specialistName: "data-analyst" });
    try {
      await cb({
        connectionName: "test-mcp-http",
        operation: { type: "list_tools" },
      });
      throw new Error("expected execution failure");
    } catch (err) {
      expect((err as McpCallError).code).toBe("execution_failed");
    }
  });
});
