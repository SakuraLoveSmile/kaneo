import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MilestoneSummary } from "@/types/milestone";
import type Task from "@/types/task";
import TaskMilestonePopover from "./task-milestone-popover";

const useGetMilestones = vi.fn();
const mutateAsync = vi.fn();
const canUpdateTasks = vi.fn();

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, opts?: { defaultValue?: string }) =>
        opts?.defaultValue ?? key,
    }),
  };
});

vi.mock("@/hooks/queries/milestone/use-get-milestones", () => ({
  useGetMilestones: (projectId: string) => useGetMilestones(projectId),
}));

vi.mock("@/hooks/mutations/task/use-update-task-milestone", () => ({
  useUpdateTaskMilestone: () => ({ mutateAsync }),
}));

vi.mock("@/hooks/use-workspace-permission", () => ({
  useWorkspacePermission: () => ({ canUpdateTasks }),
}));

vi.mock("@/lib/toast", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

const mockMilestones: MilestoneSummary[] = [
  {
    id: "m-1",
    projectId: "project-1",
    name: "v1.0 Launch",
    description: null,
    status: "active",
    startDate: null,
    targetDate: "2026-06-01T00:00:00.000Z",
    completedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    totalTasks: 5,
    completedTasks: 2,
    progress: 40,
  },
  {
    id: "m-2",
    projectId: "project-1",
    name: "v2.0 Beta",
    description: null,
    status: "planned",
    startDate: null,
    targetDate: null,
    completedAt: null,
    createdAt: "2026-01-02T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    totalTasks: 0,
    completedTasks: 0,
    progress: 0,
  },
];

const mockTask: Task = {
  id: "task-1",
  title: "Implement feature",
  number: 42,
  description: null,
  status: "in-progress",
  priority: "high",
  startDate: null,
  dueDate: null,
  position: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  userId: null,
  assigneeId: null,
  assigneeName: null,
  projectId: "project-1",
  milestoneId: null,
};

describe("TaskMilestonePopover", () => {
  it("renders trigger button with 'No milestone' placeholder when unlinked", () => {
    canUpdateTasks.mockReturnValue(true);
    useGetMilestones.mockReturnValue({
      data: mockMilestones,
      isLoading: false,
      isError: false,
    });

    render(<TaskMilestonePopover task={mockTask} projectId="project-1" />);

    expect(screen.getByText("No milestone")).toBeVisible();
  });

  it("renders trigger button with milestone name when linked", () => {
    canUpdateTasks.mockReturnValue(true);
    useGetMilestones.mockReturnValue({
      data: mockMilestones,
      isLoading: false,
      isError: false,
    });

    const linkedTask: Task = {
      ...mockTask,
      milestoneId: "m-1",
    };

    render(<TaskMilestonePopover task={linkedTask} projectId="project-1" />);

    expect(screen.getByText("v1.0 Launch")).toBeVisible();
  });

  it("disables trigger when user lacks update permissions", () => {
    canUpdateTasks.mockReturnValue(false);
    useGetMilestones.mockReturnValue({
      data: mockMilestones,
      isLoading: false,
      isError: false,
    });

    render(<TaskMilestonePopover task={mockTask} projectId="project-1" />);

    const button = screen.getByRole("button");
    expect(button).toBeDisabled();
  });

  it("opens popover, lists milestones, and triggers mutation when a milestone is selected", async () => {
    canUpdateTasks.mockReturnValue(true);
    mutateAsync.mockResolvedValue({});
    useGetMilestones.mockReturnValue({
      data: mockMilestones,
      isLoading: false,
      isError: false,
    });

    render(<TaskMilestonePopover task={mockTask} projectId="project-1" />);

    fireEvent.click(screen.getByRole("button"));

    // Check popover content
    expect(await screen.findByText("Select Milestone")).toBeVisible();
    expect(screen.getByText("v1.0 Launch")).toBeVisible();
    expect(screen.getByText("v2.0 Beta")).toBeVisible();

    // Click on v1.0 Launch
    fireEvent.click(screen.getByText("v1.0 Launch"));

    await waitFor(() => {
      expect(mutateAsync).toHaveBeenCalledWith({
        taskId: "task-1",
        milestoneId: "m-1",
        projectId: "project-1",
      });
    });
  });

  it("allows clearing milestone by clicking 'No milestone'", async () => {
    canUpdateTasks.mockReturnValue(true);
    mutateAsync.mockResolvedValue({});
    useGetMilestones.mockReturnValue({
      data: mockMilestones,
      isLoading: false,
      isError: false,
    });

    const linkedTask: Task = {
      ...mockTask,
      milestoneId: "m-1",
    };

    render(<TaskMilestonePopover task={linkedTask} projectId="project-1" />);

    fireEvent.click(screen.getByRole("button"));

    expect(await screen.findByText("No milestone")).toBeVisible();
    fireEvent.click(screen.getByText("No milestone"));

    await waitFor(() => {
      expect(mutateAsync).toHaveBeenCalledWith({
        taskId: "task-1",
        milestoneId: null,
        projectId: "project-1",
      });
    });
  });
});
