import { eq } from "drizzle-orm";
import db, { type DatabaseInstance, schema } from "../database";
import { deleteAssetObject } from "./index";
import type { StorageBackend } from "./shared";

export type StorageCleanupRef = {
  objectKey: string;
  storageBackend: string;
};

/** Minimal query surface shared by the pool and a transaction. */
export type StorageRefReader = Pick<DatabaseInstance, "select">;
export type StorageCleanupWriter = Pick<DatabaseInstance, "insert">;

export function dedupeStorageRefs(
  refs: StorageCleanupRef[],
): StorageCleanupRef[] {
  return [
    ...new Map(
      refs.map((ref) => [`${ref.storageBackend}:${ref.objectKey}`, ref]),
    ).values(),
  ];
}

/**
 * Records objects that must still be deleted.
 *
 * Called inside the deleting transaction so the intent to remove the file is
 * committed together with the row that referenced it. A crash between the two
 * would otherwise lose the only pointer to the file.
 */
export async function enqueueStorageCleanup(
  executor: StorageCleanupWriter,
  refs: StorageCleanupRef[],
) {
  const pending = dedupeStorageRefs(refs);
  if (pending.length === 0) return;

  await executor
    .insert(schema.storageCleanupQueueTable)
    .values(
      pending.map((ref) => ({
        backend: ref.storageBackend,
        objectKey: ref.objectKey,
      })),
    )
    .onConflictDoNothing({
      target: schema.storageCleanupQueueTable.objectKey,
    });
}

/**
 * Attempts every queued deletion. A failure keeps its row so the hourly job
 * retries it; only a confirmed delete (or a file that is genuinely absent)
 * clears the entry. An unconfigured or unreachable backend counts as a failure,
 * never as success.
 */
export async function processStorageCleanupQueue(): Promise<{
  deleted: number;
  failed: number;
  degraded: boolean;
}> {
  const rows = await db.select().from(schema.storageCleanupQueueTable);

  let deleted = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      await deleteAssetObject(row.backend as StorageBackend, row.objectKey);

      await db
        .delete(schema.storageCleanupQueueTable)
        .where(eq(schema.storageCleanupQueueTable.id, row.id));
      deleted += 1;
    } catch (error) {
      failed += 1;

      const errorCode =
        (error as NodeJS.ErrnoException).code ??
        (error instanceof Error ? error.name : "unknown");

      await db
        .update(schema.storageCleanupQueueTable)
        .set({
          lastAttemptAt: new Date(),
          lastErrorCode: errorCode.slice(0, 64),
        })
        .where(eq(schema.storageCleanupQueueTable.id, row.id));

      console.error("Failed to delete a queued storage object", {
        backend: row.backend,
        key: row.objectKey,
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  return { deleted, failed, degraded: failed > 0 };
}
