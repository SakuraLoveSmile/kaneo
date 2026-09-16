import fs from "node:fs/promises";
import path from "node:path";
import { and, eq, lt } from "drizzle-orm";
import db, { schema } from "../database";
import { processStorageCleanupQueue } from "./cleanup-queue";
import {
  assertSafePath,
  getLocalStorageRoot,
  getLocalTempDir,
  isLocalStorageConfigured,
  StorageUnavailableError,
  statLocalObject,
} from "./local";
import { parsePositiveInt } from "./shared";

const DEFAULT_TEMP_TTL_SECONDS = 60 * 60;

/**
 * Hourly storage maintenance.
 *
 * Queued deletions run regardless of the configured backend, so a local file
 * queued before an instance switched to S3 is still removed. The local sweep of
 * abandoned staging files only applies while local storage is in use.
 */
export async function runStorageMaintenance(now = new Date()) {
  const queue = await processStorageCleanupQueue();
  const local = await cleanupLocalUploads(now);

  return {
    queuedDeleted: queue.deleted,
    queuedFailed: queue.failed,
    tempFilesDeleted: local.tempFilesDeleted,
    recordsDeleted: local.recordsDeleted,
    degraded: queue.degraded || local.degraded,
  };
}

/**
 * Removes abandoned local-upload leftovers.
 *
 * Only `.part` files older than the grace window and upload records whose
 * credential expired without any bytes reaching the disk are touched. A file
 * that was published but never finalized is deliberately kept: a client can
 * still finalize it after the upload URL expired, which is how a worker that
 * restarted mid-upload recovers.
 */
export async function cleanupLocalUploads(now = new Date()) {
  if (!isLocalStorageConfigured()) {
    return { tempFilesDeleted: 0, recordsDeleted: 0, degraded: false };
  }

  let root: string;
  try {
    root = getLocalStorageRoot();
  } catch (error) {
    if (error instanceof StorageUnavailableError) {
      return { tempFilesDeleted: 0, recordsDeleted: 0, degraded: true };
    }
    throw error;
  }

  const graceMs =
    parsePositiveInt(
      process.env.LOCAL_UPLOAD_TEMP_TTL_SECONDS,
      DEFAULT_TEMP_TTL_SECONDS,
    ) * 1000;
  const cutoff = new Date(now.getTime() - graceMs);
  const tempResult = await cleanupStaleLocalTempFiles(root, cutoff);
  const recordsDeleted = await removeAbandonedUploadRecords(root, cutoff);

  return {
    tempFilesDeleted: tempResult.count,
    recordsDeleted,
    degraded: tempResult.failed,
  };
}

export async function cleanupStaleLocalTempFiles(root: string, cutoff: Date) {
  const tempDir = getLocalTempDir(root);
  let entries: string[];

  try {
    // Refuse to sweep through a link planted at the staging directory.
    await assertSafePath(root, tempDir);
    entries = await fs.readdir(tempDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { count: 0, failed: false };
    }
    throw error;
  }

  let count = 0;
  let failed = false;

  for (const entry of entries) {
    if (!entry.endsWith(".part")) continue;

    const filePath = path.join(tempDir, entry);

    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(filePath);
    } catch (error) {
      // A concurrent upload finishing its publish removes its own part file.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      failed = true;
      console.error("Failed to inspect a temporary upload file", {
        error: error instanceof Error ? error.message : error,
      });
      continue;
    }

    if (!stat.isFile() || stat.mtime >= cutoff) continue;

    try {
      await fs.unlink(filePath);
      count += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      failed = true;
      console.error("Failed to clean a temporary upload file", {
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  return { count, failed };
}

async function removeAbandonedUploadRecords(root: string, cutoff: Date) {
  const records = await db
    .select({
      id: schema.assetUploadTable.id,
      objectKey: schema.assetUploadTable.objectKey,
    })
    .from(schema.assetUploadTable)
    .where(
      and(
        eq(schema.assetUploadTable.backend, "local"),
        eq(schema.assetUploadTable.status, "pending"),
        lt(schema.assetUploadTable.expiresAt, cutoff),
      ),
    );

  let deleted = 0;

  for (const record of records) {
    try {
      const stored = await statLocalObject(root, record.objectKey);
      if (stored) continue;

      await db
        .delete(schema.assetUploadTable)
        .where(eq(schema.assetUploadTable.id, record.id));
      deleted += 1;
    } catch (error) {
      console.error("Failed to clean an abandoned upload record", {
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  return deleted;
}
