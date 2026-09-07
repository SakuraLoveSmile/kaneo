import { keepPreviousData, useQuery } from "@tanstack/react-query";
import getMilestoneTaskOptions, {
  type MilestoneTaskOptionsResponse,
} from "@/fetchers/milestone/get-milestone-task-options";

export function useGetMilestoneTaskOptions(
  projectId: string | undefined,
  page = 1,
  search?: string,
) {
  const normalizedSearch = search?.trim() || "";

  return useQuery<MilestoneTaskOptionsResponse>({
    queryKey: ["milestone-task-options", projectId, normalizedSearch, page],
    queryFn: () =>
      getMilestoneTaskOptions({
        projectId: projectId as string,
        page,
        limit: 50,
        search: normalizedSearch,
      }),
    enabled: Boolean(projectId),
    placeholderData: keepPreviousData,
  });
}

export default useGetMilestoneTaskOptions;
