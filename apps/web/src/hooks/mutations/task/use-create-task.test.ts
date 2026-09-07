import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import useCreateTask from "./use-create-task";

const mockInvalidateQueries = vi.fn();

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({
    invalidateQueries: mockInvalidateQueries,
  }),
  useMutation: (options: {
    onSuccess?: (data: unknown, variables: Record<string, unknown>) => void;
  }) => {
    const mutateAsync = vi
      .fn()
      .mockImplementation(async (vars: Record<string, unknown>) => {
        await options.onSuccess?.({}, vars);
        return {};
      });
    return {
      mutateAsync,
      isPending: false,
    };
  },
}));

vi.mock("@/fetchers/task/create-task", () => ({
  default: vi.fn(),
}));

describe("useCreateTask", () => {
  beforeEach(() => {
    mockInvalidateQueries.mockClear();
  });

  it("unconditionally invalidates milestone-task-options even when no milestoneId is provided", async () => {
    const { result } = renderHook(() => useCreateTask());

    await result.current.mutateAsync({
      title: "New Task",
      description: "",
      priority: "low",
      status: "backlog",
      projectId: "p-123",
      userId: "u-1",
    });

    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ["tasks", "p-123"],
    });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ["milestone-task-options", "p-123"],
    });
    expect(mockInvalidateQueries).not.toHaveBeenCalledWith({
      queryKey: ["milestones", "p-123"],
    });
  });

  it("invalidates milestone queries when milestoneId is provided", async () => {
    const { result } = renderHook(() => useCreateTask());

    await result.current.mutateAsync({
      title: "New Task with Milestone",
      description: "",
      priority: "low",
      status: "backlog",
      projectId: "p-123",
      userId: "u-1",
      milestoneId: "m-456",
    });

    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ["tasks", "p-123"],
    });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ["milestone-task-options", "p-123"],
    });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ["milestones", "p-123"],
    });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ["milestone", "p-123", "m-456"],
    });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ["milestone-tasks", "p-123"],
    });
  });
});
