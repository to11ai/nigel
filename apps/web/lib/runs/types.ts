import type { InferSelectModel } from "drizzle-orm";
import { z } from "zod";
import type { agentRuns } from "@/lib/db/schema";

export const runStatusSchema = z.enum([
  "pending",
  "running",
  "blocked",
  "awaiting_approval",
  "completed",
  "failed",
  "cancelled",
]);

export const triggerSourceSchema = z.enum([
  "chat",
  "linear",
  "chained",
  "cron",
]);

export const sandboxPolicySchema = z.enum(["inherit", "fresh", "fresh_clean"]);

export type TriggerSource = z.infer<typeof triggerSourceSchema>;
export type SandboxPolicy = z.infer<typeof sandboxPolicySchema>;

// Row type derived from the Drizzle table definition; stays in sync
// automatically when columns change.
export type AgentRun = InferSelectModel<typeof agentRuns>;

export const MAX_DEPTH = 5;
