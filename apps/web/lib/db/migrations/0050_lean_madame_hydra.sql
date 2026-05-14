ALTER TABLE "agent_runs" ADD COLUMN "cost_usd_reserved_micros" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "child_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Backfill child_count for existing rows from the count of children pointing
-- at each row via parent_run_id. New child_count defaults to 0; only rows
-- that have already spawned children need a non-zero seed. cost_usd_reserved
-- correctly defaults to 0 across the board (no in-flight reservations exist
-- prior to this migration).
UPDATE "agent_runs"
SET "child_count" = COALESCE(c.cnt, 0)
FROM (
  SELECT "parent_run_id", COUNT(*)::int AS cnt
  FROM "agent_runs"
  WHERE "parent_run_id" IS NOT NULL
  GROUP BY "parent_run_id"
) c
WHERE "agent_runs"."id" = c."parent_run_id";
