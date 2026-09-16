import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  type AssetObject,
  buildObjectKeyPrefix,
  keyMatchesPrefix,
  type TaskImageUploadContext,
} from "./shared";

export const LOCAL_UPLOAD_TOKEN_HEADER = "x-kaneo-upload-token";

const TEMP_DIR_NAME = ".tmp";

// Disk-level failures stay server errors; everything else during a write means
// the request body could not be read.
const STORAGE_FAILURE_CODES = new Set([
  "EACCES",
  "EDQUOT",
  "EIO",
  "EMFILE",
  "ENFILE",
  "ENOSPC",
  "EROFS",
  "EXDEV",
]);

const SYMLINK_ERROR_CODES = new Set(["ELOOP", "EMLINK"]);

/**
 * Raised when local storage is not usable. The public message stays generic on
 * purpose: responses must not disclose the configured disk path.
 */
export class StorageUnavailableError extends Error {
  override name = "StorageUnavailableError";
}

/**
 * Raised when an object path would leave the storage root, typically through a
 * symbolic link. Never swallowed: a refused operation must not be reported as a
 * successful delete.
 */
export class UnsafeStoragePathError extends Error {
  override name = "UnsafeStoragePathError";
}

export class UploadTooLargeError extends Error {
  override name = "UploadTooLargeError";
}

export class InvalidUploadError extends Error {
  override name = "InvalidUploadError";
}

export class LocalObjectNotFoundError extends Error {
  override name = "LocalObjectNotFoundError";
}

export function isLocalStorageConfigured(): boolean {
  const raw = process.env.LOCAL_STORAGE_PATH?.trim();
  return Boolean(raw && path.isAbsolute(raw));
}

export function getLocalStorageConfigurationStatus(): {
  configured: boolean;
  reason: string | null;
} {
  const raw = process.env.LOCAL_STORAGE_PATH?.trim();
  if (!raw) {
    return {
      configured: false,
      reason: "LOCAL_STORAGE_PATH is not configured in environment.",
    };
  }
  if (!path.isAbsolute(raw)) {
    return {
      configured: false,
      reason: "LOCAL_STORAGE_PATH must be an absolute path.",
    };
  }
  return {
    configured: true,
    reason: null,
  };
}

export function getLocalStorageRoot() {
  const raw = process.env.LOCAL_STORAGE_PATH?.trim();

  if (!raw) {
    throw new StorageUnavailableError(
      "Local storage is not configured on this instance.",
    );
  }

  if (!path.isAbsolute(raw)) {
    throw new StorageUnavailableError(
      "Local storage is not configured correctly on this instance.",
    );
  }

  return path.resolve(raw);
}

/**
 * Resolves the storage root and proves it is a writable directory.
 *
 * A missing or read-only directory is a hard failure: silently falling back to
 * a temporary directory would accept uploads that vanish on the next deploy.
 */
export async function ensureLocalStorageReady() {
  const root = getLocalStorageRoot();

  try {
    await assertSafePath(root, root);
    await fs.mkdir(root, { recursive: true });
    await assertSafePath(root, root);
    await fs.mkdir(path.join(root, TEMP_DIR_NAME), { recursive: true });
    await fs.access(root, constants.W_OK | constants.R_OK);
  } catch (error) {
    if (error instanceof UnsafeStoragePathError) throw error;

    console.error("Local storage is not writable", {
      error: error instanceof Error ? error.message : error,
    });
    throw new StorageUnavailableError(
      "Local storage is unavailable on this instance.",
    );
  }

  return root;
}

/**
 * Verifies the storage root is usable for reading and removing files, without
 * creating anything.
 *
 * Deletion uses this instead of {@link ensureLocalStorageReady}: a missing or
 * unmounted volume must be reported as a failure so the cleanup queue keeps its
 * record, rather than being mistaken for "the file is already gone".
 */
export async function assertLocalStorageRootAvailable(root: string) {
  let stat: Awaited<ReturnType<typeof fs.stat>>;

  try {
    stat = await fs.stat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new StorageUnavailableError(
        "Local storage is unavailable on this instance.",
      );
    }
    console.error("Local storage root could not be inspected", {
      error: error instanceof Error ? error.message : error,
    });
    throw new StorageUnavailableError(
      "Local storage is unavailable on this instance.",
    );
  }

  if (!stat.isDirectory()) {
    throw new StorageUnavailableError(
      "Local storage is unavailable on this instance.",
    );
  }

  try {
    await fs.access(root, constants.R_OK | constants.W_OK);
  } catch {
    throw new StorageUnavailableError(
      "Local storage is unavailable on this instance.",
    );
  }

  return root;
}

