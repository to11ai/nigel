import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db/client";
import {
  type NewToolConnection,
  type ToolConnection,
  toolConnections,
} from "@/lib/db/schema";
import {
  decryptSecrets,
  type EncryptedSecrets,
  encryptSecrets,
} from "./encryption";
import {
  formatScope,
  parseScope,
  type ResolvedConnection,
  type ToolConnectionKind,
  type ToolConnectionScope,
  validateConfigForKind,
  validateSecretsForKind,
} from "./types";

// Single error class for repository-layer failures so this file stays
// under the "one class per file" lint rule. Discriminate via `code`.
export class ToolConnectionRepositoryError extends Error {
  readonly code: "not_found" | "name_taken";
  constructor(code: "not_found" | "name_taken", message: string) {
    super(message);
    this.name = "ToolConnectionRepositoryError";
    this.code = code;
  }

  static notFound(query: string): ToolConnectionRepositoryError {
    return new ToolConnectionRepositoryError(
      "not_found",
      `tool connection not found: ${query}`,
    );
  }

  static nameTaken(name: string): ToolConnectionRepositoryError {
    return new ToolConnectionRepositoryError(
      "name_taken",
      `tool connection name '${name}' is already in use`,
    );
  }
}

export type CreateToolConnectionInput = {
  name: string;
  kind: ToolConnectionKind;
  description?: string | null;
  config: unknown;
  secrets: unknown;
  scope?: ToolConnectionScope;
  createdBy?: string | null;
};

export async function createToolConnection(
  input: CreateToolConnectionInput,
): Promise<ToolConnection> {
  // Validate before encrypting so we don't waste a key op on bad
  // input and so the error surfaces against the input field, not the
  // ciphertext.
  const config = validateConfigForKind(input.kind, input.config);
  const secrets = validateSecretsForKind(input.kind, input.secrets);
  const encrypted = encryptSecrets(secrets);
  const row: NewToolConnection = {
    id: nanoid(),
    name: input.name,
    kind: input.kind,
    description: input.description ?? null,
    configJson: config,
    secretsCiphertext: encrypted.ciphertext,
    secretsNonce: encrypted.nonce,
    secretsAuthTag: encrypted.authTag,
    keyVersion: encrypted.keyVersion,
    scope: formatScope(input.scope ?? { kind: "global" }),
    createdBy: input.createdBy ?? null,
  };
  try {
    const [inserted] = await db.insert(toolConnections).values(row).returning();
    if (!inserted) {
      throw new Error("tool_connections insert returned no row");
    }
    return inserted;
  } catch (err) {
    if (isUniqueConstraintError(err, "tool_connections_name_idx")) {
      throw ToolConnectionRepositoryError.nameTaken(input.name);
    }
    throw err;
  }
}

export type UpdateToolConnectionInput = {
  id: string;
  // Each field is optional — partial updates only touch what's supplied.
  description?: string | null;
  config?: unknown;
  secrets?: unknown;
  scope?: ToolConnectionScope;
};

export async function updateToolConnection(
  input: UpdateToolConnectionInput,
): Promise<ToolConnection> {
  const existing = await getToolConnectionById(input.id);
  if (!existing) throw ToolConnectionRepositoryError.notFound(input.id);

  const patch: Partial<NewToolConnection> = { updatedAt: new Date() };
  if (input.description !== undefined) patch.description = input.description;
  if (input.config !== undefined) {
    patch.configJson = validateConfigForKind(
      existing.kind as ToolConnectionKind,
      input.config,
    );
  }
  if (input.secrets !== undefined) {
    const secrets = validateSecretsForKind(
      existing.kind as ToolConnectionKind,
      input.secrets,
    );
    const encrypted = encryptSecrets(secrets);
    patch.secretsCiphertext = encrypted.ciphertext;
    patch.secretsNonce = encrypted.nonce;
    patch.secretsAuthTag = encrypted.authTag;
    patch.keyVersion = encrypted.keyVersion;
  }
  if (input.scope !== undefined) patch.scope = formatScope(input.scope);

  const [updated] = await db
    .update(toolConnections)
    .set(patch)
    .where(eq(toolConnections.id, input.id))
    .returning();
  if (!updated) throw ToolConnectionRepositoryError.notFound(input.id);
  return updated;
}

export async function deleteToolConnection(id: string): Promise<void> {
  const result = await db
    .delete(toolConnections)
    .where(eq(toolConnections.id, id))
    .returning({ id: toolConnections.id });
  if (result.length === 0) {
    throw ToolConnectionRepositoryError.notFound(id);
  }
}

export async function getToolConnectionById(
  id: string,
): Promise<ToolConnection | null> {
  const rows = await db
    .select()
    .from(toolConnections)
    .where(eq(toolConnections.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function getToolConnectionByName(
  name: string,
): Promise<ToolConnection | null> {
  const rows = await db
    .select()
    .from(toolConnections)
    .where(eq(toolConnections.name, name))
    .limit(1);
  return rows[0] ?? null;
}

export async function listToolConnections(): Promise<ToolConnection[]> {
  return db.select().from(toolConnections);
}

// Returns a fully-resolved connection — config + decrypted secrets +
// parsed scope — keyed by the connection's `name` (the field tools
// reference). This is the only path that decrypts; admin
// CRUD reads/writes are non-decrypting.
export async function resolveToolConnection(
  name: string,
): Promise<ResolvedConnection> {
  const row = await getToolConnectionByName(name);
  if (!row) throw ToolConnectionRepositoryError.notFound(name);
  return decryptRow(row);
}

export function decryptRow(row: ToolConnection): ResolvedConnection {
  const kind = row.kind as ToolConnectionKind;
  const config = validateConfigForKind(kind, row.configJson);
  const encrypted: EncryptedSecrets = {
    ciphertext: row.secretsCiphertext,
    nonce: row.secretsNonce,
    authTag: row.secretsAuthTag,
    keyVersion: row.keyVersion as 1,
  };
  const secrets = validateSecretsForKind(kind, decryptSecrets(encrypted));
  // Parse scope eagerly so callers can match against it without
  // re-validating on each tool invocation.
  parseScope(row.scope);
  // The cast is sound: the per-kind discriminated union above lines
  // up exactly with the validated config/secrets pair. TS can't
  // narrow through the generic accessor, so we tell it directly.
  return {
    id: row.id,
    name: row.name,
    kind,
    scope: row.scope,
    config,
    secrets,
  } as ResolvedConnection;
}

function isUniqueConstraintError(err: unknown, indexName: string): boolean {
  if (!err || typeof err !== "object") return false;
  // postgres-js surfaces unique violations with `code = '23505'` and
  // includes the constraint name in the message. Either signal is
  // enough on its own.
  const e = err as {
    code?: string;
    constraint?: string;
    constraint_name?: string;
    message?: string;
  };
  if (e.code !== "23505") return false;
  const constraint = e.constraint ?? e.constraint_name ?? "";
  if (constraint === indexName) return true;
  return typeof e.message === "string" && e.message.includes(indexName);
}
