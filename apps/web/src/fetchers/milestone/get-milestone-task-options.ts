import { client } from "@kaneo/libs";
import { HttpError } from "@/lib/http-error";
import type Task from "@/types/task";

export type MilestoneTaskOptionsResponse = {
  tasks: Task[];
  totalPages: number;
  total: number;
};

export async function getMilestoneTaskOptions({
  projectId,
  page = 1,
  limit = 50,
  search,
}: {
  projectId: string;
  page?: number;
  limit?: number;
  search?: string;
}): Promise<MilestoneTaskOptionsResponse> {
  const queryParams: Record<string, string> = {
    page: String(page),
    limit: String(limit),
  };

  const trimmedSearch = search?.trim();
  if (trimmedSearch) {
    queryParams.search = trimmedSearch;
  }

  const response = await client.task.tasks[":projectId"].$get({
    param: { projectId },
    query: queryParams,
  });

  if (!response.ok) {
    throw new HttpError(response.status, "Failed to fetch task options");
  }

  const json = await response.json();
  const data = json.data;

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
  const totalPages = json.pagination?.totalPages ?? 1;
  const total = json.pagination?.total ?? mergedTasks.length;

  return {
    tasks: mergedTasks,
    totalPages,
    total,
  };
}

export default getMilestoneTaskOptions;
