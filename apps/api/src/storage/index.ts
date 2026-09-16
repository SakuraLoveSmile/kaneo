import db, { schema } from "../database";
import {
  assertLocalTaskImageKeyMatchesContext,
  createLocalUploadToken,
  deleteLocalObject,
  ensureLocalStorageReady,
  getLocalStorageRoot,
  LOCAL_UPLOAD_TOKEN_HEADER,
  readLocalObject,
} from "./local";
import {
  assertTaskImageKeyMatchesContext,
  createTaskImageUploadUrl,
  deleteS3Object,
  getS3Object,
} from "./s3";
import { getEffectiveStorageBackend } from "./settings";
import {
  type AssetObject,
  buildObjectKey,
  getUploadTtlSeconds,
  type StorageBackend,
  type TaskImageUploadContext,
  type TaskImageUploadUrl,
} from "./shared";

export {
  dedupeStorageRefs,
  enqueueStorageCleanup,
  processStorageCleanupQueue,
  type StorageCleanupRef,
  type StorageCleanupWriter,
  type StorageRefReader,
} from "./cleanup-queue";
export {
  assertLocalStorageRootAvailable,
  discardStagedUpload,
  ensureLocalStorageReady,
  getLocalStorageConfigurationStatus,
  InvalidUploadError,
  isLocalStorageConfigured,
  LOCAL_UPLOAD_TOKEN_HEADER,
  LocalObjectNotFoundError,
  publishStagedUpload,
  StorageUnavailableError,
  stageLocalUpload,
  UnsafeStoragePathError,
  UploadTooLargeError,
  verifyStoredLocalObject,
  verifyUploadToken,
} from "./local";
export {
  checkLocalStorage,
  checkS3Storage,
  checkStorageBackend,
  type StorageCheckResult,
} from "./probe";
export {
  getS3StorageConfigurationStatus,
  isS3StorageConfigured,
} from "./s3";
export {
  getEffectiveStorageBackend,
  getInstanceStorageStatus,
  type InstanceStorageStatus,
  type StorageConfigSource,
  type StorageSettingsExecutor,
} from "./settings";
export type {
  AssetObject,
  StorageBackend,
  TaskImageUploadContext,
  TaskImageUploadUrl,
  UploadSurface,
} from "./shared";
export {
  applyKeyPrefix,
  buildObjectKey,
  buildObjectKeyPrefix,
  getFileExtension,
  getMaxUploadBytes,
  getStorageBackend,
  getUploadTtlSeconds,
  isImageContentType,
  parseBoolean,
  parsePositiveInt,
  sanitizePathSegment,
  validateTaskAssetUploadInput,
} from "./shared";

/**
 * Requests an upload destination for a task image or attachment.
 *
 * S3 keeps returning a presigned URL. Local storage instead records a
 * short-lived upload token and returns a Kaneo-hosted URL that accepts the raw
 * bytes, so callers do not need to know which backend is configured.
 */
export async function createTaskImageUpload({
  context,
  size,
  createdBy,
  apiBaseUrl,
}: {
  context: TaskImageUploadContext;
  size: number;
  createdBy: string | null;
  apiBaseUrl: string;
}): Promise<TaskImageUploadUrl> {
  const backend = await getEffectiveStorageBackend();
  if (backend === "s3") {
    return createTaskImageUploadUrl(context);
  }

  await ensureLocalStorageReady();

  const key = buildObjectKey(context);
  const { token, tokenHash } = createLocalUploadToken();
  const expiresAt = new Date(Date.now() + getUploadTtlSeconds() * 1000);

  const [record] = await db
    .insert(schema.assetUploadTable)
    .values({
      tokenHash,
      backend: "local",
      objectKey: key,
      filename: context.filename,
      mimeType: context.contentType,
      declaredSize: size,
      surface: context.surface,
      status: "pending",
      workspaceId: context.workspaceId,
      projectId: context.projectId,
      taskId: context.taskId,
      createdBy,
      expiresAt,
    })
    .returning({ id: schema.assetUploadTable.id });

  if (!record) {
    throw new Error("Failed to create the upload record.");
  }

  const expires = Math.floor(expiresAt.getTime() / 1000);

  return {
    key,
    uploadUrl: `${apiBaseUrl}/storage/local-upload/${record.id}?Expires=${expires}`,
    headers: {
      "Content-Type": context.contentType,
      [LOCAL_UPLOAD_TOKEN_HEADER]: token,
    },
  };
}

export type AssetUploadRecord = typeof schema.assetUploadTable.$inferSelect;

export function verifyTaskImageUploadKey(
  backend: StorageBackend,
  key: string,
  context: Omit<TaskImageUploadContext, "filename" | "contentType">,
) {
  if (backend === "local") {
    return assertLocalTaskImageKeyMatchesContext(key, context);
  }

  return assertTaskImageKeyMatchesContext(key, context);
}

export async function getAssetObject(
  backend: StorageBackend,
  key: string,
): Promise<AssetObject> {
  if (backend === "local") {
    return readLocalObject(getLocalStorageRoot(), key);
  }

  return getS3Object(key);
}

/**
 * Deletes one stored object through the backend that owns it.
 *
 * Failures propagate on purpose: callers must not treat an unreachable or
 * unconfigured backend as a successful delete, or the file would leak with
 * nothing left pointing at it.
 */
export async function deleteAssetObject(backend: StorageBackend, key: string) {
  if (backend === "local") {
    await deleteLocalObject(getLocalStorageRoot(), key);
    return;
  }

  await deleteS3Object(key);
}
