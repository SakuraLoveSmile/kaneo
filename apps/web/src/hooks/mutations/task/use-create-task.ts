import { useMutation, useQueryClient } from "@tanstack/react-query";
import createTask, {
  type CreateTaskRequest,
} from "@/fetchers/task/create-task";

function useCreateTask() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      title,
      description,
      userId,
      projectId,
      status,
      startDate,
      dueDate,
      priority,
      milestoneId,
    }: CreateTaskRequest) =>
      createTask(
        title,
        description,
        projectId,
        userId,
        status,
        startDate ? new Date(startDate) : undefined,
        dueDate ? new Date(dueDate) : undefined,
        priority,
        milestoneId,
      ),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: ["tasks", variables.projectId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["milestone-task-options", variables.projectId],
      });
      if (variables.milestoneId) {
        void queryClient.invalidateQueries({
          queryKey: ["milestones", variables.projectId],
        });
        void queryClient.invalidateQueries({
          queryKey: ["milestone", variables.projectId, variables.milestoneId],
        });
        void queryClient.invalidateQueries({
          queryKey: ["milestone-tasks", variables.projectId],
        });
      }
    },
  });
}

export default useCreateTask;
