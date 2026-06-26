CREATE TABLE "chunks" (
	"id" text PRIMARY KEY NOT NULL,
	"doc_id" text NOT NULL,
	"content" text NOT NULL,
	"content_original" text NOT NULL,
	"context_prefix" text,
	"chunk_index" integer NOT NULL,
	"chunk_type" text DEFAULT 'text' NOT NULL,
	"token_estimate" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb NOT NULL,
	"embedding" vector(1024),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "docs" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"source" text NOT NULL,
	"mime" text,
	"file_id" text,
	"raw_text" text,
	"structured_md" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"org_id" text,
	"user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	"pushed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_doc_id_docs_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."docs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chunks_doc_idx" ON "chunks" USING btree ("doc_id");