import { nullableResponseTimestamp, responseTimestamp, z } from "../openapi";
import { milestoneStatus } from "./schema";

export const milestoneSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    status: milestoneStatus.openapi({
      description: "One of: planned, active, completed, canceled.",
    }),
    startDate: nullableResponseTimestamp,
    targetDate: nullableResponseTimestamp,
    completedAt: nullableResponseTimestamp,
    createdAt: responseTimestamp,
    updatedAt: responseTimestamp,
  })
  .openapi("Milestone");

export const milestoneSummarySchema = milestoneSchema
  .extend({
    totalTasks: z.number().int().nonnegative(),
    completedTasks: z.number().int().nonnegative(),
    progress: z.number().int().min(0).max(100),
  })
  .openapi("MilestoneSummary");

export const milestoneListSchema = z.array(milestoneSummarySchema);
