import { and, asc, eq, sql } from "drizzle-orm";
import db from "../../database";
import { columnTable, milestoneTable, taskTable } from "../../database/schema";
import type { MilestoneStatus } from "../schema";

const totalTasksExpression = sql<number>`count(distinct ${taskTable.id})`;
const completedTasksExpression = sql<number>`count(distinct ${taskTable.id}) filter (
  where ${taskTable.status} = 'archived' or ${columnTable.isFinal} = true
)`;

function toMilestoneSummary(row: {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  status: string;
  startDate: Date | null;
  targetDate: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  totalTasks: number | string;
  completedTasks: number | string;
}) {
  const totalTasks = Number(row.totalTasks);
  const completedTasks = Number(row.completedTasks);

  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    description: row.description,
    status: row.status as MilestoneStatus,
    startDate: row.startDate,
    targetDate: row.targetDate,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    totalTasks,
    completedTasks,
    progress:
      totalTasks === 0 ? 0 : Math.round((completedTasks / totalTasks) * 100),
  };
}

async function getMilestoneSummaries({
  projectId,
  milestoneId,
}: {
  projectId?: string;
  milestoneId?: string;
} = {}) {
  const filters = [];
  if (projectId) filters.push(eq(milestoneTable.projectId, projectId));
  if (milestoneId) filters.push(eq(milestoneTable.id, milestoneId));

  const rows = await db
    .select({
      id: milestoneTable.id,
      projectId: milestoneTable.projectId,
      name: milestoneTable.name,
      description: milestoneTable.description,
      status: milestoneTable.status,
      startDate: milestoneTable.startDate,
      targetDate: milestoneTable.targetDate,
      completedAt: milestoneTable.completedAt,
      createdAt: milestoneTable.createdAt,
      updatedAt: milestoneTable.updatedAt,
      totalTasks: totalTasksExpression,
      completedTasks: completedTasksExpression,
    })
    .from(milestoneTable)
    .leftJoin(taskTable, eq(taskTable.milestoneId, milestoneTable.id))
    .leftJoin(
      columnTable,
      and(
        eq(columnTable.projectId, milestoneTable.projectId),
        eq(columnTable.slug, taskTable.status),
      ),
    )
    .where(filters.length > 0 ? and(...filters) : undefined)
    .groupBy(
      milestoneTable.id,
      milestoneTable.projectId,
      milestoneTable.name,
      milestoneTable.description,
      milestoneTable.status,
      milestoneTable.startDate,
      milestoneTable.targetDate,
      milestoneTable.completedAt,
      milestoneTable.createdAt,
      milestoneTable.updatedAt,
    )
    .orderBy(asc(milestoneTable.createdAt), asc(milestoneTable.id));

  return rows.map(toMilestoneSummary);
}

export async function getMilestoneSummary(id: string) {
  const [summary] = await getMilestoneSummaries({ milestoneId: id });
  return summary;
}

export default getMilestoneSummaries;
