import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { milestoneTable } from "../../database/schema";
import { publishEvent } from "../../events";
import { validateDateRange } from "../../utils/validate-dates";
import { resolveCompletedAt } from "../resolve-completed-at";
import type { MilestoneStatus } from "../schema";

async function updateMilestone(
  id: string,
  data: {
    name?: string;
    description?: string | null;
    status?: string;
    startDate?: Date | null;
    targetDate?: Date | null;
    completedAt?: Date | null;
  },
) {
  const result = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(milestoneTable)
      .where(eq(milestoneTable.id, id))
      .for("update");

    if (!existing) {
      throw new HTTPException(404, { message: "Milestone not found" });
    }

    const nextStatus = data.status ?? existing.status;
    const resolvedStartDate =
      data.startDate !== undefined ? data.startDate : existing.startDate;
    const resolvedTargetDate =
      data.targetDate !== undefined ? data.targetDate : existing.targetDate;
    validateDateRange(resolvedStartDate, resolvedTargetDate);

    const resolvedCompletedAt = resolveCompletedAt({
      nextStatus,
      requestedCompletedAt: data.completedAt,
      previousStatus: existing.status,
      previousCompletedAt: existing.completedAt,
    });

    const updateData: {
      name?: string;
      description?: string | null;
      status?: string;
      startDate?: Date | null;
      targetDate?: Date | null;
      completedAt?: Date | null;
    } = {};

    if (data.name !== undefined) updateData.name = data.name;
    if (data.description !== undefined) {
      updateData.description = data.description;
    }
    if (data.status !== undefined) updateData.status = data.status;
    if (data.startDate !== undefined) updateData.startDate = data.startDate;
    if (data.targetDate !== undefined) {
      updateData.targetDate = data.targetDate;
    }

    const shouldWriteCompletedAt =
      data.status !== undefined ||
      data.completedAt !== undefined ||
      (nextStatus === "completed" && existing.completedAt === null);
    if (shouldWriteCompletedAt) {
      updateData.completedAt = resolvedCompletedAt;
    }

    if (Object.keys(updateData).length === 0) {
      return { milestone: existing, changed: false };
    }

    const [milestone] = await tx
      .update(milestoneTable)
      .set(updateData)
      .where(eq(milestoneTable.id, id))
      .returning();

    return { milestone, changed: true };
  });

  if (!result.milestone) {
    throw new HTTPException(500, { message: "Failed to update milestone" });
  }

  if (result.changed) {
    await publishEvent("milestone.updated", {
      milestoneId: result.milestone.id,
      projectId: result.milestone.projectId,
    });
  }

  return {
    ...result.milestone,
    status: result.milestone.status as MilestoneStatus,
  };
}

export default updateMilestone;
