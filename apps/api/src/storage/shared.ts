import { createId } from "@paralleldrive/cuid2";

export const DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const DEFAULT_UPLOAD_TTL_SECONDS = 300;

const allowedImageMimeTypes = new Set([
  "image/apng",
  "image/avif",
  "image/gif",
  "image/heic",
  "image/heif",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
]);

export type StorageBackend = "s3" | "local";

export type UploadSurface = "description" | "comment";

export type TaskImageUploadContext = {
  workspaceId: string;
  projectId: string;
  taskId: string;
  surface: UploadSurface;
  filename: string;
  contentType: string;
};

export type TaskImageUploadUrl = {
  key: string;
  uploadUrl: string;
  headers: Record<string, string>;
};

export type AssetObject = {
  body: unknown;
  contentType: string | undefined;
  contentLength: number | undefined;
  etag: string | undefined;
  lastModified: Date | undefined;
};

export function isImageContentType(contentType: string) {
  return allowedImageMimeTypes.has(contentType.toLowerCase());
}

export function parseBoolean(value: string | undefined, fallback: boolean) {
  if (value === undefined || value.trim() === "") return fallback;
  return value.trim().toLowerCase() === "true";
}

export function parsePositiveInt(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value?.trim() || "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/**
 * Resolves which backend new uploads are written to.
 *
 * Left unset it keeps the historical S3 behavior so upgrading an instance never
 * silently switches where its files live.
 */
export function getStorageBackend(): StorageBackend {
  const raw = process.env.STORAGE_BACKEND?.trim().toLowerCase();

  if (!raw) return "s3";

  if (raw === "s3" || raw === "local") return raw;

  throw new Error(
    `Unsupported STORAGE_BACKEND "${raw}". Expected "local" or "s3".`,
  );
}

/**
 * Upload size ceiling shared by every backend. `STORAGE_MAX_UPLOAD_BYTES`
 * supersedes the S3-specific variable, which stays supported for existing
 * deployments.
 */
export function getMaxUploadBytes() {
  return parsePositiveInt(
    process.env.STORAGE_MAX_UPLOAD_BYTES ??
      process.env.S3_MAX_IMAGE_UPLOAD_BYTES,
    DEFAULT_MAX_UPLOAD_BYTES,
  );
}

export function getUploadTtlSeconds() {
  return parsePositiveInt(
    process.env.STORAGE_UPLOAD_URL_TTL_SECONDS ??
      process.env.S3_PRESIGN_TTL_SECONDS,
    DEFAULT_UPLOAD_TTL_SECONDS,
  );
}

export function sanitizePathSegment(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^-+|-+$/g, "") || "file"
  );
}

export function getFileExtension(filename: string) {
  const normalized = filename.trim();
  const extension = normalized.includes(".")
    ? normalized.split(".").pop() || ""
    : "";

  return sanitizePathSegment(extension).slice(0, 12);
}

export function buildObjectKeyPrefix(
  context: Omit<TaskImageUploadContext, "filename" | "contentType">,
) {
  const surfaceFolder =
    context.surface === "comment" ? "comments" : "descriptions";

  return [
    "workspace",
    sanitizePathSegment(context.workspaceId),
    "project",
    sanitizePathSegment(context.projectId),
    "task",
    sanitizePathSegment(context.taskId),
    surfaceFolder,
  ].join("/");
}

export function buildObjectKey(context: TaskImageUploadContext) {
  const extension = getFileExtension(context.filename);
  const objectKeyPrefix = buildObjectKeyPrefix(context);
  const timestamp = Date.now();
  const randomId = createId();

  const baseName = sanitizePathSegment(
    context.filename.replace(/\.[^/.]+$/, "") || "image",
  ).slice(0, 64);

  const fileName = extension
    ? `${baseName}-${timestamp}-${randomId}.${extension}`
    : `${baseName}-${timestamp}-${randomId}`;

  return `${objectKeyPrefix}/${fileName}`;
}

export function applyKeyPrefix(prefix: string, key: string) {
  if (!prefix) return key;
  const trimmed = prefix.replace(/\/+$/, "");
  return `${trimmed}/${key}`;
}

/**
 * Validates the caller-declared upload metadata before any bytes move.
 *
 * The size here is a declaration, not proof; the accepted byte count is
 * enforced again while streaming.
 */
export function validateTaskAssetUploadInput(
  contentType: string,
  size: number,
) {
  const maxUploadBytes = getMaxUploadBytes();

  if (!contentType.trim()) {
    throw new Error("A valid content type is required.");
  }

  if (size <= 0) {
    throw new Error("Upload size must be greater than zero.");
  }

  if (size > maxUploadBytes) {
    throw new Error(
      `Upload exceeds the maximum upload size of ${Math.floor(maxUploadBytes / (1024 * 1024))}MB.`,
    );
  }
}

/**
 * Checks that a key sits inside one task surface and cannot traverse out of it.
 *
 * The prefix alone is not enough: gateways that normalize paths would let a
 * traversal suffix walk back out into another workspace's objects.
 */
export function keyMatchesPrefix(key: string, fullPrefix: string) {
  const prefix = `${fullPrefix}/`;

  if (!key.startsWith(prefix)) {
    return false;
  }

  const suffix = key.slice(prefix.length);
  return /^[A-Za-z0-9._-]+$/.test(suffix) && !suffix.startsWith(".");
}
