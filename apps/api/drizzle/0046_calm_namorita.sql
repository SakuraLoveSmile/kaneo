CREATE TABLE "asset_upload" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"backend" text DEFAULT 'local' NOT NULL,
	"object_key" text NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"declared_size" integer NOT NULL,
	"actual_size" integer,
	"sha256" text,
	"surface" text DEFAULT 'description' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"task_id" text NOT NULL,
	"created_by" text,
	"expires_at" timestamp NOT NULL,
	"uploaded_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "asset" ADD COLUMN "storage_backend" text DEFAULT 's3' NOT NULL;--> statement-breakpoint
ALTER TABLE "asset_upload" ADD CONSTRAINT "asset_upload_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "asset_upload" ADD CONSTRAINT "asset_upload_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "asset_upload" ADD CONSTRAINT "asset_upload_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "asset_upload" ADD CONSTRAINT "asset_upload_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "asset_upload_objectKey_idx" ON "asset_upload" USING btree ("object_key");--> statement-breakpoint
CREATE INDEX "asset_upload_taskId_idx" ON "asset_upload" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "asset_upload_status_idx" ON "asset_upload" USING btree ("status");--> statement-breakpoint
CREATE INDEX "asset_upload_expiresAt_idx" ON "asset_upload" USING btree ("expires_at");