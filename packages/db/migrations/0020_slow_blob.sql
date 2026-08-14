CREATE TABLE "collect_submissions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"group_id" text,
	"collector_id" text,
	"company" text,
	"industry" text,
	"agent_purpose" text,
	"agent_notes" text,
	"form" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "docs" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "docs" ADD COLUMN "submission_id" text;--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "industry" text;--> statement-breakpoint
ALTER TABLE "collect_submissions" ADD CONSTRAINT "collect_submissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collect_submissions" ADD CONSTRAINT "collect_submissions_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "collect_submissions_collector_uniq" ON "collect_submissions" USING btree ("user_id","collector_id");--> statement-breakpoint
CREATE INDEX "collect_submissions_user_idx" ON "collect_submissions" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "docs" ADD CONSTRAINT "docs_submission_id_collect_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."collect_submissions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "docs_submission_idx" ON "docs" USING btree ("submission_id");