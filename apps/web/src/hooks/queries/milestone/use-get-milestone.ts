import { useQuery } from "@tanstack/react-query";
import getMilestone from "@/fetchers/milestone/get-milestone";
import type { MilestoneSummary } from "@/types/milestone";

export function useGetMilestone(
  projectId: string | undefined,
  milestoneId: string | undefined,
) {
  return useQuery<MilestoneSummary>({
    queryKey: ["milestone", projectId, milestoneId],
    queryFn: () => getMilestone(milestoneId as string),
    enabled: Boolean(projectId && milestoneId),
  });
}

export default useGetMilestone;
