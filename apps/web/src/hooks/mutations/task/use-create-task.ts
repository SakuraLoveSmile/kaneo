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
      customFields,
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
        customFields,
      ),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: ["tasks", variables.projectId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["milestone-task-options", variables.projectId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["custom-field-values", variables.projectId],
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
