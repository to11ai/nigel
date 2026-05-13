import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db/client";
import {
  type LinearWorkspace,
  type NewLinearWorkspace,
  linearWorkspace,
} from "@/lib/db/schema";
import {
  decryptSecrets,
  encryptSecrets,
} from "@/lib/tool-connections/encryption";

// Phase 6 L1: persistence layer for the single Linear workspace row.
//
// One row per Nigel deployment, by design (spec section: "Linear
// integration is org-level; one Linear workspace per Nigel deployment").
// We don't enforce singleton via a CHECK constraint — the admin UI is
// the authoritative gate. The repository's `upsert` is the only
// supported create/update path so racing admin saves resolve to a
// single row keyed on `workspace_id`.
//
// Secrets (webhook signing secret + Linear OAuth access token) are
// AES-256-GCM encrypted at rest using the existing
// TOOL_CONNECTIONS_ENC_KEY. Reusing the key keeps operator surface
// flat — one key to rotate, one Pulumi secret to provision.

export type LinearWorkspaceSecrets = {
  // HMAC signing secret. Linear sends this in `Linear-Signature` on
  // every webhook delivery; we verify before doing anything else with
  // the payload.
  webhookSecret: string;
  // Linear OAuth access token for outbound calls (commentCreate,
  // issueUpdate for reassignment, etc.). Stored alongside the
  // webhook secret because both are tied to the same workspace
  // install.
  accessToken: string;
};

export type LinearTeamRepoMap = Readonly<Record<string, string>>;

export type ResolvedLinearWorkspace = {
  id: string;
  workspaceId: string;
  botUserId: string;
  teamRepoMap: LinearTeamRepoMap;
  secrets: LinearWorkspaceSecrets;
  createdAt: Date;
  updatedAt: Date;
};

// Public, secret-free shape returned to the admin UI / observability
// layer. The encrypted blob is intentionally NOT serialized here —
// callers that need the decrypted secrets must go through
// `resolveLinearWorkspace`, which is server-only.
export type LinearWorkspaceListItem = {
  id: string;
  workspaceId: string;
  botUserId: string;
  teamRepoMap: LinearTeamRepoMap;
  createdAt: Date;
  updatedAt: Date;
};

export class LinearWorkspaceRepositoryError extends Error {
  readonly code: "not_found" | "already_exists";
  constructor(code: "not_found" | "already_exists", message: string) {
    super(message);
    this.name = "LinearWorkspaceRepositoryError";
    this.code = code;
  }
  static notFound(query: string): LinearWorkspaceRepositoryError {
    return new LinearWorkspaceRepositoryError(
      "not_found",
      `linear workspace not found: ${query}`,
    );
  }
  static alreadyExists(workspaceId: string): LinearWorkspaceRepositoryError {
    return new LinearWorkspaceRepositoryError(
      "already_exists",
      `linear workspace with workspace_id '${workspaceId}' already exists`,
    );
  }
}

export type CreateLinearWorkspaceInput = {
  workspaceId: string;
  botUserId: string;
  secrets: LinearWorkspaceSecrets;
  teamRepoMap?: LinearTeamRepoMap;
};

// Inserts a new workspace row. Split from update to keep the path
// atomic — an earlier `upsert` implementation that read-then-inserted
// raced on concurrent admin saves and could throw a 23505 unique-
// constraint violation under load. With separate create + update,
// the unique index on `workspace_id` cleanly fails the second
// concurrent insert with a typed `already_exists` error the admin
// UI can show as "row was just created by another admin — refresh".
export async function createLinearWorkspace(
  input: CreateLinearWorkspaceInput,
): Promise<LinearWorkspace> {
  const encrypted = encryptSecrets(input.secrets);
  const row: NewLinearWorkspace = {
    id: nanoid(),
    workspaceId: input.workspaceId,
    botUserId: input.botUserId,
    secretsCiphertext: encrypted.ciphertext,
    secretsNonce: encrypted.nonce,
    secretsAuthTag: encrypted.authTag,
    keyVersion: encrypted.keyVersion,
    teamRepoMap: input.teamRepoMap ?? {},
  };
  try {
    const [inserted] = await db.insert(linearWorkspace).values(row).returning();
    if (!inserted) {
      throw new Error("createLinearWorkspace: insert returned no row");
    }
    return inserted;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw LinearWorkspaceRepositoryError.alreadyExists(input.workspaceId);
    }
    throw err;
  }
}

