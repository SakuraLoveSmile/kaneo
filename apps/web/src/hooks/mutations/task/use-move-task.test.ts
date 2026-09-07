import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMoveTask } from "./use-move-task";

const mockInvalidateQueries = vi.fn();

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({
    invalidateQueries: mockInvalidateQueries,
  }),
  useMutation: (options: {
    onSuccess?: (
      data: { sourceProjectId: string; destinationProjectId: string },
      variables: { taskId: string },
    ) => void;
  }) => {
    const mutateAsync = vi
      .fn()
      .mockImplementation(async (vars: { taskId: string }) => {
        await options.onSuccess?.(
          { sourceProjectId: "p-src", destinationProjectId: "p-dest" },
          vars,
        );
        return {};
      });
    return {
      mutateAsync,
      isPending: false,
    };
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (k: string) => k,
  }),
}));

vi.mock("@/lib/toast", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/fetchers/task/move-task", () => ({
  default: vi.fn(),
}));

describe("useMoveTask", () => {
  beforeEach(() => {
    mockInvalidateQueries.mockClear();
  });

  it("invalidates milestone and task caches for both source and destination projects", async () => {
    const { result } = renderHook(() => useMoveTask());

    await result.current.mutateAsync({
      taskId: "task-1",
      destinationProjectId: "p-dest",
    });

    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ["task", "task-1"],
    });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ["tasks", "p-src"],
    });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ["tasks", "p-dest"],
    });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ["milestones", "p-src"],
    });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ["milestone", "p-src"],
    });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ["milestone-tasks", "p-src"],
    });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ["milestone-task-options", "p-src"],
    });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ["milestone-task-options", "p-dest"],
    });
  });
});
