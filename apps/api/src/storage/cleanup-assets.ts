import { and, eq, inArray, like } from "drizzle-orm";
import db from "../database";
import {
  activityTable,
  assetTable,
  assetUploadTable,
  commentTable,
  taskTable,
} from "../database/schema";
import {
  dedupeStorageRefs,
  type StorageCleanupRef,
  type StorageRefReader,
} from "./cleanup-queue";
import { deleteAssetObject } from "./index";
import type { StorageBackend } from "./shared";

const ASSET_URL_PATTERN = /\/api\/asset\/([a-z0-9]+)/gi;

export type StoredAssetRef = StorageCleanupRef;

/**
 * Collects every stored object a set of tasks owns.
 *
 * Includes `asset_upload` rows, not just finalized `asset` rows, so a file that
 * was uploaded but never finalized is still removed with its task.
 */
export async function collectTaskStorageRefs(
  taskIds: string[],
  reader: StorageRefReader = db,
): Promise<StorageCleanupRef[]> {
  if (taskIds.length === 0) return [];

  const assets = await reader
    .select({
      objectKey: assetTable.objectKey,
      storageBackend: assetTable.storageBackend,
    })
    .from(assetTable)
    .where(inArray(assetTable.taskId, taskIds));

  const uploads = await reader
    .select({
      objectKey: assetUploadTable.objectKey,
      storageBackend: assetUploadTable.backend,
    })
    .from(assetUploadTable)
    .where(inArray(assetUploadTable.taskId, taskIds));

  return dedupeStorageRefs([...assets, ...uploads]);
}

export function extractAssetIds(
  content: string | null | undefined,
): Set<string> {
  const ids = new Set<string>();
  if (!content) return ids;

  ASSET_URL_PATTERN.lastIndex = 0;
  for (
    let match = ASSET_URL_PATTERN.exec(content);
    match !== null;
    match = ASSET_URL_PATTERN.exec(content)
  ) {
    if (match[1]) ids.add(match[1]);
  }

  return ids;
}

export function contentReferencesAsset(
  content: string | null | undefined,
  assetId: string,
): boolean {
  return extractAssetIds(content).has(assetId);
}

export interface AssetCleanupScope {
  taskId: string;
}

/**
 * Check whether an asset ID is still referenced in any content belonging to
 * the same task (description, comments, or activity comments).
 */
async function isAssetReferencedElsewhere(
  assetId: string,
  taskId: string,
): Promise<boolean> {
  const pattern = `%/api/asset/${assetId}%`;

  const [taskRef] = await db
    .select({ description: taskTable.description })
    .from(taskTable)
    .where(and(eq(taskTable.id, taskId), like(taskTable.description, pattern)))
    .limit(1);

  if (contentReferencesAsset(taskRef?.description, assetId)) return true;

  const commentRefs = await db
    .select({ content: commentTable.content })
    .from(commentTable)
    .where(
      and(eq(commentTable.taskId, taskId), like(commentTable.content, pattern)),
    );

  if (commentRefs.some((ref) => contentReferencesAsset(ref.content, assetId))) {
    return true;
  }

  const activityRefs = await db
    .select({ content: activityTable.content })
    .from(activityTable)
    .where(
      and(
        eq(activityTable.taskId, taskId),
        like(activityTable.content, pattern),
      ),
    );

  if (
    activityRefs.some((ref) => contentReferencesAsset(ref.content, assetId))
  ) {
    return true;
  }

  return false;
}

export async function deleteOrphanedAssets(
  oldContent: string | null | undefined,
  newContent: string | null | undefined,
  scope: AssetCleanupScope,
): Promise<void> {
  const oldIds = extractAssetIds(oldContent);
  const newIds = extractAssetIds(newContent);

  const removedIds = [...oldIds].filter((id) => !newIds.has(id));
  if (removedIds.length === 0) return;

  const assets = await db
    .select({
      id: assetTable.id,
      objectKey: assetTable.objectKey,
      storageBackend: assetTable.storageBackend,
    })
    .from(assetTable)
    .where(
      and(
        inArray(assetTable.id, removedIds),
        eq(assetTable.taskId, scope.taskId),
      ),
    );

  const assetsToDelete: typeof assets = [];
  for (const asset of assets) {
    const stillReferenced = await isAssetReferencedElsewhere(
      asset.id,
      scope.taskId,
    );
    if (!stillReferenced) {
      assetsToDelete.push(asset);
    }
  }

  if (assetsToDelete.length === 0) return;

  const deleteResults = await deleteAssetObjects(assetsToDelete);

  const deletedAssetIds = assetsToDelete
    .filter((_, index) => deleteResults[index]?.status === "fulfilled")
    .map((asset) => asset.id);

  if (deletedAssetIds.length === 0) return;

  await db.delete(assetTable).where(inArray(assetTable.id, deletedAssetIds));
}

export async function getTaskAssets(taskId: string): Promise<StoredAssetRef[]> {
  const assets = await db
    .select({
      objectKey: assetTable.objectKey,
      storageBackend: assetTable.storageBackend,
    })
    .from(assetTable)
    .where(eq(assetTable.taskId, taskId));

  return assets;
}

/**
 * Deletes each object through its owning backend and reports failures without
 * aborting the rest, since one unreachable backend should not strand the
 * others.
 */
export async function deleteAssetObjects(
  assets: StoredAssetRef[],
): Promise<PromiseSettledResult<void>[]> {
  const deleteResults = await Promise.allSettled(
    assets.map((asset) =>
      deleteAssetObject(
        asset.storageBackend as StorageBackend,
        asset.objectKey,
      ),
    ),
  );

  const failedDeletions = assets
    .map((asset, index) => ({ asset, result: deleteResults[index] }))
    .filter(
      (
        deletion,
      ): deletion is {
        asset: StoredAssetRef;
        result: PromiseRejectedResult;
      } => deletion.result?.status === "rejected",
    );

  if (failedDeletions.length > 0) {
    console.error(
      "Failed to delete stored objects",
      failedDeletions.map(({ asset, result }) => ({
        key: asset.objectKey,
        backend: asset.storageBackend,
        reason: result.reason,
      })),
    );
  }

  return deleteResults;
}