export function getLocalTempDir(root: string) {
  return path.join(root, TEMP_DIR_NAME);
}

/**
 * Joins a storage key onto the root, rejecting absolute paths, traversal and
 * empty segments so a caller-supplied key cannot name a file outside the root.
 */
export function resolveLocalObjectPath(root: string, key: string) {
  if (!key || key.includes("\0") || path.isAbsolute(key)) {
    throw new InvalidUploadError("Invalid storage key.");
  }

  for (const segment of key.split("/")) {
    if (!segment || segment === "." || segment === "..") {
      throw new InvalidUploadError("Invalid storage key.");
    }
  }

  const resolved = path.resolve(root, key);
  const relative = path.relative(root, resolved);

  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new InvalidUploadError("Invalid storage key.");
  }

  return resolved;
}

/**
 * Resolves a path that may not exist yet by walking up to its nearest existing
 * ancestor. Returns null when nothing along the chain exists.
 */
async function realPathOfNearestExisting(
  target: string,
): Promise<string | null> {
  let probe = target;

  for (;;) {
    try {
      return await fs.realpath(probe);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;

      const parent = path.dirname(probe);
      if (parent === probe) return null;
      probe = parent;
    }
  }
}

/**
 * Rejects any path that would resolve outside the storage root.
 *
 * Every already-existing component below the root is checked with `lstat`, so a
 * symbolic link planted at any level - including a parent directory that the
 * object path merely passes through - is refused instead of followed. The root
 * itself may be a link, since that is an operator choice; the final realpath
 * comparison then covers everything else.
 */
export async function assertSafePath(root: string, target: string) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);

  if (path.isAbsolute(relative) || relative.startsWith("..")) {
    throw new UnsafeStoragePathError(
      "Storage path leaves the configured directory.",
    );
  }

  let current = resolvedRoot;

  for (const segment of relative ? relative.split(path.sep) : []) {
    current = path.join(current, segment);

    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }

    if (stat.isSymbolicLink()) {
      throw new UnsafeStoragePathError(
        "Storage path traverses a symbolic link.",
      );
    }
  }

  const realRoot = await realPathOfNearestExisting(resolvedRoot);
  if (!realRoot) return;

  let probe = resolvedTarget;

  for (;;) {
    try {
      const real = await fs.realpath(probe);
      if (real !== realRoot && !real.startsWith(`${realRoot}${path.sep}`)) {
        throw new UnsafeStoragePathError(
          "Storage path leaves the configured directory.",
        );
      }
      return;
    } catch (error) {
      if (error instanceof UnsafeStoragePathError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;

      const parent = path.dirname(probe);
      if (parent === probe) {
        throw new UnsafeStoragePathError(
          "Storage path leaves the configured directory.",
        );
      }
      probe = parent;
    }
  }
}

class CountingHashTransform extends Transform {
  #bytes = 0;
  #hash = createHash("sha256");

  constructor(private readonly maxBytes: number) {
    super();
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer) => void,
  ) {
    this.#bytes += chunk.length;

    if (this.#bytes > this.maxBytes) {
      callback(new UploadTooLargeError("Upload exceeds the maximum size."));
      return;
    }

    this.#hash.update(chunk);
    callback(null, chunk);
  }

  get size() {
    return this.#bytes;
  }

  digest() {
    return this.#hash.digest("hex");
  }
}

export function hashUploadToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function createLocalUploadToken() {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashUploadToken(token) };
}

