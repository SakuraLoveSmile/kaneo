import { HTTPException } from "hono/http-exception";
import { getMilestoneSummary } from "./get-milestone-summaries";

async function getMilestone(id: string) {
  const milestone = await getMilestoneSummary(id);

  if (!milestone) {
    throw new HTTPException(404, { message: "Milestone not found" });
  }

  return milestone;
}

export default getMilestone;
