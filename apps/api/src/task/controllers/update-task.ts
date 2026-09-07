import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { columnTable, taskTable } from "../../database/schema";
import { publishEvent } from "../../events";
import {
  lockMilestonesInProject,
  normalizeMilestoneId,
} from "../../milestone/validate-milestone";
import { deleteOrphanedAssets } from "../../storage/cleanup-assets";
import {
  assertAssignableUser,
  getProjectWorkspaceId,
} from "../../utils/assert-assignable-user";
import { assertValidTaskStatus } from "../validate-task-fields";

async function updateTask(
  id: string,
  title: string,
  status: string,
  startDate: Date | undefined,
  dueDate: Date | undefined,
  projectId: string,
  description: string,
  priority: string,
  position: number,
  userId?: string,
  currentUserId?: string,
  milestoneId?: string | null,
) {
  const [taskPreview] = await db
    .select({
      id: taskTable.id,
      projectId: taskTable.projectId,
      milestoneId: taskTable.milestoneId,
    })
    .from(taskTable)
    .where(eq(taskTable.id, id))
    .limit(1);

  if (!taskPreview) {
    throw new HTTPException(404, {
      message: "Task not found",
    });
  }

  if (projectId !== taskPreview.projectId) {
    throw new HTTPException(400, {
      message: "Use the task move endpoint to move tasks between projects",
    });
  }

  const normalizedUserId = userId?.trim() || undefined;
  const normalizedMilestoneId = normalizeMilestoneId(milestoneId);

  if (normalizedUserId) {
    await assertAssignableUser(
      normalizedUserId,
      await getProjectWorkspaceId(projectId),
    );
  }

  const result = await db.transaction(async (tx) => {
    if (milestoneId !== undefined) {
      await lockMilestonesInProject(
        tx,
        [taskPreview.milestoneId, normalizedMilestoneId],
        taskPreview.projectId,
      );
    }

    const [existingTask] = await tx
      .select()
      .from(taskTable)
      .where(eq(taskTable.id, id))
      .for("update");

    if (!existingTask) {
      throw new HTTPException(404, {
        message: "Task not found",
      });
    }

    if (existingTask.projectId !== projectId) {
      throw new HTTPException(409, {
        message: "The task's project changed before the update completed",
      });
    }

    await assertValidTaskStatus(status, projectId, tx);

    const [column] = await tx
      .select()
      .from(columnTable)
      .where(
        and(eq(columnTable.projectId, projectId), eq(columnTable.slug, status)),
      )
      .limit(1);

    const updateData: {
      title: string;
      status: string;
      columnId: string | null;
      startDate: Date | null;
      dueDate: Date | null;
      projectId: string;
      description: string;
      priority: string;
      position: number;
      userId: string | null;
      milestoneId?: string | null;
    } = {
      title,
      status,
      columnId: column?.id ?? null,
      startDate: startDate || null,
      dueDate: dueDate || null,
      projectId,
      description,
      priority,
      position,
      userId: normalizedUserId ?? null,
    };

    if (milestoneId !== undefined) {
      updateData.milestoneId = normalizedMilestoneId ?? null;
    }

    const [updatedTask] = await tx
      .update(taskTable)
      .set(updateData)
      .where(eq(taskTable.id, id))
      .returning();

    return { existingTask, updatedTask };
  });

  const { existingTask, updatedTask } = result;

  if (!updatedTask) {
    throw new HTTPException(500, {
      message: "Failed to update task",
    });
  }

  if (
    milestoneId !== undefined &&
    existingTask.milestoneId !== updatedTask.milestoneId
  ) {
    await publishEvent("task.milestone_changed", {
      taskId: updatedTask.id,
      projectId: updatedTask.projectId,
      userId: currentUserId,
      oldMilestoneId: existingTask.milestoneId,
      newMilestoneId: updatedTask.milestoneId,
      type: "milestone_changed",
    });
  }

  if (existingTask.status !== status) {
    await publishEvent("task.status_changed", {
      taskId: updatedTask.id,
      projectId: updatedTask.projectId,
      userId: currentUserId,
      oldStatus: existingTask.status,
      newStatus: status,
      title: updatedTask.title,
      assigneeId: updatedTask.userId,
      type: "status_changed",
    });

    await publishEvent("task-relation.refresh", {
      projectId: updatedTask.projectId,
      userId: currentUserId,
    });
  }

  await publishEvent("task.updated", {
    taskId: updatedTask.id,
    projectId: updatedTask.projectId,
    title: updatedTask.title,
    status: updatedTask.status,
    userId: currentUserId,
  });

  if (existingTask.description !== description) {
    deleteOrphanedAssets(existingTask.description, description, {
      taskId: id,
    }).catch(() => {});
  }

  return updatedTask;
}

export default updateTask;
