ALTER TABLE "storage_cleanup_queue" ALTER COLUMN "id" SET DEFAULT gen_random_uuid()::text;--> statement-breakpoint
CREATE OR REPLACE FUNCTION enqueue_asset_cleanup_on_delete()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.storage_backend = 'local' THEN
    INSERT INTO "storage_cleanup_queue" ("id", "backend", "object_key")
    VALUES (gen_random_uuid()::text, 'local', OLD.object_key)
    ON CONFLICT ("object_key") DO NOTHING;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS asset_enqueue_cleanup_trigger ON "asset";--> statement-breakpoint
CREATE TRIGGER asset_enqueue_cleanup_trigger
AFTER DELETE ON "asset"
FOR EACH ROW
EXECUTE FUNCTION enqueue_asset_cleanup_on_delete();--> statement-breakpoint
CREATE OR REPLACE FUNCTION enqueue_asset_upload_cleanup_on_delete()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.backend = 'local' THEN
    IF NOT EXISTS (
      SELECT 1 FROM "asset" WHERE "object_key" = OLD.object_key
    ) THEN
      INSERT INTO "storage_cleanup_queue" ("id", "backend", "object_key")
      VALUES (gen_random_uuid()::text, 'local', OLD.object_key)
      ON CONFLICT ("object_key") DO NOTHING;
    END IF;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS asset_upload_enqueue_cleanup_trigger ON "asset_upload";--> statement-breakpoint
CREATE TRIGGER asset_upload_enqueue_cleanup_trigger
AFTER DELETE ON "asset_upload"
FOR EACH ROW
EXECUTE FUNCTION enqueue_asset_upload_cleanup_on_delete();
