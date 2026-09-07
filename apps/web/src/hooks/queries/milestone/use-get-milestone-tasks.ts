import { useQuery } from "@tanstack/react-query";
import getMilestoneTasks, {
  type MilestoneTasksResponse,
} from "@/fetchers/milestone/get-milestone-tasks";

export function useGetMilestoneTasks(
  projectId: string | undefined,
  milestoneId: string | undefined,
  page = 1,
) {
  return useQuery<MilestoneTasksResponse>({
    queryKey: ["milestone-tasks", projectId, milestoneId, page],
    queryFn: () =>
      getMilestoneTasks(projectId as string, milestoneId as string, page),
    enabled: Boolean(projectId && milestoneId),
  });
}

export default useGetMilestoneTasks;
