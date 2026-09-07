import { client } from "@kaneo/libs";
import { HttpError } from "@/lib/http-error";
import type { MilestoneSummary } from "@/types/milestone";

async function getMilestones(projectId: string): Promise<MilestoneSummary[]> {
  const response = await client.milestone.project[":projectId"].$get({
    param: { projectId },
  });

  if (!response.ok) {
    throw new HttpError(response.status, "Failed to fetch milestones");
  }

  const milestones = (await response.json()) as unknown as MilestoneSummary[];

  // Normalize summary fields in case backend returns raw milestones without aggregations
  return milestones.map((m) => {
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
  });
}

export default getMilestones;
