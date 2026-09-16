-- Upstream's 0045 (custom fields) vendored as 0050 so installations that
-- already ran this fork's 0045-0049 still receive it: drizzle only applies
-- journal entries newer than the last applied "when". The guard also lets
-- databases that applied upstream's original 0045 switch to this fork.
DO $$
BEGIN
	IF to_regclass('public.custom_field_definition') IS NOT NULL THEN
		RETURN;
	END IF;

	CREATE TABLE "custom_field_definition" (
		"id" text PRIMARY KEY NOT NULL,
		"project_id" text NOT NULL,
		"name" text NOT NULL,
		"type" text NOT NULL,
		"required" boolean DEFAULT false NOT NULL,
		"default_value" text,
		"options" jsonb,
		"position" integer DEFAULT 0 NOT NULL,
		"created_at" timestamp DEFAULT now() NOT NULL,
		"updated_at" timestamp DEFAULT now() NOT NULL
	);

	CREATE TABLE "custom_field_value" (
		"id" text PRIMARY KEY NOT NULL,
		"task_id" text NOT NULL,
		"field_id" text NOT NULL,
		"value" text,
		"created_at" timestamp DEFAULT now() NOT NULL,
		"updated_at" timestamp DEFAULT now() NOT NULL,
		CONSTRAINT "custom_field_value_task_field_unique" UNIQUE("task_id","field_id")
	);

	ALTER TABLE "custom_field_definition" ADD CONSTRAINT "custom_field_definition_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE cascade;
	ALTER TABLE "custom_field_value" ADD CONSTRAINT "custom_field_value_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE cascade ON UPDATE cascade;
	ALTER TABLE "custom_field_value" ADD CONSTRAINT "custom_field_value_field_id_custom_field_definition_id_fk" FOREIGN KEY ("field_id") REFERENCES "public"."custom_field_definition"("id") ON DELETE cascade ON UPDATE cascade;
	CREATE INDEX "custom_field_def_projectId_idx" ON "custom_field_definition" USING btree ("project_id");
	CREATE INDEX "custom_field_value_taskId_idx" ON "custom_field_value" USING btree ("task_id");
	CREATE INDEX "custom_field_value_fieldId_idx" ON "custom_field_value" USING btree ("field_id");
END
$$;
