import { and, asc, eq, max } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import {
  assetTable,
  columnTable,
  projectTable,
  taskTable,
} from "../../database/schema";
import { publishEvent } from "../../events";
import { lockMilestonesInProject } from "../../milestone/validate-milestone";
import { claimTaskNumber } from "./claim-task-numbers";

type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

function isSameProjectMove(
  sourceProjectId: string,
  destinationProjectId: string,
) {
  return sourceProjectId === destinationProjectId;
}

async function resolveDestinationStatus(
  destinationProjectId: string,
  currentStatus: string,
  requestedStatus?: string,
  dbOrTx: DbOrTx = db,
) {
  const destinationColumns = await dbOrTx
    .select({
      id: columnTable.id,
      slug: columnTable.slug,
      position: columnTable.position,
    })
    .from(columnTable)
    .where(eq(columnTable.projectId, destinationProjectId))
    .orderBy(asc(columnTable.position));

  const [firstColumn] = destinationColumns;

  if (!firstColumn) {
    throw new HTTPException(400, {
      message: "Destination project does not have a workflow",
    });
  }

  const requestedColumn = requestedStatus
    ? destinationColumns.find((column) => column.slug === requestedStatus)
    : null;

  if (requestedStatus && !requestedColumn) {
    throw new HTTPException(400, {
      message: "Selected status is not valid for the destination project",
    });
  }

  const matchingCurrentColumn = destinationColumns.find(
    (column) => column.slug === currentStatus,
  );

  return requestedColumn ?? matchingCurrentColumn ?? firstColumn;
}

async function getNextTaskPosition(
  dbOrTx: DbOrTx,
  projectId: string,
  status: string,
  columnId: string,
) {
  const [maxPositionResult] = await dbOrTx
    .select({ maxPosition: max(taskTable.position) })
    .from(taskTable)
    .where(
      and(
        eq(taskTable.projectId, projectId),
        eq(taskTable.status, status),
        eq(taskTable.columnId, columnId),
      ),
    );

  return (maxPositionResult?.maxPosition ?? 0) + 1;
}

async function moveTask({
  taskId,
  destinationProjectId,
  destinationStatus,
  currentUserId,
  workspaceId,
}: {
  taskId: string;
  destinationProjectId: string;
  destinationStatus?: string;
  currentUserId: string;
  workspaceId?: string;
}) {
  // This read only supplies the possible parent lock. The task is read again
  // under a row lock before any project or workflow decision is made.
  const [taskPreview] = await db
    .select({
      projectId: taskTable.projectId,
      milestoneId: taskTable.milestoneId,
    })
    .from(taskTable)
    .where(eq(taskTable.id, taskId))
    .limit(1);

  if (!taskPreview) {
    throw new HTTPException(404, { message: "Task not found" });
  }

  const result = await db.transaction(async (tx) => {
    if (taskPreview.milestoneId) {
      await lockMilestonesInProject(
        tx,
        [taskPreview.milestoneId],
        taskPreview.projectId,
      );
    }

    const [existingTask] = await tx
      .select()
      .from(taskTable)
      .where(eq(taskTable.id, taskId))
      .for("update");

    if (!existingTask) {
      throw new HTTPException(404, { message: "Task not found" });
    }

    const [sourceProject] = await tx
      .select()
      .from(projectTable)
      .where(eq(projectTable.id, existingTask.projectId))
      .limit(1);
    const [destinationProject] = await tx
      .select()
      .from(projectTable)
      .where(eq(projectTable.id, destinationProjectId))
      .limit(1);

    if (!sourceProject || !destinationProject) {
      throw new HTTPException(404, { message: "Project not found" });
    }

    if (workspaceId && sourceProject.workspaceId !== workspaceId) {
      throw new HTTPException(409, {
        message: "The task's workspace changed before the move completed",
      });
    }

    if (isSameProjectMove(existingTask.projectId, destinationProjectId)) {
      throw new HTTPException(400, {
        message: "Task is already in that project",
      });
    }

    if (sourceProject.workspaceId !== destinationProject.workspaceId) {
      throw new HTTPException(400, {
        message: "Tasks can only be moved within the same workspace",
      });
    }

    const resolvedColumn = await resolveDestinationStatus(
      destinationProjectId,
      existingTask.status,
      destinationStatus,
      tx,
    );

    const [nextTaskNumber, nextPosition] = await Promise.all([
      claimTaskNumber(destinationProjectId, tx),
      getNextTaskPosition(
        tx,
        destinationProjectId,
        resolvedColumn.slug,
        resolvedColumn.id,
      ),
    ]);

    const [updatedTask] = await tx
      .update(taskTable)
      .set({
        projectId: destinationProjectId,
        status: resolvedColumn.slug,
        columnId: resolvedColumn.id,
        milestoneId: null,
        number: nextTaskNumber,
        position: nextPosition,
      })
      .where(eq(taskTable.id, taskId))
      .returning();

    if (!updatedTask) {
      throw new HTTPException(500, {
        message: "Failed to move task",
      });
    }

    await tx
      .update(assetTable)
      .set({ projectId: destinationProjectId })
      .where(eq(assetTable.taskId, taskId));

    return {
      movedTask: updatedTask,
      sourceProject,
      destinationProject,
      resolvedColumn,
      existingTask,
    };
  });

  const {
    movedTask,
    sourceProject,
    destinationProject,
    resolvedColumn,
    existingTask,
  } = result;

  await publishEvent("task.moved", {
    taskId,
    type: "moved",
    userId: currentUserId,
    fromProjectId: sourceProject.id,
    fromProjectName: sourceProject.name,
    toProjectId: destinationProject.id,
    toProjectName: destinationProject.name,
    oldStatus: existingTask.status,
    newStatus: resolvedColumn.slug,
  });

  return {
    task: movedTask,
    sourceProjectId: sourceProject.id,
    destinationProjectId: destinationProject.id,
  };
}

export default moveTask;
