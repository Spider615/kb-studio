CREATE TABLE "miaodong_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"domain" text NOT NULL,
	"access_key_id" text NOT NULL,
	"access_key_secret" text NOT NULL,
	"knowledge_base_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "docs" ADD COLUMN "progress" jsonb;--> statement-breakpoint
ALTER TABLE "docs" ADD COLUMN "error" text;--> statement-breakpoint
ALTER TABLE "docs" ADD COLUMN "push_targets" jsonb;