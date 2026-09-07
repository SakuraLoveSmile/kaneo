export type MilestoneStatus = "planned" | "active" | "completed" | "canceled";

export type Milestone = {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  status: MilestoneStatus;
  startDate: string | null;
  targetDate: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MilestoneSummary = Milestone & {
  totalTasks: number;
  completedTasks: number;
  progress: number; // 0-100 integer
};
