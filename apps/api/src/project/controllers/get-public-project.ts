import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { projectTable } from "../../database/schema";
import getTasks from "../../task/controllers/get-tasks";

function toPublicTask<T extends { milestoneId: string | null }>(task: T) {
  const { milestoneId: _milestoneId, ...publicTask } = task;
  return publicTask;
}

function toPublicProjectBoard<
  T extends {
    columns: Array<{ tasks: Array<{ milestoneId: string | null }> }>;
    archivedTasks: Array<{ milestoneId: string | null }>;
    plannedTasks: Array<{ milestoneId: string | null }>;
  },
>(board: T) {
  return {
    ...board,
    columns: board.columns.map((column) => ({
      ...column,
      tasks: column.tasks.map(toPublicTask),
    })),
    archivedTasks: board.archivedTasks.map(toPublicTask),
    plannedTasks: board.plannedTasks.map(toPublicTask),
  };
}

export async function getPublicProject(id: string) {
  const [project] = await db
    .select({ isPublic: projectTable.isPublic })
    .from(projectTable)
    .where(eq(projectTable.id, id))
    .limit(1);

  if (!project) {
    throw new HTTPException(404, {
      message: "Project not found",
    });
  }

  if (!project.isPublic) {
    throw new HTTPException(403, {
      message: "Project is not public",
    });
  }

  const result = await getTasks(id);

  if (!result.data) {
    throw new HTTPException(404, {
      message: "Project not found",
    });
  }

  if (!result.data.isPublic) {
    throw new HTTPException(403, {
      message: "Project is not public",
    });
  }

  // Public boards intentionally use a separate serialization boundary. The
  // internal board now carries milestoneId, but public access must not reveal
  // private roadmap structure or associations.
  return toPublicProjectBoard(result.data);
}
