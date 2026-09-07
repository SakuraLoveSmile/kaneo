import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { milestoneTable, projectTable } from "../../database/schema";
import { publishEvent } from "../../events";
import { resolveCompletedAt } from "../resolve-completed-at";
import type { MilestoneStatus } from "../schema";

async function createMilestone({
  projectId,
  name,
  description,
  status,
  startDate,
  targetDate,
  completedAt,
}: {
  projectId: string;
  name: string;
  description?: string | null;
  status?: string;
  startDate?: Date | null;
  targetDate?: Date | null;
  completedAt?: Date | null;
}) {
  const resolvedStatus = status ?? "planned";
  const resolvedCompletedAt = resolveCompletedAt({
    nextStatus: resolvedStatus,
    requestedCompletedAt: completedAt,
  });

  const created = await db.transaction(async (tx) => {
    const [project] = await tx
      .select({ id: projectTable.id })
      .from(projectTable)
      .where(eq(projectTable.id, projectId))
      .limit(1);

    if (!project) {
      throw new HTTPException(404, { message: "Project not found" });
    }

    const [milestone] = await tx
      .insert(milestoneTable)
      .values({
        projectId,
        name,
        description: description ?? null,
        status: resolvedStatus,
        startDate: startDate ?? null,
        targetDate: targetDate ?? null,
        completedAt: resolvedCompletedAt,
      })
      .returning();

    return milestone;
  });

  if (!created) {
    throw new HTTPException(500, { message: "Failed to create milestone" });
  }

  await publishEvent("milestone.created", {
    milestoneId: created.id,
    projectId: created.projectId,
  });

  return {
    ...created,
    status: created.status as MilestoneStatus,
  };
}

export default createMilestone;
