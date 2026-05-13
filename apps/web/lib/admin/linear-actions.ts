"use server";

import { revalidatePath } from "next/cache";
import {
  type CreateLinearWorkspaceInput,
  createLinearWorkspace as repoCreate,
  deleteLinearWorkspace as repoDelete,
  getLinearWorkspace as repoGet,
  type LinearTeamRepoMap,
  type LinearWorkspaceListItem,
  type LinearWorkspaceSecrets,
  LinearWorkspaceRepositoryError,
  resolveLinearWorkspace as repoResolve,
  rowToListItem,
  type UpdateLinearWorkspaceInput,
  updateLinearWorkspace as repoUpdate,
} from "@/lib/linear";
import { requireAdmin } from "./require-admin";

// Phase 6 L5: admin actions for /admin/linear. Spec section 7:
//   /admin/linear → Linear OAuth + bot user + webhook secret +
//   team→repo map
//
// OAuth wiring is deferred (still L5 but later); this PR ships the
// manual-config path: admin enters workspace_id + bot_user_id +
// webhook signing secret + team_repo_map and the row is created.
// Same pattern as `/admin/tool-connections` — patch semantics on
// update, secrets stay write-only.

const ADMIN_PATH = "/settings/admin/linear";

// Wire shape returned to the client. Strips the encrypted secrets
// columns (which the rowToListItem helper already excludes) AND
// reuses the repository's typed shape so admin UI changes don't
// have to chase a second type definition.
export type AdminLinearWorkspaceItem = LinearWorkspaceListItem;

type ActionResult<T = undefined> =
  | (T extends undefined ? { success: true } : { success: true; data: T })
  | { success: false; error: string; code?: string };

export async function adminGetLinearWorkspace(): Promise<
  ActionResult<AdminLinearWorkspaceItem | null>
> {
  try {
    await requireAdmin();
    const row = await repoGet();
    return { success: true, data: row ? rowToListItem(row) : null };
  } catch (err) {
    return mapRepositoryError(err);
  }
}

// Server-only helper for the route handler if it ever needs a
// "is configured?" health check. The full secrets path goes through
// `resolveLinearWorkspace` directly in the webhook handler; this
// just confirms presence without touching plaintext.
export async function adminLinearIsConfigured(): Promise<
  ActionResult<{ configured: boolean }>
> {
  try {
    await requireAdmin();
    const row = await repoGet();
    return { success: true, data: { configured: row !== null } };
  } catch (err) {
    return mapRepositoryError(err);
  }
}

export type AdminCreateLinearInput = {
  workspaceId: string;
  botUserId: string;
  webhookSecret: string;
  accessToken: string;
  teamRepoMap?: LinearTeamRepoMap;
};

export async function adminCreateLinearWorkspace(
  input: AdminCreateLinearInput,
): Promise<ActionResult<{ id: string }>> {
  try {
    await requireAdmin();
    if (!input.workspaceId.trim()) {
      return { success: false, error: "workspace_id is required" };
    }
    if (!input.botUserId.trim()) {
      return { success: false, error: "bot_user_id is required" };
    }
    if (!input.webhookSecret) {
      return { success: false, error: "webhook signing secret is required" };
    }
    if (!input.accessToken) {
      return { success: false, error: "Linear access token is required" };
    }
    const secrets: LinearWorkspaceSecrets = {
      webhookSecret: input.webhookSecret,
      accessToken: input.accessToken,
    };
    const create: CreateLinearWorkspaceInput = {
      workspaceId: input.workspaceId.trim(),
      botUserId: input.botUserId.trim(),
      secrets,
      ...(input.teamRepoMap !== undefined
        ? { teamRepoMap: input.teamRepoMap }
        : {}),
    };
    const row = await repoCreate(create);
    revalidatePath(ADMIN_PATH);
    return { success: true, data: { id: row.id } };
  } catch (err) {
    return mapRepositoryError(err);
  }
}

export type AdminUpdateLinearInput = {
  id: string;
  botUserId?: string;
  teamRepoMap?: LinearTeamRepoMap;
  // Patch semantics: omit / undefined keeps the existing encrypted
  // payload. Each field can be rotated independently. Empty string
  // is treated the same as "don't rotate" so a user who clears the
  // input by accident doesn't blank out the row.
  webhookSecret?: string;
  accessToken?: string;
};

export async function adminUpdateLinearWorkspace(
  input: AdminUpdateLinearInput,
): Promise<ActionResult<{ id: string }>> {
  try {
    await requireAdmin();
    const patch: UpdateLinearWorkspaceInput = { id: input.id };
    if (input.botUserId !== undefined) {
      // botUserId is semantically required — it's the Linear user
      // ID assignments are matched against. An empty string here
      // would silently break webhook matching. Reject upfront
      // rather than write a blank row.
      const trimmed = input.botUserId.trim();
      if (!trimmed) {
        return { success: false, error: "bot_user_id cannot be empty" };
      }
      patch.botUserId = trimmed;
    }
    if (input.teamRepoMap !== undefined) patch.teamRepoMap = input.teamRepoMap;
    // Build secrets only when the admin actually supplied
    // replacements. If only one of the two changed, we must read
    // the existing decrypted secrets and merge so the other stays
    // intact — re-encrypting `{ webhookSecret: "new" }` alone
    // would null out accessToken on the resolved struct.
    if (input.webhookSecret || input.accessToken) {
      const current = await repoResolve();
      if (!current) {
        return {
          success: false,
          error: "workspace not found",
          code: "not_found",
        };
      }
      patch.secrets = {
        webhookSecret: input.webhookSecret || current.secrets.webhookSecret,
        accessToken: input.accessToken || current.secrets.accessToken,
      };
    }
    const row = await repoUpdate(patch);
    revalidatePath(ADMIN_PATH);
    return { success: true, data: { id: row.id } };
  } catch (err) {
    return mapRepositoryError(err);
  }
}

export async function adminDeleteLinearWorkspace(
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
  if (err instanceof LinearWorkspaceRepositoryError) {
    return { success: false, error: err.message, code: err.code };
  }
  return {
    success: false,
    error: err instanceof Error ? err.message : String(err),
  };
}
