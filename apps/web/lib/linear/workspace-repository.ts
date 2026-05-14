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
// Singleton is enforced at the database via the unique index on
// `workspace_id`: `createLinearWorkspace` rethrows a 23505 violation
// as a typed `already_exists` error so concurrent admin saves don't
// produce a raw stack trace. Subsequent edits go through
// `updateLinearWorkspace`, which patches by id — no read-then-write
// race window.
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
  // Linear migrated to short-lived (~24h) access tokens in April
  // 2026 with refresh-token renewal. Both fields are optional so
  // older workspace rows (from the manual-token L5 path, pre-OAuth)
  // keep working — when both are null/unset, we assume a long-lived
  // token and skip refresh.
  refreshToken?: string | null;
  // Wall-clock instant the access token expires. Stored as ISO
  // string in the encrypted blob and parsed back to Date here.
  accessTokenExpiresAt?: string | null;
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
export function isUniqueViolation(err: unknown): boolean {
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
//
// Eagerly refreshes the access token when within the expiry buffer
// (5 min) and a refresh_token is on file. Linear migrated to ~24h
// access tokens in April 2026; without proactive refresh, a workspace
// stops being usable a day after install. The refresh is best-effort
// — if it fails we still return the (possibly soon-to-expire) token
// and the caller deals with a downstream 401.
export async function resolveLinearWorkspace(): Promise<ResolvedLinearWorkspace | null> {
  const row = await getLinearWorkspace();
  if (!row) return null;
  let resolved = rowToResolved(row);
  resolved = await maybeRefreshAccessToken(resolved);
  return resolved;
}

const REFRESH_BUFFER_MS = 5 * 60 * 1000;

async function maybeRefreshAccessToken(
  workspace: ResolvedLinearWorkspace,
): Promise<ResolvedLinearWorkspace> {
  const { refreshToken, accessTokenExpiresAt } = workspace.secrets;
  if (!(refreshToken && accessTokenExpiresAt)) return workspace;
  const expiresAt = Date.parse(accessTokenExpiresAt);
  if (!Number.isFinite(expiresAt)) return workspace;
  if (expiresAt - Date.now() > REFRESH_BUFFER_MS) return workspace;

  const clientId = process.env.LINEAR_OAUTH_CLIENT_ID;
  const clientSecret = process.env.LINEAR_OAUTH_CLIENT_SECRET;
  if (!(clientId && clientSecret)) {
    // OAuth not configured in this stack — can't refresh. Return
    // the expired token; caller will get a 401 and the admin will
    // need to re-install.
    return workspace;
  }

  // Dynamic import keeps the OAuth client out of the cold-path
  // resolve for installs that don't use OAuth.
  const { refreshAccessToken } = await import("./oauth-client");
  let refreshed: Awaited<ReturnType<typeof refreshAccessToken>>;
  try {
    refreshed = await refreshAccessToken({
      refreshToken,
      clientId,
      clientSecret,
    });
  } catch (err) {
    // biome-ignore lint/suspicious/noConsole: refresh failures surface in ops triage
    console.error("[linear-workspace] refresh failed", {
      workspaceId: workspace.workspaceId,
      err,
    });
    return workspace;
  }

  // When Linear omits expires_in on a refresh response (allowed by
  // RFC 6749 §6), we don't know when the new token expires. Persist
  // the PREVIOUS expiresAt rather than null: null would short-circuit
  // the refresh guard on the next call (`if (!(refreshToken &&
  // accessTokenExpiresAt))`) and the workspace would never refresh
  // again, silently dying once the new token actually expired. The
  // worst case with this fallback is refreshing more often than
  // needed — still preferable to never refreshing.
  let nextExpiresAt: string | null;
  if (refreshed.expiresIn !== null) {
    nextExpiresAt = new Date(
      Date.now() + refreshed.expiresIn * 1000,
    ).toISOString();
  } else {
    // biome-ignore lint/suspicious/noConsole: ops signal — Linear omitted expires_in
    console.warn(
      "[linear-workspace] refresh response omitted expires_in; preserving previous expiry",
      { workspaceId: workspace.workspaceId },
    );
    nextExpiresAt = workspace.secrets.accessTokenExpiresAt ?? null;
  }
  // Persist the new tokens. Last-write-wins under concurrent refresh —
  // acceptable trade-off vs introducing a single-flight lock.
  try {
    const updated = await updateLinearWorkspace({
      id: workspace.id,
      secrets: {
        accessToken: refreshed.accessToken,
        webhookSecret: workspace.secrets.webhookSecret,
        refreshToken: refreshed.refreshToken,
        accessTokenExpiresAt: nextExpiresAt,
      },
    });
    return rowToResolved(updated);
  } catch (err) {
    // biome-ignore lint/suspicious/noConsole: persist failures matter for next call
    console.error("[linear-workspace] refresh persist failed", {
      workspaceId: workspace.workspaceId,
      err,
    });
    // We have the fresh token in memory — return it without
    // persisting so this request still works. Next call will refresh
    // again.
    return {
      ...workspace,
      secrets: {
        ...workspace.secrets,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        accessTokenExpiresAt: nextExpiresAt,
      },
    };
  }
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
  const decrypted = decryptSecrets<LinearWorkspaceSecrets>({
    ciphertext: row.secretsCiphertext,
    nonce: row.secretsNonce,
    authTag: row.secretsAuthTag,
    keyVersion: row.keyVersion as 1,
  });
  // Prefer LINEAR_WEBHOOK_SECRET from env when set. There's one
  // Linear app per Nigel install, so the webhook secret is a deploy-
  // level config (provisioned via Pulumi alongside the OAuth
  // credentials) rather than per-workspace data. The DB-stored value
  // is the L5 fallback for installs that pre-date the env-var path.
  const envWebhookSecret = process.env.LINEAR_WEBHOOK_SECRET?.trim();
  const secrets: LinearWorkspaceSecrets = {
    accessToken: decrypted.accessToken,
    webhookSecret: envWebhookSecret || decrypted.webhookSecret,
    refreshToken: decrypted.refreshToken ?? null,
    accessTokenExpiresAt: decrypted.accessTokenExpiresAt ?? null,
  };
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
