import { client } from "@kaneo/libs";
import { HttpError } from "@/lib/http-error";
import type Task from "@/types/task";

export type MilestoneTasksResponse = {
  tasks: Task[];
  pagination: {
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  };
};

async function getMilestoneTasks(
  projectId: string,
  milestoneId: string,
  page = 1,
  limit = 50,
): Promise<MilestoneTasksResponse> {
  const response = await client.task.tasks[":projectId"].$get({
    param: { projectId },
    query: {
      milestoneId,
      page: String(page),
      limit: String(limit),
    },
  });

  if (!response.ok) {
    throw new HttpError(response.status, "Failed to fetch milestone tasks");
  }

  const json = await response.json();
  const data = json.data;

  // Merge columns, plannedTasks, and archivedTasks, then deduplicate by task id
  const columnTasks = (data.columns || []).flatMap(
    (col: { tasks?: Task[] }) => col.tasks || [],
  );
  const plannedTasks = (data.plannedTasks || []) as Task[];
  const archivedTasks = (data.archivedTasks || []) as Task[];

  const taskMap = new Map<string, Task>();
  for (const task of [...columnTasks, ...plannedTasks, ...archivedTasks]) {
    if (task && task.id && !taskMap.has(task.id)) {
      taskMap.set(task.id, task);
    }
  }

  const mergedTasks = Array.from(taskMap.values());

  const pagination = json.pagination || {
    total: mergedTasks.length,
    page,
    pageSize: limit,
    totalPages: Math.max(1, Math.ceil(mergedTasks.length / limit)),
  };

  return {
    tasks: mergedTasks,
    pagination,
  };
}

export default getMilestoneTasks;
