import { client } from "@kaneo/libs";
import type Task from "@/types/task";

type UpdateTaskMilestonePayload = {
  milestoneId: string | null;
};

async function updateTaskMilestone(
  taskId: string,
  payload: UpdateTaskMilestonePayload,
): Promise<Task> {
  // Call dedicated endpoint PUT /api/task/milestone/{id}
  // Client is typed with AppType which will include this route when Plan 2 is merged.
  // Using the typed client router path directly.
  const taskClient = client.task as unknown as {
    milestone: {
      ":id": {
        $put: (args: {
          param: { id: string };
          json: { milestoneId: string | null };
        }) => Promise<Response>;
      };
    };
  };

  const response = await taskClient.milestone[":id"].$put({
    param: { id: taskId },
    json: {
      milestoneId: payload.milestoneId,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(error);
  }

  const data = (await response.json()) as Task;
  return data;
}

export default updateTaskMilestone;
