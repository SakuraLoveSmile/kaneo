CREATE TABLE "storage_cleanup_queue" (
	"id" text PRIMARY KEY NOT NULL,
	"backend" text DEFAULT 'local' NOT NULL,
	"object_key" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_attempt_at" timestamp,
	"last_error_code" text,
	CONSTRAINT "storage_cleanup_queue_object_key_unique" UNIQUE("object_key")
);
--> statement-breakpoint
CREATE INDEX "storage_cleanup_queue_createdAt_idx" ON "storage_cleanup_queue" USING btree ("created_at");