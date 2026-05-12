import { isUserAdmin } from "@/lib/db/users";
import { getServerSession } from "@/lib/session/get-server-session";

// Shared admin gate used by every server action under `lib/admin/`.
// Returns the calling user's id on success; throws "Not authenticated"
// or "Forbidden" otherwise. Lives in its own file (rather than
// `actions.ts`) so additional "use server" entrypoints can import it
// without dragging in the existing destructive-action surface.
export async function requireAdmin(): Promise<string> {
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
