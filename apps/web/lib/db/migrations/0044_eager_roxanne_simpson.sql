CREATE TABLE "tool_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"description" text,
	"config_json" jsonb NOT NULL,
	"secrets_ciphertext" text NOT NULL,
	"secrets_nonce" text NOT NULL,
	"secrets_auth_tag" text NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"scope" text DEFAULT 'global' NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tool_connections" ADD CONSTRAINT "tool_connections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tool_connections_name_idx" ON "tool_connections" USING btree ("name");--> statement-breakpoint
CREATE INDEX "tool_connections_kind_idx" ON "tool_connections" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "tool_connections_scope_idx" ON "tool_connections" USING btree ("scope");