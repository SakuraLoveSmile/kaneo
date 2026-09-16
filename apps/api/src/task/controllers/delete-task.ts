import { eq, or } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { taskRelationTable, taskTable } from "../../database/schema";
import { publishEvent } from "../../events";
import {
  collectTaskStorageRefs,
  deleteAssetObjects,
} from "../../storage/cleanup-assets";
import {
  enqueueStorageCleanup,
  processStorageCleanupQueue,
} from "../../storage/cleanup-queue";
import getTask from "./get-task";

async function deleteTask(taskId: string, currentUserId: string) {
  const task = await getTask(taskId);

  const relations = await db
    .select()
    .from(taskRelationTable)
    .where(
      or(
        eq(taskRelationTable.sourceTaskId, taskId),
        eq(taskRelationTable.targetTaskId, taskId),
      ),
    )
    .execute();

  const outcome = await db.transaction(async (tx) => {
    // Serializes against an in-flight upload publish for the same task, and
    // against a concurrent delete of it.
    const [locked] = await tx
      .select({ id: taskTable.id })
      .from(taskTable)
      .where(eq(taskTable.id, taskId))
      .limit(1)
      .for("update");

    if (!locked) return null;

    // Collected while the lock is held so a publish that already landed is
    // included, and recorded in the same transaction that removes the task: a
    // committed delete must never lose track of a file it owns.
    const refs = await collectTaskStorageRefs([taskId], tx);
    const localRefs = refs.filter((ref) => ref.storageBackend === "local");
    const remoteRefs = refs.filter((ref) => ref.storageBackend !== "local");

    await enqueueStorageCleanup(tx, localRefs);

    await tx.delete(taskTable).where(eq(taskTable.id, taskId));

    return { remoteRefs };
  });

  if (!outcome) {
    throw new HTTPException(404, {
      message: "Task not found",
    });
  }

  await publishEvent("task.deleted", {
    taskId: task.id,
    projectId: task.projectId,
    userId: currentUserId,
    title: task.title,
  });

  for (const relation of relations) {
    await publishEvent("task-relation.deleted", {
      projectId: task.projectId,
      userId: currentUserId,
      taskId: taskId,
      sourceTaskId: relation.sourceTaskId,
      targetTaskId: relation.targetTaskId,
    });
  }

  // Post-commit cleanup: S3 objects keep the previous fire-and-forget path, and
  // queued local objects are attempted immediately, with the hourly job as the
  // retry path.
  if (outcome.remoteRefs.length > 0) {
    deleteAssetObjects(outcome.remoteRefs).catch(() => {});
  }
  processStorageCleanupQueue().catch(() => {});

  return task;
}

export default deleteTask;
