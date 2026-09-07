import { useMutation, useQueryClient } from "@tanstack/react-query";
import updateTaskMilestone from "@/fetchers/task/update-task-milestone";

export function useUpdateTaskMilestone() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      taskId,
      milestoneId,
    }: {
      taskId: string;
      milestoneId: string | null;
      projectId?: string;
    }) => updateTaskMilestone(taskId, { milestoneId }),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: ["task", variables.taskId],
      });
      if (variables.projectId) {
        void queryClient.invalidateQueries({
          queryKey: ["tasks", variables.projectId],
        });
        void queryClient.invalidateQueries({
          queryKey: ["milestones", variables.projectId],
        });
        void queryClient.invalidateQueries({
          queryKey: ["milestone", variables.projectId],
        });
        void queryClient.invalidateQueries({
          queryKey: ["milestone-tasks", variables.projectId],
        });
        void queryClient.invalidateQueries({
          queryKey: ["milestone-task-options", variables.projectId],
        });
      } else {
        void queryClient.invalidateQueries({ queryKey: ["tasks"] });
        void queryClient.invalidateQueries({ queryKey: ["milestones"] });
        void queryClient.invalidateQueries({ queryKey: ["milestone"] });
        void queryClient.invalidateQueries({ queryKey: ["milestone-tasks"] });
        void queryClient.invalidateQueries({
          queryKey: ["milestone-task-options"],
        });
      }
    },
  });
}

export default useUpdateTaskMilestone;