export function verifyUploadToken(token: string, expectedHash: string) {
  if (!token || !expectedHash) return false;

  const actual = Buffer.from(hashUploadToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");

  if (actual.length !== expected.length) return false;

  return timingSafeEqual(actual, expected);
}

async function lstatRegularFile(filePath: string) {
  try {
    const stat = await fs.lstat(filePath);
    return stat.isFile() ? stat : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Opens an object with the final component's symbolic links refused.
 *
 * The returned handle is the source of truth for the file's type, so callers
 * cannot end up reading a link target that a path check did not see.
 */
async function openRegularFile(root: string, key: string) {
  const filePath = resolveLocalObjectPath(root, key);
  await assertSafePath(root, filePath);

  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;

    if (code === "ENOENT") {
      throw new LocalObjectNotFoundError("Storage object not found.");
    }

    if (code && SYMLINK_ERROR_CODES.has(code)) {
      throw new UnsafeStoragePathError("Storage object is a symbolic link.");
    }

    throw error;
  }

  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new LocalObjectNotFoundError("Storage object is not a file.");
    }
    return { filePath, handle, stat };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function hashOpenFile(handle: Awaited<ReturnType<typeof fs.open>>) {
  const hash = createHash("sha256");
  await pipeline(handle.createReadStream({ autoClose: false }), hash);
  return hash.digest("hex");
}

async function safeUnlink(filePath: string) {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("Failed to remove temporary upload file", {
        error: error instanceof Error ? error.message : error,
      });
    }
  }
}

export type StagedUpload = {
  tempPath: string;
  size: number;
  sha256: string;
};

export type LocalStoreResult = {
  status: "stored" | "duplicate" | "conflict";
  size: number;
  sha256: string;
};

/**
 * Streams an upload into the staging directory and verifies it.
 *
 * Nothing is published here: a size mismatch or an interrupted body only ever
 * leaves an unreachable `.part` file that is removed before returning.
 */
export async function stageLocalUpload({
  root,
  key,
  body,
  maxBytes,
  expectedSize,
}: {
  root: string;
  key: string;
  body: ReadableStream<Uint8Array>;
  maxBytes: number;
  expectedSize?: number;
}): Promise<StagedUpload> {
  const finalPath = resolveLocalObjectPath(root, key);
  const tempDir = getLocalTempDir(root);
  const tempPath = path.join(
    tempDir,
    `${createHash("sha256").update(key).digest("hex").slice(0, 16)}-${randomBytes(8).toString("hex")}.part`,
  );

  const meter = new CountingHashTransform(maxBytes);

  // Check the existing ancestors before creating anything, then again after, so
  // a link planted in between cannot be written through.
  await assertSafePath(root, tempDir);
  await fs.mkdir(tempDir, { recursive: true });
  await assertSafePath(root, tempDir);

  try {
    await pipeline(
      Readable.fromWeb(
        body as unknown as Parameters<typeof Readable.fromWeb>[0],
      ),
      meter,
      createWriteStream(tempPath, { flags: "wx", mode: 0o600 }),
    );
  } catch (error) {
    await safeUnlink(tempPath);

    if (error instanceof UploadTooLargeError) throw error;

    const code = (error as NodeJS.ErrnoException).code;
    if (code && STORAGE_FAILURE_CODES.has(code)) throw error;

    throw new InvalidUploadError(
      "The upload body could not be read to completion.",
    );
  }

  const size = meter.size;
  const sha256 = meter.digest();

  if (expectedSize !== undefined && size !== expectedSize) {
    await safeUnlink(tempPath);
    throw new InvalidUploadError(
      "The uploaded file does not match its declared size.",
    );
  }

  // The destination must still be inside the root before anything can be
  // published there.
  await assertSafePath(root, finalPath);
  await assertSafePath(root, path.dirname(finalPath));

  return { tempPath, size, sha256 };
}

export async function discardStagedUpload(tempPath: string) {
  await safeUnlink(tempPath);
}

/**
 * Publishes a staged upload atomically.
 *
 * Never overwrites: identical bytes are reported as a duplicate (so a retried
 * PUT succeeds) and different bytes as a conflict.
 */
export async function publishStagedUpload({
  root,
  key,
  tempPath,
  size,
  sha256,
}: {
  root: string;
  key: string;
} & StagedUpload): Promise<LocalStoreResult> {
  const finalPath = resolveLocalObjectPath(root, key);
  const parentDir = path.dirname(finalPath);

  await assertSafePath(root, parentDir);
  await fs.mkdir(parentDir, { recursive: true });
  await assertSafePath(root, parentDir);
  await assertSafePath(root, finalPath);

  const existing = await lstatRegularFile(finalPath);
  if (existing) {
    await safeUnlink(tempPath);

    if (
      existing.size === size &&
      (await hashFileAt(root, finalPath)) === sha256
    ) {
      return { status: "duplicate", size, sha256 };
    }

    return { status: "conflict", size, sha256 };
  }

  try {
    // link() is an atomic create-if-absent, so a concurrent publisher cannot be
    // overwritten even though the existence check above is racy on its own.
    await fs.link(tempPath, finalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      await safeUnlink(tempPath);

      if ((await hashFileAt(root, finalPath)) === sha256) {
        return { status: "duplicate", size, sha256 };
      }

      return { status: "conflict", size, sha256 };
    }

    await safeUnlink(tempPath);
    throw error;
  }

  await safeUnlink(tempPath);

  return { status: "stored", size, sha256 };
}

