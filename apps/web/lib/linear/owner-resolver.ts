import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { users } from "@/lib/db/schema";

// Phase 6 L2: actor → Nigel user resolution.
//
// Spec section 3 (Linear webhook, step 5): capture human_owner_id
// from `event.actor` (the Linear user who reassigned the issue to
// the bot). If the actor is the bot itself (an issue was created
// already assigned to the bot), use the issue creator.
//
// We resolve Linear actor IDs to Nigel `users.id` via the
// `users.linear_user_id` column added in this PR. The column is
// populated when a user authenticates via Linear OAuth (deferred to
// L5) or when an admin manually maps a user. If no user matches,
// the webhook handler logs and returns 200 — Phase L3 adds the
// "actor not mapped" comment + reassign-back behavior.
//
// Bot self-actor: when an issue is created with the bot already
// assigned (no human in the loop yet), Linear emits the event with
// `actor` set to the bot user. Falling back to `issue.creator`
// gives a sane default owner so the Run still has an audit trail.

export async function resolveHumanOwnerId(input: {
  actorId: string | null;
  creatorId: string | null;
  botUserId: string;
}): Promise<string | null> {
  // Prefer the actor unless they're the bot.
  const candidate =
    input.actorId !== null && input.actorId !== input.botUserId
      ? input.actorId
      : input.creatorId;
  if (!candidate) return null;
  if (candidate === input.botUserId) return null;
  return lookupNigelUserByLinearId(candidate);
}

async function lookupNigelUserByLinearId(
  linearUserId: string,
): Promise<string | null> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.linearUserId, linearUserId))
    .limit(1);
  return rows[0]?.id ?? null;
}
