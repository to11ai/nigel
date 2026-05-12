"use server";

import { revalidatePath } from "next/cache";
import { isUserAdmin } from "@/lib/db/users";
import { getServerSession } from "@/lib/session/get-server-session";
import {
  type CreateToolConnectionInput,
  createToolConnection as repoCreate,
  deleteToolConnection as repoDelete,
  listToolConnections as repoList,
  TOOL_CONNECTION_KINDS,
  type ToolConnectionKind,
  ToolConnectionRepositoryError,
  ToolConnectionValidationError,
  type UpdateToolConnectionInput,
  updateToolConnection as repoUpdate,
} from "@/lib/tool-connections";

// All admin server actions guard on the same admin check pattern used
// elsewhere in `lib/admin/actions.ts`. Returns the user id when
// authorized; throws otherwise.
async function requireAdmin(): Promise<string> {
  const session = await getServerSession();
  if (!session?.user?.id) {
    throw new Error("Not authenticated");
  }
  const admin = await isUserAdmin(session.user.id);
  if (!admin) {
    throw new Error("Forbidden");
  }
  return session.user.id;
}

const ADMIN_PATH = "/settings/admin/tool-connections";

// Shape returned to the UI. Strips encrypted columns from the row —
// admins listing/deleting connections never need the ciphertext or
// the underlying secret payload; only the writes path touches those.
export type ToolConnectionListItem = {
  id: string;
  name: string;
  kind: ToolConnectionKind;
  description: string | null;
  scope: string;
  // Stored as jsonb; we cast to the per-kind shape only when the
  // resolving tool callback reads it. The UI shows it raw (after
  // redacting obvious sensitive keys) so admins can verify the
  // connection is pointed at what they intend.
  configJson: unknown;
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
        configJson: r.configJson,
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

export type AdminUpdateInput = {
  id: string;
  description?: string | null;
  config?: unknown;
  secrets?: unknown;
  scope?: { kind: "global" } | { kind: "specialist"; specialistName: string };
};

export async function adminUpdateToolConnection(
  input: AdminUpdateInput,
): Promise<ActionResult> {
  try {
    await requireAdmin();
    const update: UpdateToolConnectionInput = {
      id: input.id,
      ...(input.description !== undefined
        ? { description: input.description }
        : {}),
      ...(input.config !== undefined ? { config: input.config } : {}),
      ...(input.secrets !== undefined ? { secrets: input.secrets } : {}),
      ...(input.scope !== undefined ? { scope: input.scope } : {}),
    };
    await repoUpdate(update);
    revalidatePath(ADMIN_PATH);
    return { success: true };
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
