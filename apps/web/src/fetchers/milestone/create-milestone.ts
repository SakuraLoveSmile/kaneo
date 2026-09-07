import { client } from "@kaneo/libs";
import { HttpError } from "@/lib/http-error";
import type { Milestone, MilestoneStatus } from "@/types/milestone";

export type CreateMilestonePayload = {
  name: string;
  description?: string | null;
  status?: MilestoneStatus;
  startDate?: string | null;
  targetDate?: string | null;
  completedAt?: string | null;
};

async function createMilestone(
  projectId: string,
  payload: CreateMilestonePayload,
): Promise<Milestone> {
  const response = await client.milestone.project[":projectId"].$post({
    param: { projectId },
    json: {
      name: payload.name.trim(),
      ...(payload.description !== undefined && {
        description: payload.description,
      }),
      ...(payload.status !== undefined && { status: payload.status }),
      ...(payload.startDate !== undefined && { startDate: payload.startDate }),
      ...(payload.targetDate !== undefined && {
        targetDate: payload.targetDate,
      }),
      ...(payload.completedAt !== undefined && {
        completedAt: payload.completedAt,
      }),
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    let message = "Failed to create milestone";
    try {
      const parsed = JSON.parse(errorText);
      if (parsed.message) message = parsed.message;
    } catch {
      if (errorText) message = errorText;
    }
    throw new HttpError(response.status, message);
  }

  const data = (await response.json()) as unknown as Milestone;
  return data;
}

export default createMilestone;
