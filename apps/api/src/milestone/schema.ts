import { z } from "../openapi";

export const MILESTONE_STATUSES = [
  "planned",
  "active",
  "completed",
  "canceled",
] as const;

export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number];

export const milestoneStatus = z.enum(MILESTONE_STATUSES);

export const projectIdParam = z.object({ projectId: z.string() });

export const milestoneParam = z.object({ id: z.string() });

const milestoneCalendarDate = z.string().openapi({
  description:
    "Calendar date in YYYY-MM-DD format (or UTC midnight YYYY-MM-DDT00:00:00.000Z).",
  example: "2026-09-06",
});
const milestoneTimestamp = z.string().openapi({
  description: "ISO-8601 timestamp representing completion instant.",
  example: "2026-09-06T12:00:00.000Z",
});
const milestoneDescription = z.string().max(20_000);
const milestoneName = z.string().trim().min(1).max(200);

export const createMilestoneBody = z.object({
  name: milestoneName,
  description: milestoneDescription.nullable().optional(),
  status: milestoneStatus.optional(),
  startDate: milestoneCalendarDate.nullable().optional(),
  targetDate: milestoneCalendarDate.nullable().optional(),
  completedAt: milestoneTimestamp.nullable().optional(),
});

export const updateMilestoneBody = z.object({
  name: milestoneName.optional(),
  description: milestoneDescription.nullable().optional(),
  status: milestoneStatus.optional(),
  startDate: milestoneCalendarDate.nullable().optional(),
  targetDate: milestoneCalendarDate.nullable().optional(),
  completedAt: milestoneTimestamp.nullable().optional(),
});
