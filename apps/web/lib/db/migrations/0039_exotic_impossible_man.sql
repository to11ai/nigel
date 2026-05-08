-- Drop the cost rollup trigger before widening cost_usd_actual_micros —
-- Postgres rejects ALTER COLUMN TYPE on a column referenced by a trigger.
-- 0040_widen_cost_rollup_trigger.sql recreates it (with bigint v_delta_micros)
-- right after.
DROP TRIGGER IF EXISTS agent_runs_cost_rollup_trg ON agent_runs;--> statement-breakpoint
ALTER TABLE "agent_runs" ALTER COLUMN "budget_usd_cap_micros" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "agent_runs" ALTER COLUMN "cost_usd_actual_micros" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "run_tool_calls" ALTER COLUMN "cost_usd_micros" SET DATA TYPE bigint;