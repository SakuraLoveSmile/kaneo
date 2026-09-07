import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { milestoneTable, taskTable } from "../../database/schema";
import { publishEvent } from "../../events";
import type { MilestoneStatus } from "../schema";

async function deleteMilestone(id: string) {
  const deleted = await db.transaction(async (tx) => {
    // Keep the same parent-then-task order as association updates. The child
    // lock also makes the SET NULL transition explicit for concurrent moves.
    const [milestone] = await tx
      .select()
      .from(milestoneTable)
      .where(eq(milestoneTable.id, id))
      .for("update");

    if (!milestone) return undefined;

    await tx
      .select({ id: taskTable.id })
      .from(taskTable)
      .where(eq(taskTable.milestoneId, id))
      .for("update");

    const [removed] = await tx
      .delete(milestoneTable)
      .where(eq(milestoneTable.id, id))
      .returning();

    return removed;
  });

  if (!deleted) {
    throw new HTTPException(404, { message: "Milestone not found" });
  }

  await publishEvent("milestone.deleted", {
    milestoneId: deleted.id,
    projectId: deleted.projectId,
  });

  return {
    ...deleted,
    status: deleted.status as MilestoneStatus,
  };
}

export default deleteMilestone;
