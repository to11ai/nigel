CREATE TABLE "agent_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"parent_run_id" text,
	"root_run_id" text NOT NULL,
	"depth" integer DEFAULT 0 NOT NULL,
	"trigger_source" text NOT NULL,
	"trigger_ref" text,
	"specialist_id" text,
	"sandbox_policy" text DEFAULT 'inherit' NOT NULL,
	"human_owner_id" text,
	"repo_ref" text,
	"sandbox_id" text,
	"workflow_run_id" text,
	"chat_id" text,
	"budget_usd_cap_micros" integer DEFAULT 0 NOT NULL,
	"cost_usd_actual_micros" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"blocked_reason" text,
	"approval_required" boolean DEFAULT false NOT NULL,
	"approved_by" text,
	"approved_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp,
	"ended_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "run_artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"root_run_id" text NOT NULL,
	"kind" text NOT NULL,
	"path" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"role" text NOT NULL,
	"parts" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_tool_calls" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"tool_kind" text NOT NULL,
	"tool_name" text NOT NULL,
	"input" jsonb,
	"output" jsonb,
	"success" boolean,
	"cost_usd_micros" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"received_at" timestamp DEFAULT now() NOT NULL,
	"processed_at" timestamp,
	"run_id" text
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_human_owner_id_users_id_fk" FOREIGN KEY ("human_owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_artifacts" ADD CONSTRAINT "run_artifacts_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_messages" ADD CONSTRAINT "run_messages_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_tool_calls" ADD CONSTRAINT "run_tool_calls_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_runs_parent_idx" ON "agent_runs" USING btree ("parent_run_id");--> statement-breakpoint
CREATE INDEX "agent_runs_root_idx" ON "agent_runs" USING btree ("root_run_id");--> statement-breakpoint
CREATE INDEX "agent_runs_owner_idx" ON "agent_runs" USING btree ("human_owner_id");--> statement-breakpoint
CREATE INDEX "agent_runs_chat_idx" ON "agent_runs" USING btree ("chat_id");--> statement-breakpoint
CREATE INDEX "agent_runs_workflow_idx" ON "agent_runs" USING btree ("workflow_run_id");--> statement-breakpoint
CREATE INDEX "agent_runs_status_idx" ON "agent_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "agent_runs_trigger_idx" ON "agent_runs" USING btree ("trigger_source");--> statement-breakpoint
CREATE INDEX "run_artifacts_run_idx" ON "run_artifacts" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "run_artifacts_root_idx" ON "run_artifacts" USING btree ("root_run_id");--> statement-breakpoint
CREATE INDEX "run_artifacts_kind_idx" ON "run_artifacts" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "run_messages_run_idx" ON "run_messages" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "run_tool_calls_run_idx" ON "run_tool_calls" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_source_external_idx" ON "webhook_events" USING btree ("source","external_id");