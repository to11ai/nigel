CREATE TABLE "sandbox_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"repo_full_name" text NOT NULL,
	"branch_or_sha" text NOT NULL,
	"profile" text NOT NULL,
	"base_snapshot_id" text,
	"invalidation_keys" jsonb NOT NULL,
	"keys_hash" text NOT NULL,
	"built_at" timestamp DEFAULT now() NOT NULL,
	"ttl_until" timestamp,
	"size_bytes" bigint
);
--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_snapshots_lookup_idx" ON "sandbox_snapshots" USING btree ("repo_full_name","profile","keys_hash");--> statement-breakpoint
CREATE INDEX "sandbox_snapshots_built_at_idx" ON "sandbox_snapshots" USING btree ("built_at");