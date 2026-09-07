import { describe, expect, it, vi } from "vitest";

const mockPut = vi.fn();

vi.mock("@kaneo/libs", () => ({
  client: {
    task: {
      milestone: {
        ":id": {
          $put: (...args: unknown[]) => mockPut(...args),
        },
      },
    },
  },
}));

import updateTaskMilestone from "./update-task-milestone";

describe("updateTaskMilestone", () => {
  it("calls dedicated PUT /api/task/milestone/:id with milestoneId payload", async () => {
    mockPut.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: "task-1",
        title: "Task 1",
        milestoneId: "m-123",
      }),
    });

    const result = await updateTaskMilestone("task-1", {
      milestoneId: "m-123",
    });

    expect(mockPut).toHaveBeenCalledWith({
      param: { id: "task-1" },
      json: { milestoneId: "m-123" },
    });
    expect(result).toMatchObject({ id: "task-1", milestoneId: "m-123" });
  });

  it("sends null when clearing milestone association", async () => {
    mockPut.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: "task-1",
        title: "Task 1",
        milestoneId: null,
      }),
    });

    const result = await updateTaskMilestone("task-1", {
      milestoneId: null,
    });

    expect(mockPut).toHaveBeenCalledWith({
      param: { id: "task-1" },
      json: { milestoneId: null },
    });
    expect(result).toMatchObject({ id: "task-1", milestoneId: null });
  });

  it("throws error when response is not ok", async () => {
    mockPut.mockResolvedValueOnce({
      ok: false,
      text: async () => "Forbidden",
    });

    await expect(
      updateTaskMilestone("task-1", { milestoneId: "m-1" }),
    ).rejects.toThrow("Forbidden");
  });
});
