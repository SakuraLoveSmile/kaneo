import { asc, eq, inArray } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../database";
import { milestoneTable } from "../database/schema";

type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export function normalizeMilestoneId(value: string | null | undefined) {
  if (value === undefined) return undefined;
  if (value === null) return null;

  const normalized = value.trim();
  if (!normalized) {
    throw new HTTPException(400, {
      message: "milestoneId cannot be an empty string",
    });
  }

  return normalized;
}

export async function assertMilestoneInProject(
  milestoneId: string,
  projectId: string,
  dbOrTx: DbOrTx = db,
) {
  const [milestone] = await dbOrTx
    .select()
    .from(milestoneTable)
    .where(eq(milestoneTable.id, milestoneId))
    .limit(1);

  if (!milestone || milestone.projectId !== projectId) {
    throw new HTTPException(400, {
      message: "Milestone does not belong to this project",
    });
  }

  return milestone;
}

/**
 * Lock all milestone rows involved in a task association before locking the
 * task row. Keeping the IDs sorted gives replacements a stable lock order.
 */
export async function lockMilestonesInProject(
  dbOrTx: DbOrTx,
  milestoneIds: Array<string | null | undefined>,
  projectId: string,
) {
  const ids = [
    ...new Set(milestoneIds.filter((id): id is string => Boolean(id))),
  ].sort();
  if (ids.length === 0) return [];

  const milestones = await dbOrTx
    .select()
    .from(milestoneTable)
    .where(inArray(milestoneTable.id, ids))
    .orderBy(asc(milestoneTable.id))
    .for("key share");

  if (
    milestones.length !== ids.length ||
    milestones.some((milestone) => milestone.projectId !== projectId)
  ) {
    throw new HTTPException(400, {
      message: "Milestone does not belong to this project",
    });
  }

  return milestones;
}