export type UpdateLinearWorkspaceInput = {
  id: string;
  botUserId?: string;
  teamRepoMap?: LinearTeamRepoMap;
  // Patch semantics: passing `undefined` (or omitting) preserves the
  // existing encrypted payload. The admin UI uses this to allow
  // editing non-secret fields without re-supplying credentials.
  secrets?: LinearWorkspaceSecrets;
};

export async function updateLinearWorkspace(
  input: UpdateLinearWorkspaceInput,
): Promise<LinearWorkspace> {
  const patch: Partial<NewLinearWorkspace> = { updatedAt: new Date() };
  if (input.botUserId !== undefined) patch.botUserId = input.botUserId;
  if (input.teamRepoMap !== undefined) patch.teamRepoMap = input.teamRepoMap;
  if (input.secrets !== undefined) {
    const encrypted = encryptSecrets(input.secrets);
    patch.secretsCiphertext = encrypted.ciphertext;
    patch.secretsNonce = encrypted.nonce;
    patch.secretsAuthTag = encrypted.authTag;
    patch.keyVersion = encrypted.keyVersion;
  }
  const [updated] = await db
    .update(linearWorkspace)
    .set(patch)
    .where(eq(linearWorkspace.id, input.id))
    .returning();
  if (!updated) throw LinearWorkspaceRepositoryError.notFound(input.id);
  return updated;
}

// postgres-js surfaces Postgres errors as objects with a `code`
// string field. 23505 is the SQLSTATE for `unique_violation`. We
// check defensively rather than instanceof-matching a vendor type
// so the helper survives a future driver swap.
function isUniqueViolation(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === "object" &&
    "code" in err &&
    (err as { code: unknown }).code === "23505"
  );
}

export async function getLinearWorkspace(): Promise<LinearWorkspace | null> {
  const rows = await db.select().from(linearWorkspace).limit(1);
  return rows[0] ?? null;
}

export async function getLinearWorkspaceByWorkspaceId(
  workspaceId: string,
): Promise<LinearWorkspace | null> {
  const rows = await db
    .select()
    .from(linearWorkspace)
    .where(eq(linearWorkspace.workspaceId, workspaceId))
    .limit(1);
  return rows[0] ?? null;
}

// Returns the workspace plus decrypted secrets. Server-only — the
// secrets must never leak to a client component. Used by:
//   - the webhook handler (needs `webhookSecret` for HMAC verify)
//   - lifecycle hooks posting to Linear (needs `accessToken`)
export async function resolveLinearWorkspace(): Promise<ResolvedLinearWorkspace | null> {
  const row = await getLinearWorkspace();
  if (!row) return null;
  return rowToResolved(row);
}

export async function deleteLinearWorkspace(id: string): Promise<void> {
  const result = await db
    .delete(linearWorkspace)
    .where(eq(linearWorkspace.id, id))
    .returning({ id: linearWorkspace.id });
  if (result.length === 0) {
    throw LinearWorkspaceRepositoryError.notFound(id);
  }
}

export function rowToListItem(row: LinearWorkspace): LinearWorkspaceListItem {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    botUserId: row.botUserId,
    teamRepoMap: coerceTeamRepoMap(row.teamRepoMap),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToResolved(row: LinearWorkspace): ResolvedLinearWorkspace {
  const secrets = decryptSecrets<LinearWorkspaceSecrets>({
    ciphertext: row.secretsCiphertext,
    nonce: row.secretsNonce,
    authTag: row.secretsAuthTag,
    keyVersion: row.keyVersion as 1,
  });
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    botUserId: row.botUserId,
    teamRepoMap: coerceTeamRepoMap(row.teamRepoMap),
    secrets,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// The schema column is `jsonb` so Drizzle infers it as `unknown`.
// Coerce defensively so a future schema migration or a hand-edited
// row doesn't corrupt resolver call sites with `undefined.entries`.
function coerceTeamRepoMap(raw: unknown): LinearTeamRepoMap {
  if (raw === null || typeof raw !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string") {
      out[k] = v;
    }
  }
  return out;
}
