import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MilestoneSummary } from "@/types/milestone";
import RoadmapTimeline from "./roadmap-timeline";

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

vi.mock("@/store/user-preferences", () => ({
  useUserPreferencesStore: (
    selector?: (state: { weekStartsOn: number }) => unknown,
  ) => {
    const state = { weekStartsOn: 1 };
    return selector ? selector(state) : state;
  },
}));

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

const mockMilestones: MilestoneSummary[] = [
  {
    id: "m-1",
    projectId: "p-1",
    name: "Alpha Release",
    description: "First milestone",
    status: "active",
    startDate: "2026-06-01",
    targetDate: "2026-06-20",
    completedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    totalTasks: 10,
    completedTasks: 5,
    progress: 50,
  },
  {
    id: "m-2",
    projectId: "p-1",
    name: "Unscheduled Item",
    description: "No dates set",
    status: "planned",
    startDate: null,
    targetDate: null,
    completedAt: null,
    createdAt: "2026-01-02T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    totalTasks: 2,
    completedTasks: 0,
    progress: 0,
  },
  {
    id: "m-3",
    projectId: "p-1",
    name: "Future Target Only",
    description: "Outside current period",
    status: "planned",
    startDate: null,
    targetDate: "2026-12-31",
    completedAt: null,
    createdAt: "2026-01-03T00:00:00.000Z",
    updatedAt: "2026-01-03T00:00:00.000Z",
    totalTasks: 0,
    completedTasks: 0,
    progress: 0,
  },
];

describe("RoadmapTimeline", () => {
  const currentDate = new Date("2026-06-15T00:00:00.000Z");

  it("renders the 2D scrolling layout with sticky header and milestone names", () => {
    const onSelect = vi.fn();
    const onNavigate = vi.fn();

    const { container } = render(
      <RoadmapTimeline
        milestones={mockMilestones}
        currentDate={currentDate}
        scale="month"
        searchQuery=""
        statusFilter="all"
        onSelectMilestone={onSelect}
        onNavigateDate={onNavigate}
      />,
    );

    // Verify 2D scroll container
    const scrollContainer = container.querySelector(".overflow-auto");
    expect(scrollContainer).toBeTruthy();

    // Verify milestone names
    expect(screen.getAllByText("Alpha Release")[0]).toBeVisible();
    expect(screen.getByText("Unscheduled Item")).toBeVisible();

    // Verify sticky milestone row structure
    const stickyHeader = container.querySelector(".sticky.top-0");
    expect(stickyHeader).toBeTruthy();
  });

  it("supports date navigation via Previous, Next, and Today buttons", () => {
    const onNavigate = vi.fn();

    render(
      <RoadmapTimeline
        milestones={mockMilestones}
        currentDate={currentDate}
        scale="month"
        searchQuery=""
        statusFilter="all"
        onSelectMilestone={vi.fn()}
        onNavigateDate={onNavigate}
      />,
    );

    // Prev button
    const prevBtn = screen.getByLabelText("Previous");
    expect(prevBtn).toBeVisible();
    fireEvent.click(prevBtn);
    expect(onNavigate).toHaveBeenCalledTimes(1);

    // Next button
    const nextBtn = screen.getByLabelText("Next");
    expect(nextBtn).toBeVisible();
    fireEvent.click(nextBtn);
    expect(onNavigate).toHaveBeenCalledTimes(2);

    // Today button
    const todayBtn = screen.getByRole("button", { name: "Today" });
    expect(todayBtn).toBeVisible();
    fireEvent.click(todayBtn);
    expect(onNavigate).toHaveBeenCalledTimes(3);
  });

  it("renders quarter scale with week columns and proportional widths", () => {
    const { container } = render(
      <RoadmapTimeline
        milestones={mockMilestones}
        currentDate={currentDate}
        scale="quarter"
        searchQuery=""
        statusFilter="all"
        onSelectMilestone={vi.fn()}
        onNavigateDate={vi.fn()}
      />,
    );

    // In quarter scale, week labels W1, W2... are rendered
    expect(screen.getByText("W1")).toBeVisible();
    expect(screen.getByText("W2")).toBeVisible();

    // Check that week column styles include fractional percentage widths
    const weekHeaders = container.querySelectorAll("[style*='width']");
    expect(weekHeaders.length).toBeGreaterThan(0);
  });

  it("handles clicking milestone to select", () => {
    const onSelect = vi.fn();

    render(
      <RoadmapTimeline
        milestones={mockMilestones}
        currentDate={currentDate}
        scale="month"
        searchQuery=""
        statusFilter="all"
        onSelectMilestone={onSelect}
        onNavigateDate={vi.fn()}
      />,
    );

    fireEvent.click(screen.getAllByText("Alpha Release")[0]);
    expect(onSelect).toHaveBeenCalledWith("m-1");
  });

  it("displays unscheduled milestones section at bottom", () => {
    render(
      <RoadmapTimeline
        milestones={mockMilestones}
        currentDate={currentDate}
        scale="month"
        searchQuery=""
        statusFilter="all"
        onSelectMilestone={vi.fn()}
        onNavigateDate={vi.fn()}
      />,
    );

    expect(screen.getByText(/Unscheduled Milestones/i)).toBeVisible();
    expect(screen.getByText("Unscheduled Item")).toBeVisible();
  });

  it("renders accessible flag marker for target-only milestone in period", () => {
    const targetOnlyMilestone: MilestoneSummary = {
      id: "m-target-only",
      projectId: "p-1",
      name: "Beta Milestone",
      description: null,
      status: "active",
      startDate: null,
      targetDate: "2026-06-15",
      completedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      totalTasks: 0,
      completedTasks: 0,
      progress: 0,
    };

    render(
      <RoadmapTimeline
        milestones={[targetOnlyMilestone]}
        currentDate={currentDate}
        scale="month"
        searchQuery=""
        statusFilter="all"
        onSelectMilestone={vi.fn()}
        onNavigateDate={vi.fn()}
      />,
    );

    const flagBtn = screen.getByLabelText(/Beta Milestone due/i);
    expect(flagBtn).toBeVisible();
  });
});
