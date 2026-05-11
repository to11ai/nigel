import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { db } from "@/lib/db/client";
import { toolConnections } from "@/lib/db/schema";
import { resetEncryptionKeyCacheForTests } from "./encryption";
import {
  createToolConnection,
  deleteToolConnection,
  getToolConnectionById,
  getToolConnectionByName,
  listToolConnections,
  resolveToolConnection,
  ToolConnectionRepositoryError,
  updateToolConnection,
} from "./repository";
import { ToolConnectionValidationError } from "./types";

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

const postgresFixture = () => ({
  name: "prod-pg-readonly",
  kind: "postgres" as const,
  description: "read-only replica",
  config: {
    host: "db.example.com",
    database: "appdb",
    user: "reader",
  },
  secrets: { password: "supersecret" },
});

describe("createToolConnection", () => {
  test("inserts a row and encrypts the secrets payload", async () => {
    const row = await createToolConnection(postgresFixture());
    expect(row.id).toBeTruthy();
    expect(row.name).toBe("prod-pg-readonly");
    expect(row.scope).toBe("global");
    // The persisted row stores ciphertext + auth tag + nonce, never
    // the plaintext password. Assert the password substring isn't
    // anywhere in the stored secrets blob.
    expect(row.secretsCiphertext.includes("supersecret")).toBe(false);
    expect(row.secretsNonce.length).toBeGreaterThan(0);
    expect(row.secretsAuthTag.length).toBeGreaterThan(0);
  });

  test("rejects a config that fails schema validation", async () => {
    await expect(
      createToolConnection({
        ...postgresFixture(),
        config: { host: "h" }, // missing database/user
      }),
    ).rejects.toBeInstanceOf(ToolConnectionValidationError);
  });

  test("rejects a duplicate name with ToolConnectionRepositoryError(name_taken)", async () => {
    await createToolConnection(postgresFixture());
    try {
      await createToolConnection(postgresFixture());
      throw new Error("expected duplicate to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ToolConnectionRepositoryError);
      expect((err as ToolConnectionRepositoryError).code).toBe("name_taken");
    }
  });

  test("honors a specialist scope on insert", async () => {
    const row = await createToolConnection({
      ...postgresFixture(),
      scope: { kind: "specialist", specialistName: "db-analyst" },
    });
    expect(row.scope).toBe("specialist:db-analyst");
  });
});

describe("resolveToolConnection", () => {
  test("returns the decrypted config + secrets", async () => {
    await createToolConnection(postgresFixture());
    const resolved = await resolveToolConnection("prod-pg-readonly");
    expect(resolved.kind).toBe("postgres");
    if (resolved.kind === "postgres") {
      expect(resolved.config.host).toBe("db.example.com");
      expect(resolved.config.port).toBe(5432);
      expect(resolved.config.sslMode).toBe("require");
      expect(resolved.secrets.password).toBe("supersecret");
    }
  });

  test("throws ToolConnectionRepositoryError(not_found) for an unknown name", async () => {
    try {
      await resolveToolConnection("nope");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ToolConnectionRepositoryError);
      expect((err as ToolConnectionRepositoryError).code).toBe("not_found");
    }
  });
});

describe("updateToolConnection", () => {
  test("re-encrypts secrets when the secrets field is supplied", async () => {
    const created = await createToolConnection(postgresFixture());
    const updated = await updateToolConnection({
      id: created.id,
      secrets: { password: "rotated" },
    });
    expect(updated.secretsCiphertext).not.toBe(created.secretsCiphertext);
    const resolved = await resolveToolConnection(created.name);
    if (resolved.kind === "postgres") {
      expect(resolved.secrets.password).toBe("rotated");
    }
  });

  test("leaves secrets untouched when only config is supplied", async () => {
    const created = await createToolConnection(postgresFixture());
    const updated = await updateToolConnection({
      id: created.id,
      config: { ...postgresFixture().config, port: 6543 },
    });
    expect(updated.secretsCiphertext).toBe(created.secretsCiphertext);
    expect(updated.secretsNonce).toBe(created.secretsNonce);
  });

  test("rejects update for a missing id", async () => {
    await expect(
      updateToolConnection({ id: "no_such_id", description: "x" }),
    ).rejects.toBeInstanceOf(ToolConnectionRepositoryError);
  });
});

describe("deleteToolConnection", () => {
  test("removes the row", async () => {
    const created = await createToolConnection(postgresFixture());
    await deleteToolConnection(created.id);
    const after = await getToolConnectionById(created.id);
    expect(after).toBeNull();
  });

  test("throws for a missing id", async () => {
    await expect(deleteToolConnection("no_such_id")).rejects.toBeInstanceOf(
      ToolConnectionRepositoryError,
    );
  });
});

describe("listToolConnections / getToolConnectionByName", () => {
  test("listToolConnections returns every row", async () => {
    await createToolConnection(postgresFixture());
    await createToolConnection({
      ...postgresFixture(),
      name: "second",
    });
    const rows = await listToolConnections();
    expect(rows.map((r) => r.name).sort()).toEqual([
      "prod-pg-readonly",
      "second",
    ]);
  });

  test("getToolConnectionByName returns the matching row", async () => {
    await createToolConnection(postgresFixture());
    const found = await getToolConnectionByName("prod-pg-readonly");
    expect(found).not.toBeNull();
    expect(found?.kind).toBe("postgres");
  });
});
