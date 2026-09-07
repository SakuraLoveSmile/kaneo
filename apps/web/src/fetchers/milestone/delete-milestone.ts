import { client } from "@kaneo/libs";
import { HttpError } from "@/lib/http-error";
import type { Milestone } from "@/types/milestone";

async function deleteMilestone(id: string): Promise<Milestone> {
  const response = await client.milestone[":id"].$delete({
    param: { id },
  });

  if (!response.ok) {
    const errorText = await response.text();
    let message = "Failed to delete milestone";
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

export default deleteMilestone;