async function hashFileAt(root: string, filePath: string) {
  const key = path.relative(root, filePath).split(path.sep).join("/");
  const { handle } = await openRegularFile(root, key);

  try {
    return await hashOpenFile(handle);
  } finally {
    await handle.close().catch(() => {});
  }
}

/** Stages and publishes in one step, for callers with nothing to coordinate. */
export async function storeLocalUpload({
  root,
  key,
  body,
  maxBytes,
  expectedSize,
}: {
  root: string;
  key: string;
  body: ReadableStream<Uint8Array>;
  maxBytes: number;
  expectedSize?: number;
}): Promise<LocalStoreResult> {
  const staged = await stageLocalUpload({
    root,
    key,
    body,
    maxBytes,
    expectedSize,
  });

  return publishStagedUpload({ root, key, ...staged });
}

export async function statLocalObject(root: string, key: string) {
  const filePath = resolveLocalObjectPath(root, key);
  await assertSafePath(root, filePath);

  const stat = await lstatRegularFile(filePath);
  return stat ? { path: filePath, size: stat.size, mtime: stat.mtime } : null;
}

export async function readLocalObject(
  root: string,
  key: string,
): Promise<AssetObject> {
  const { handle, stat } = await openRegularFile(root, key);

  const stream = handle.createReadStream({ autoClose: true });
  stream.once("close", () => {
    handle.close().catch(() => {});
  });

  return {
    body: Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>,
    contentType: undefined,
    contentLength: stat.size,
    etag: `"local-${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`,
    lastModified: stat.mtime,
  };
}

export async function deleteLocalObject(root: string, key: string) {
  // An unreachable root is a failure, never "already deleted": reporting
  // success would drop the queue record and orphan the file once the volume
  // comes back. This check deliberately does not create the directory.
  await assertLocalStorageRootAvailable(root);

  const filePath = resolveLocalObjectPath(root, key);
  await assertSafePath(root, filePath);

  const stat = await lstatRegularFile(filePath);
  if (!stat) return;

  try {
    await fs.unlink(filePath);
  } catch (error) {
    // Another cleanup pass may have removed it between the check and the
    // unlink. An absent file is the desired end state, not a failure.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/**
 * Re-checks a stored object against the metadata recorded for its upload.
 *
 * Supplying only `expectedSha256` (not the size) is the recovery path: when a
 * crash happened after the file was published but before the upload record was
 * updated, the declared size is still checked and the digest computed here.
 */
export async function verifyStoredLocalObject({
  root,
  key,
  expectedSize,
  expectedSha256,
}: {
  root: string;
  key: string;
  expectedSize: number | null;
  expectedSha256: string | null;
}) {
  let handle: Awaited<ReturnType<typeof fs.open>>;
  let size: number;

  try {
    const opened = await openRegularFile(root, key);
    handle = opened.handle;
    size = opened.stat.size;
  } catch (error) {
    if (error instanceof LocalObjectNotFoundError) {
      throw new InvalidUploadError("The uploaded file could not be found.");
    }
    throw error;
  }

  try {
    if (expectedSize !== null && size !== expectedSize) {
      throw new InvalidUploadError(
        "The uploaded file does not match its recorded size.",
      );
    }

    const sha256 = await hashOpenFile(handle);

    if (expectedSha256 !== null && sha256 !== expectedSha256) {
      throw new InvalidUploadError(
        "The uploaded file does not match its recorded checksum.",
      );
    }

    return { size, sha256 };
  } finally {
    await handle.close().catch(() => {});
  }
}

export function assertLocalTaskImageKeyMatchesContext(
  key: string,
  context: Omit<TaskImageUploadContext, "filename" | "contentType">,
) {
  return keyMatchesPrefix(key, buildObjectKeyPrefix(context));
}
