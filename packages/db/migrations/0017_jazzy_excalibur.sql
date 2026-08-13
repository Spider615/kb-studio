CREATE TABLE "ab_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"group_id" text,
	"query" text NOT NULL,
	"a_answer" text,
	"a_hits" jsonb,
	"a_ms" integer,
	"a_tokens" integer,
	"a_error" text,
	"b_answer" text,
	"b_trace" jsonb,
	"b_ms" integer,
	"b_tokens" integer,
	"b_error" text,
	"verdict" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wiki_pages" (
	"id" text PRIMARY KEY NOT NULL,
	"doc_id" text NOT NULL,
	"page_index" integer NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"heading_path" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"token_estimate" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "page_id" text;--> statement-breakpoint
ALTER TABLE "docs" ADD COLUMN "wiki_status" text;--> statement-breakpoint
ALTER TABLE "docs" ADD COLUMN "wiki_error" text;--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD CONSTRAINT "wiki_pages_doc_id_docs_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."docs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ab_runs_user_idx" ON "ab_runs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "wiki_pages_doc_idx" ON "wiki_pages" USING btree ("doc_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wiki_pages_doc_page_uniq" ON "wiki_pages" USING btree ("doc_id","page_index");--> statement-breakpoint
CREATE INDEX "chunks_page_id_idx" ON "chunks" USING btree ("page_id");