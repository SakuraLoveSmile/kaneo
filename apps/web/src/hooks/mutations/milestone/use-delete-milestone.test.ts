import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import useDeleteMilestone from "./use-delete-milestone";

const mockInvalidateQueries = vi.fn();

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({
    invalidateQueries: mockInvalidateQueries,
  }),
  useMutation: (options: {
    onSuccess?: (
      data: unknown,
      variables: { id: string; projectId: string },
    ) => void;
  }) => {
    const mutateAsync = vi
      .fn()
      .mockImplementation(async (vars: { id: string; projectId: string }) => {
        await options.onSuccess?.({}, vars);
        return {};
      });
    return {
      mutateAsync,
      isPending: false,
    };
  },
}));

vi.mock("@/fetchers/milestone/delete-milestone", () => ({
  default: vi.fn(),
}));

describe("useDeleteMilestone", () => {
  beforeEach(() => {
    mockInvalidateQueries.mockClear();
  });

  it("invalidates all milestone and task caches including single tasks on success", async () => {
    const { result } = renderHook(() => useDeleteMilestone());

    await result.current.mutateAsync({
      id: "m-123",
      projectId: "p-456",
    });

    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ["milestones", "p-456"],
    });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ["milestone", "p-456", "m-123"],
    });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ["milestone-tasks", "p-456"],
    });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ["tasks", "p-456"],
    });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ["task"],
    });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ["milestone-task-options", "p-456"],
    });
  });
});
