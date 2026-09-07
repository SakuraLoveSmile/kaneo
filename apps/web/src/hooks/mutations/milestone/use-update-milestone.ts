import { useMutation, useQueryClient } from "@tanstack/react-query";
import updateMilestone, {
  type UpdateMilestonePayload,
} from "@/fetchers/milestone/update-milestone";

export function useUpdateMilestone() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      id,
      payload,
    }: {
      id: string;
      projectId: string;
      payload: UpdateMilestonePayload;
    }) => updateMilestone(id, payload),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: ["milestones", variables.projectId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["milestone", variables.projectId, variables.id],
      });
    },
  });
}

export default useUpdateMilestone;
