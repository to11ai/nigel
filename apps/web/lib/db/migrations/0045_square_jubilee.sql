CREATE TABLE "linear_workspace" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"bot_user_id" text NOT NULL,
	"secrets_ciphertext" text NOT NULL,
	"secrets_nonce" text NOT NULL,
	"secrets_auth_tag" text NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"team_repo_map" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "linear_workspace_workspace_id_idx" ON "linear_workspace" USING btree ("workspace_id");