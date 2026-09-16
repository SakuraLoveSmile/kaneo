import { and, desc, eq } from "drizzle-orm";
import db from "../../database";
import { assetTable, assetUploadTable, taskTable } from "../../database/schema";
import {
  ensureLocalStorageReady,
  InvalidUploadError,
  isImageContentType,
  StorageUnavailableError,
  UnsafeStoragePathError,
  verifyStoredLocalObject,
  verifyTaskImageUploadKey,
} from "../../storage";

export type FinalizeLocalImageUploadResult =
  | { status: "ok"; assetId: string }
  | { status: "not-local" }
  | { status: "key-mismatch" }
  | { status: "metadata-mismatch" }
  | { status: "size-mismatch" }
  | { status: "task-gone" }
  | { status: "invalid"; message: string }
  | { status: "unavailable"; message: string }
  | { status: "save-failed" };

type TaskContext = {
  workspaceId: string;
  projectId: string;
  taskId: string;
};

/**
 * Registers an uploaded local file as a task asset.
 *
 * Runs under the same task row lock that deletion takes, so a task cannot be
 * removed between verifying the file and recording the asset. A file whose
 * upload record survived but whose task did not is refused rather than
 * resurrected.
 *
 * The finalize request's `size` is checked against the size recorded at upload
 * time, never used to overwrite it: a caller cannot widen or narrow the
 * contract after the bytes were accepted.
 */
export async function finalizeLocalImageUpload({
  taskContext,
  key,
  filename,
  contentType,
  size,
  surface,
  createdBy,
}: {
  taskContext: TaskContext;
  key: string;
  filename: string;
  contentType: string;
  size: number;
  surface: "description" | "comment";
  createdBy: string | null;
}): Promise<FinalizeLocalImageUploadResult> {
  // Cheap pre-check so S3-style finalizes never take the lock.
  const [preflight] = await db
    .select({ id: assetUploadTable.id })
    .from(assetUploadTable)
    .where(
      and(
        eq(assetUploadTable.objectKey, key),
        eq(assetUploadTable.taskId, taskContext.taskId),
        eq(assetUploadTable.backend, "local"),
      ),
    )
    .limit(1);

  if (!preflight) return { status: "not-local" };

  let root: string;
  try {
    root = await ensureLocalStorageReady();
  } catch (error) {
    return {
      status: "unavailable",
      message:
        error instanceof StorageUnavailableError
          ? error.message
          : "Local storage is unavailable on this instance.",
    };
  }

  return db.transaction(async (tx) => {
    const [lockedTask] = await tx
      .select({ id: taskTable.id })
      .from(taskTable)
      .where(eq(taskTable.id, taskContext.taskId))
      .limit(1)
      .for("update");

    if (!lockedTask) return { status: "task-gone" as const };

    const [record] = await tx
      .select()
      .from(assetUploadTable)
      .where(
        and(
          eq(assetUploadTable.objectKey, key),
          eq(assetUploadTable.taskId, taskContext.taskId),
          eq(assetUploadTable.backend, "local"),
        ),
      )
      .orderBy(desc(assetUploadTable.createdAt))
      .limit(1);

    if (!record) return { status: "key-mismatch" as const };

    if (
      record.workspaceId !== taskContext.workspaceId ||
      record.projectId !== taskContext.projectId ||
      !verifyTaskImageUploadKey("local", key, {
        workspaceId: taskContext.workspaceId,
        projectId: taskContext.projectId,
        taskId: taskContext.taskId,
        surface,
      })
    ) {
      return { status: "key-mismatch" as const };
    }

    if (
      record.mimeType !== contentType ||
      record.filename !== filename ||
      record.surface !== surface
    ) {
      return { status: "metadata-mismatch" as const };
    }

    // The declared size is the contract both the request and the stored record
    // must honour. A record whose actual size already disagrees with what was
    // declared is left untouched for the recovery flow: it is refused, not
    // corrected, and neither the file nor the record is rewritten.
    if (
      size !== record.declaredSize ||
      (record.actualSize !== null && record.actualSize !== record.declaredSize)
    ) {
      return { status: "size-mismatch" as const };
    }

    // Re-finalizing an upload must return the registered asset instead of
    // rewriting its metadata. Reached only after the size, name, type and
    // surface all match.
    const [registered] = await tx
      .select({ id: assetTable.id })
      .from(assetTable)
      .where(eq(assetTable.objectKey, key))
      .limit(1);

    if (registered) return { status: "ok" as const, assetId: registered.id };

    let verified: { size: number; sha256: string };
    try {
      verified = await verifyStoredLocalObject({
        root,
        key,
        // Always the original declaration, so a record with a divergent
        // actualSize cannot be used to accept a differently sized file.
        expectedSize: record.declaredSize,
        expectedSha256: record.sha256,
      });
    } catch (error) {
      if (error instanceof StorageUnavailableError) {
        return { status: "unavailable" as const, message: error.message };
      }

      if (
        error instanceof InvalidUploadError ||
        error instanceof UnsafeStoragePathError
      ) {
        return { status: "invalid" as const, message: error.message };
      }

      throw error;
    }

    if (record.status !== "uploaded" || !record.sha256) {
      await tx
        .update(assetUploadTable)
        .set({
          status: "uploaded",
          actualSize: verified.size,
          sha256: verified.sha256,
          uploadedAt: new Date(),
        })
        .where(eq(assetUploadTable.id, record.id));
    }

    const [asset] = await tx
      .insert(assetTable)
      .values({
        workspaceId: taskContext.workspaceId,
        projectId: taskContext.projectId,
        taskId: taskContext.taskId,
        objectKey: key,
        filename: record.filename,
        mimeType: record.mimeType,
        size: verified.size,
        kind: isImageContentType(record.mimeType) ? "image" : "attachment",
        surface: record.surface,
        storageBackend: "local",
        createdBy,
      })
      .onConflictDoNothing({ target: assetTable.objectKey })
      .returning({ id: assetTable.id });

    const assetId =
      asset?.id ??
      (
        await tx
          .select({ id: assetTable.id })
          .from(assetTable)
          .where(eq(assetTable.objectKey, key))
          .limit(1)
      )[0]?.id;

    if (!assetId) return { status: "save-failed" as const };

    return { status: "ok" as const, assetId };
  });
}
