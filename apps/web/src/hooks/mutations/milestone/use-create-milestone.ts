import { useMutation, useQueryClient } from "@tanstack/react-query";
import createMilestone, {
  type CreateMilestonePayload,
} from "@/fetchers/milestone/create-milestone";

export function useCreateMilestone() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      projectId,
      payload,
    }: {
      projectId: string;
      payload: CreateMilestonePayload;
    }) => createMilestone(projectId, payload),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: ["milestones", variables.projectId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["milestone-task-options", variables.projectId],
      });
    },
  });
}

export default useCreateMilestone;
