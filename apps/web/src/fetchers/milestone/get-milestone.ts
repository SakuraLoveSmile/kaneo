import { client } from "@kaneo/libs";
import { HttpError } from "@/lib/http-error";
import type { MilestoneSummary } from "@/types/milestone";

async function getMilestone(id: string): Promise<MilestoneSummary> {
  const response = await client.milestone[":id"].$get({
    param: { id },
  });

  if (!response.ok) {
    throw new HttpError(response.status, "Failed to fetch milestone");
  }

  const m = (await response.json()) as unknown as MilestoneSummary;
  const total = m.totalTasks ?? 0;
  const completed = m.completedTasks ?? 0;
  const progress =
    m.progress ?? (total > 0 ? Math.round((completed / total) * 100) : 0);

  return {
    ...m,
    totalTasks: total,
    completedTasks: completed,
    progress,
  };
}

export default getMilestone;
