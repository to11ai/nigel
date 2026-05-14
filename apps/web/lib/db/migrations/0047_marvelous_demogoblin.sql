ALTER TABLE "agent_runs" ADD COLUMN "linear_agent_session_id" text;--> statement-breakpoint
CREATE INDEX "agent_runs_linear_agent_session_idx" ON "agent_runs" USING btree ("linear_agent_session_id");