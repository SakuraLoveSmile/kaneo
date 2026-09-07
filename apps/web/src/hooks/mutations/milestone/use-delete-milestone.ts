import { useMutation, useQueryClient } from "@tanstack/react-query";
import deleteMilestone from "@/fetchers/milestone/delete-milestone";

export function useDeleteMilestone() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id }: { id: string; projectId: string }) =>
      deleteMilestone(id),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: ["milestones", variables.projectId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["milestone", variables.projectId, variables.id],
      });
      void queryClient.invalidateQueries({
        queryKey: ["milestone-tasks", variables.projectId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["tasks", variables.projectId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["task"],
      });
      void queryClient.invalidateQueries({
        queryKey: ["milestone-task-options", variables.projectId],
      });
    },
  });
}

export default useDeleteMilestone;
