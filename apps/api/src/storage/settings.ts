import { eq } from "drizzle-orm";
import db, { type DatabaseInstance, schema } from "../database";
import { getLocalStorageConfigurationStatus } from "./local";
import { getS3StorageConfigurationStatus } from "./s3";
import { getStorageBackend, type StorageBackend } from "./shared";

export type StorageConfigSource = "database" | "environment" | "default";

export type InstanceStorageStatus = {
  backend: StorageBackend;
  source: StorageConfigSource;
  version: number;
  localConfigured: boolean;
  s3Configured: boolean;
  localReason?: string | null;
  s3Reason?: string | null;
};

export type StorageSettingsExecutor = Pick<DatabaseInstance, "select">;

/**
 * Resolves which storage backend new uploads are written to.
 *
 * Priority order:
 * 1. Web-saved instance setting from database
 * 2. STORAGE_BACKEND environment variable
 * 3. S3 default
 *
 * Database read errors intentionally propagate: never silently switch on DB
 * failure so transient DB errors do not redirect uploads to an unintended backend.
 */
export async function getEffectiveStorageBackend(
  executor: StorageSettingsExecutor = db,
): Promise<StorageBackend> {
  const [setting] = await executor
    .select({
      backend: schema.instanceStorageSettingTable.backend,
    })
    .from(schema.instanceStorageSettingTable)
    .where(eq(schema.instanceStorageSettingTable.id, "default"))
    .limit(1);

  if (setting?.backend === "local" || setting?.backend === "s3") {
    return setting.backend;
  }

  return getStorageBackend();
}

/**
 * Returns the full instance storage status for administration.
 */
export async function getInstanceStorageStatus(
  executor: StorageSettingsExecutor = db,
): Promise<InstanceStorageStatus> {
  const [setting] = await executor
    .select({
      backend: schema.instanceStorageSettingTable.backend,
      version: schema.instanceStorageSettingTable.version,
    })
    .from(schema.instanceStorageSettingTable)
    .where(eq(schema.instanceStorageSettingTable.id, "default"))
    .limit(1);

  let backend: StorageBackend;
  let source: StorageConfigSource;
  const version = setting?.version ?? 0;

  if (setting?.backend === "local" || setting?.backend === "s3") {
    backend = setting.backend;
    source = "database";
  } else {
    backend = getStorageBackend();
    source = process.env.STORAGE_BACKEND?.trim() ? "environment" : "default";
  }

  const localConfig = getLocalStorageConfigurationStatus();
  const s3Config = getS3StorageConfigurationStatus();

  return {
    backend,
    source,
    version,
    localConfigured: localConfig.configured,
    s3Configured: s3Config.configured,
    localReason: localConfig.reason,
    s3Reason: s3Config.reason,
  };
}
