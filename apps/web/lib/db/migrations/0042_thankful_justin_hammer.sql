CREATE TABLE "repo_configs" (
	"id" text PRIMARY KEY NOT NULL,
	"repo_full_name" text NOT NULL,
	"config_json" jsonb NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "repo_configs_repo_full_name_idx" ON "repo_configs" USING btree ("repo_full_name");