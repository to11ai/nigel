CREATE TABLE "specialists" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"system_prompt" text,
	"model" text,
	"tool_allowlist" jsonb,
	"sandbox_policy" text,
	"may_recurse" boolean,
	"max_children" integer,
	"budget_usd_default_micros" bigint,
	"needs_local_stack" boolean,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "specialists" ADD CONSTRAINT "specialists_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "specialists_name_idx" ON "specialists" USING btree ("name");--> statement-breakpoint
CREATE INDEX "specialists_kind_idx" ON "specialists" USING btree ("kind");