import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MilestoneSummary } from "@/types/milestone";
import RoadmapList from "./roadmap-list";

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

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

const mockMilestones: MilestoneSummary[] = [
  {
    id: "m-1",
    projectId: "p-1",
    name: "Alpha Release",
    description: "First alpha milestone",
    status: "active",
    startDate: "2026-01-01T00:00:00.000Z",
    targetDate: "2026-06-01T00:00:00.000Z",
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
    name: "Beta Launch",
    description: "Second milestone",
    status: "planned",
    startDate: null,
    targetDate: "2026-09-01T00:00:00.000Z",
    completedAt: null,
    createdAt: "2026-01-02T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    totalTasks: 4,
    completedTasks: 4,
    progress: 100,
  },
  {
    id: "m-3",
    projectId: "p-1",
    name: "General Availability",
    description: "Final milestone",
    status: "completed",
    startDate: null,
    targetDate: null,
    completedAt: "2026-10-01T00:00:00.000Z",
    createdAt: "2026-01-03T00:00:00.000Z",
    updatedAt: "2026-01-03T00:00:00.000Z",
    totalTasks: 0,
    completedTasks: 0,
    progress: 0,
  },
];

describe("RoadmapList", () => {
  it("renders milestone names, statuses, and progress correctly", () => {
    const onSelect = vi.fn();
    render(
      <RoadmapList
        milestones={mockMilestones}
        searchQuery=""
        statusFilter="all"
        onSelectMilestone={onSelect}
      />,
    );

    expect(screen.getByText("Alpha Release")).toBeVisible();
    expect(screen.getByText("Beta Launch")).toBeVisible();
    expect(screen.getByText("General Availability")).toBeVisible();

    // Progress percentages
    expect(screen.getByText("50%")).toBeVisible();
    expect(screen.getByText("100%")).toBeVisible();
    expect(screen.getByText(/5\s*\/\s*10/)).toBeVisible();
    expect(screen.getByText(/4\s*\/\s*4/)).toBeVisible();
  });

  it("filters milestones by search query", () => {
    render(
      <RoadmapList
        milestones={mockMilestones}
        searchQuery="Alpha"
        statusFilter="all"
        onSelectMilestone={vi.fn()}
      />,
    );

    expect(screen.getByText("Alpha Release")).toBeVisible();
    expect(screen.queryByText("Beta Launch")).toBeNull();
    expect(screen.queryByText("General Availability")).toBeNull();
  });

  it("filters milestones by status", () => {
    render(
      <RoadmapList
        milestones={mockMilestones}
        searchQuery=""
        statusFilter="completed"
        onSelectMilestone={vi.fn()}
      />,
    );

    expect(screen.queryByText("Alpha Release")).toBeNull();
    expect(screen.queryByText("Beta Launch")).toBeNull();
    expect(screen.getByText("General Availability")).toBeVisible();
  });

  it("calls onSelectMilestone when a milestone row is clicked", () => {
    const onSelect = vi.fn();
    render(
      <RoadmapList
        milestones={mockMilestones}
        searchQuery=""
        statusFilter="all"
        onSelectMilestone={onSelect}
      />,
    );

    fireEvent.click(screen.getByText("Alpha Release"));
    expect(onSelect).toHaveBeenCalledWith("m-1");
  });

  it("shows empty state when no milestones match filter", () => {
    render(
      <RoadmapList
        milestones={mockMilestones}
        searchQuery="nonexistent"
        statusFilter="all"
        onSelectMilestone={vi.fn()}
      />,
    );

    expect(screen.getByText("No milestones found")).toBeVisible();
  });
});
