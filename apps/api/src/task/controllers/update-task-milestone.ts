import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { taskTable } from "../../database/schema";
import { publishEvent } from "../../events";
import {
  lockMilestonesInProject,
  normalizeMilestoneId,
} from "../../milestone/validate-milestone";

async function updateTaskMilestone({
  id,
  milestoneId,
  currentUserId,
}: {
  id: string;
  milestoneId: string | null;
  currentUserId: string;
}) {
  const [taskPreview] = await db
    .select({
      projectId: taskTable.projectId,
      milestoneId: taskTable.milestoneId,
    })
    .from(taskTable)
    .where(eq(taskTable.id, id))
    .limit(1);

  if (!taskPreview) {
    throw new HTTPException(404, { message: "Task not found" });
  }

  const normalizedMilestoneId = normalizeMilestoneId(milestoneId);

  const result = await db.transaction(async (tx) => {
    await lockMilestonesInProject(
      tx,
      [taskPreview.milestoneId, normalizedMilestoneId],
      taskPreview.projectId,
    );

    const [existingTask] = await tx
      .select()
      .from(taskTable)
      .where(eq(taskTable.id, id))
      .for("update");

    if (!existingTask) {
      throw new HTTPException(404, { message: "Task not found" });
    }

    if (existingTask.projectId !== taskPreview.projectId) {
      throw new HTTPException(409, {
        message:
          "The task's project changed before the milestone update completed",
      });
    }

    if (existingTask.milestoneId === normalizedMilestoneId) {
      return {
        task: existingTask,
        changed: false,
        oldMilestoneId: existingTask.milestoneId,
      };
    }

    const [task] = await tx
      .update(taskTable)
      .set({ milestoneId: normalizedMilestoneId })
      .where(eq(taskTable.id, id))
      .returning();

    return {
      task,
      changed: true,
      oldMilestoneId: existingTask.milestoneId,
    };
  });

  if (!result.task) {
    throw new HTTPException(500, {
      message: "Failed to update task milestone",
    });
  }

  if (result.changed) {
    await publishEvent("task.milestone_changed", {
      taskId: result.task.id,
      projectId: result.task.projectId,
      userId: currentUserId,
      oldMilestoneId: result.oldMilestoneId,
      newMilestoneId: result.task.milestoneId,
      type: "milestone_changed",
    });
  }

  return result.task;
}

export default updateTaskMilestone;
