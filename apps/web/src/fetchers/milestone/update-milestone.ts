import { client } from "@kaneo/libs";
import { HttpError } from "@/lib/http-error";
import type { Milestone, MilestoneStatus } from "@/types/milestone";

export type UpdateMilestonePayload = {
  name?: string;
  description?: string | null;
  status?: MilestoneStatus;
  startDate?: string | null;
  targetDate?: string | null;
  completedAt?: string | null;
};

async function updateMilestone(
  id: string,
  payload: UpdateMilestonePayload,
): Promise<Milestone> {
  const jsonBody: Record<string, unknown> = {};

  if (payload.name !== undefined) {
    jsonBody.name = payload.name.trim();
  }
  if (payload.description !== undefined) {
    jsonBody.description = payload.description;
  }
  if (payload.status !== undefined) {
    jsonBody.status = payload.status;
  }
  if (payload.startDate !== undefined) {
    jsonBody.startDate = payload.startDate;
  }
  if (payload.targetDate !== undefined) {
    jsonBody.targetDate = payload.targetDate;
  }
  if (payload.completedAt !== undefined) {
    jsonBody.completedAt = payload.completedAt;
  }

  const response = await client.milestone[":id"].$put({
    param: { id },
    // Cast to expected schema type since jsonBody is strictly filtered
    json: jsonBody as {
      name?: string;
      description?: string | null;
      status?: MilestoneStatus;
      startDate?: string | null;
      targetDate?: string | null;
      completedAt?: string | null;
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    let message = "Failed to update milestone";
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

export default updateMilestone;
