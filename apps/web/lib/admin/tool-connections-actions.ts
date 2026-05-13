"use server";

import { revalidatePath } from "next/cache";
import {
  type CreateToolConnectionInput,
  createToolConnection as repoCreate,
  deleteToolConnection as repoDelete,
  getToolConnectionById as repoGetById,
  listToolConnections as repoList,
  TOOL_CONNECTION_KINDS,
  type ToolConnectionKind,
  ToolConnectionRepositoryError,
  type UpdateToolConnectionInput,
  updateToolConnection as repoUpdate,
  ToolConnectionValidationError,
} from "@/lib/tool-connections";
import { requireAdmin } from "./require-admin";

const ADMIN_PATH = "/settings/admin/tool-connections";

// Shape returned to the UI. Strips encrypted columns AND the
// `configJson` payload from the wire — admins listing/deleting
// connections never need the host / user / database / etc., the UI
// has no column for them, and shipping them to the browser would
// leak operational detail that doesn't belong in a client bundle.
// The per-row write path still reads `configJson` server-side via
// the repository when an update lands.
export type ToolConnectionListItem = {
  id: string;
  name: string;
  kind: ToolConnectionKind;
  description: string | null;
  scope: string;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

// Server-action result envelope so the client can render typed errors
// without throwing across the action boundary. Mirrors the shape
// `revokeAllGitHubTokens` uses in the sibling actions file.
type ActionResult<T = undefined> =
  | (T extends undefined ? { success: true } : { success: true; data: T })
  | { success: false; error: string; code?: string };

export async function adminListToolConnections(): Promise<
  ActionResult<ToolConnectionListItem[]>
> {
  try {
    await requireAdmin();
    const rows = await repoList();
    return {
      success: true,
      data: rows.map((r) => ({
        id: r.id,
        name: r.name,
        kind: r.kind as ToolConnectionKind,
        description: r.description,
        scope: r.scope,
        createdBy: r.createdBy,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export type AdminCreateInput = {
  name: string;
  kind: ToolConnectionKind;
  description?: string | null;
  config: unknown;
  secrets: unknown;
  scope?: { kind: "global" } | { kind: "specialist"; specialistName: string };
};

export async function adminCreateToolConnection(
  input: AdminCreateInput,
): Promise<ActionResult<{ id: string }>> {
  try {
    const userId = await requireAdmin();
    if (!TOOL_CONNECTION_KINDS.includes(input.kind)) {
      return {
        success: false,
        error: `unknown kind '${input.kind}'`,
        code: "unknown_kind",
      };
    }
    const create: CreateToolConnectionInput = {
      name: input.name,
      kind: input.kind,
      description: input.description ?? null,
      config: input.config,
      secrets: input.secrets,
      ...(input.scope ? { scope: input.scope } : {}),
      createdBy: userId,
    };
    const row = await repoCreate(create);
    revalidatePath(ADMIN_PATH);
    return { success: true, data: { id: row.id } };
  } catch (err) {
    return mapRepositoryError(err);
  }
}

// Returned to the edit page so the form can prefill from existing
// row state. Mirrors `ToolConnectionListItem` and adds `configJson`
// (read-only on the wire — the edit form prefills config fields
// from it). `kind` is included but the UI treats it as immutable
// — changing kind would invalidate the config + secrets shape, so
// kind-change is delete-and-recreate.
//
// `secretsCiphertext` and friends are intentionally NOT returned.
// Existing secrets are not retrievable; the edit form treats secret
// fields as "leave blank to keep, fill to replace".
export type ToolConnectionEditItem = {
  id: string;
  name: string;
  kind: ToolConnectionKind;
  description: string | null;
  scope: string;
  configJson: unknown;
  createdAt: Date;
  updatedAt: Date;
};

export async function adminGetToolConnection(
  id: string,
): Promise<ActionResult<ToolConnectionEditItem>> {
  try {
    await requireAdmin();
    const row = await repoGetById(id);
    if (!row) {
      return {
        success: false,
        error: `tool connection not found: ${id}`,
        code: "not_found",
      };
    }
    return {
      success: true,
      data: {
        id: row.id,
        name: row.name,
        kind: row.kind as ToolConnectionKind,
        description: row.description,
        scope: row.scope,
        configJson: row.configJson,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      },
    };
  } catch (err) {
    return mapRepositoryError(err);
  }
}

// Patch semantics: only fields present in the input are written.
// Omit `config` to leave the config row untouched; omit `secrets`
// to keep the existing encrypted payload. `kind` and `name` are
// not editable here — kind-change requires delete-and-recreate
// (shape mismatch), and name is the identity used by every
// resolver call site.
export type AdminUpdateInput = {
  id: string;
  description?: string | null;
  config?: unknown;
  secrets?: unknown;
  scope?: { kind: "global" } | { kind: "specialist"; specialistName: string };
};

export async function adminUpdateToolConnection(
  input: AdminUpdateInput,
): Promise<ActionResult<{ id: string }>> {
  try {
    await requireAdmin();
    const patch: UpdateToolConnectionInput = { id: input.id };
    if (input.description !== undefined) patch.description = input.description;
    if (input.config !== undefined) patch.config = input.config;
    if (input.secrets !== undefined) patch.secrets = input.secrets;
    if (input.scope !== undefined) patch.scope = input.scope;
    const row = await repoUpdate(patch);
    revalidatePath(ADMIN_PATH);
    revalidatePath(`${ADMIN_PATH}/${input.id}`);
    return { success: true, data: { id: row.id } };
  } catch (err) {
    return mapRepositoryError(err);
  }
}

export async function adminDeleteToolConnection(
  id: string,
): Promise<ActionResult> {
  try {
    await requireAdmin();
    await repoDelete(id);
    revalidatePath(ADMIN_PATH);
    return { success: true };
  } catch (err) {
    return mapRepositoryError(err);
  }
}

function mapRepositoryError(err: unknown): ActionResult<never> {
  if (err instanceof ToolConnectionRepositoryError) {
    return { success: false, error: err.message, code: err.code };
  }
  if (err instanceof ToolConnectionValidationError) {
    return { success: false, error: err.message, code: err.code };
  }
  return {
    success: false,
    error: err instanceof Error ? err.message : String(err),
  };
}
