import { useQuery } from "@tanstack/react-query";
import getMilestones from "@/fetchers/milestone/get-milestones";
import type { MilestoneSummary } from "@/types/milestone";

export function useGetMilestones(projectId: string | undefined) {
  return useQuery<MilestoneSummary[]>({
    queryKey: ["milestones", projectId],
    queryFn: () => getMilestones(projectId as string),
    enabled: Boolean(projectId),
  });
}

export default useGetMilestones;
