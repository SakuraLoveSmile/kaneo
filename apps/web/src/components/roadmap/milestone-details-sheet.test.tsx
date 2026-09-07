import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MilestoneSummary } from "@/types/milestone";
import MilestoneDetailsSheet from "./milestone-details-sheet";

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

vi.mock("@/hooks/queries/milestone/use-get-milestone-task-options", () => ({
  useGetMilestoneTaskOptions: () => ({
    data: {
      tasks: [],
      pagination: { page: 1, limit: 50, total: 0, totalPages: 1 },
    },
    isLoading: false,
    error: null,
  }),
}));

const mockMilestone: MilestoneSummary = {
  id: "m-123",
  projectId: "p-456",
  name: "Launch v1.0",
  description: "Initial production release",
  status: "active",
  startDate: "2026-06-01",
  targetDate: "2026-06-30",
  completedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  totalTasks: 2,
  completedTasks: 1,
  progress: 50,
};

let currentMilestoneData: MilestoneSummary | null = { ...mockMilestone };
let milestonesById: Record<string, MilestoneSummary> = {};
let milestoneError: unknown = null;
let isMilestoneLoading = false;
let mockCanUpdateTasks = true;
let mockCanDeleteTasks = true;
let mockCanCreateTasks = true;

const mockMutateUpdate = vi.fn().mockResolvedValue({ ...mockMilestone });
const mockMutateDelete = vi.fn().mockResolvedValue(mockMilestone);
const mockMutateTaskMilestone = vi.fn().mockResolvedValue({});
const mockUseGetMilestoneTasks = vi.fn();

vi.mock("@/hooks/queries/milestone/use-get-milestone", () => ({
  useGetMilestone: (_projectId?: string, milestoneId?: string | null) => ({
    data:
      milestoneId && milestonesById[milestoneId]
        ? milestonesById[milestoneId]
        : currentMilestoneData,
    isLoading: isMilestoneLoading,
    error: milestoneError,
    refetch: vi.fn(),
  }),
}));

vi.mock("@/hooks/queries/milestone/use-get-milestone-tasks", () => ({
  useGetMilestoneTasks: (...args: unknown[]) =>
    mockUseGetMilestoneTasks(...args),
}));

let mockIsUpdating = false;

vi.mock("@/hooks/mutations/milestone/use-update-milestone", () => ({
  useUpdateMilestone: () => ({
    mutateAsync: mockMutateUpdate,
    isPending: mockIsUpdating,
  }),
}));

vi.mock("@/hooks/mutations/milestone/use-delete-milestone", () => ({
  useDeleteMilestone: () => ({
    mutateAsync: mockMutateDelete,
    isPending: false,
  }),
}));

vi.mock("@/hooks/mutations/task/use-update-task-milestone", () => ({
  useUpdateTaskMilestone: () => ({
    mutateAsync: mockMutateTaskMilestone,
    isPending: false,
  }),
}));

vi.mock("@/hooks/use-workspace-permission", () => ({
  useWorkspacePermission: () => ({
    canUpdateTasks: () => mockCanUpdateTasks,
    canDeleteTasks: () => mockCanDeleteTasks,
    canCreateTasks: () => mockCanCreateTasks,
  }),
}));

vi.mock("@/lib/toast", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

beforeEach(() => {
  currentMilestoneData = { ...mockMilestone };
  milestonesById = {};
  milestoneError = null;
  isMilestoneLoading = false;
  mockCanUpdateTasks = true;
  mockCanDeleteTasks = true;
  mockCanCreateTasks = true;
  mockIsUpdating = false;
  mockUseGetMilestoneTasks.mockReturnValue({
    data: {
      tasks: [
        { id: "task-1", title: "Setup Database", number: 101, status: "done" },
        { id: "task-2", title: "Setup Auth", number: 102, status: "todo" },
      ],
      pagination: {
        page: 1,
        limit: 20,
        total: 2,
        totalPages: 1,
      },
    },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  });
});

function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

describe("MilestoneDetailsSheet", () => {
  const onClose = vi.fn();
  const onSelectTask = vi.fn();
  const onCreateTask = vi.fn();

  it("renders milestone baseline data and tasks list correctly", () => {
    renderWithClient(
      <MilestoneDetailsSheet
        projectId="p-456"
        milestoneId="m-123"
        onClose={onClose}
        onSelectTask={onSelectTask}
        onCreateTask={onCreateTask}
      />,
    );

    expect(screen.getByDisplayValue("Launch v1.0")).toBeVisible();
    expect(
      screen.getByDisplayValue("Initial production release"),
    ).toBeVisible();
    expect(screen.getByText("Setup Database")).toBeVisible();
    expect(screen.getByText("Setup Auth")).toBeVisible();
    expect(screen.getByText(/\(50%\)/)).toBeVisible();
  });

  it("modifies draft and enables Save / Discard buttons only when dirty", () => {
    renderWithClient(
      <MilestoneDetailsSheet
        projectId="p-456"
        milestoneId="m-123"
        onClose={onClose}
        onSelectTask={onSelectTask}
        onCreateTask={onCreateTask}
      />,
    );

    const nameInput = screen.getByDisplayValue("Launch v1.0");

    // Initially, Save button is not active / has no changes
    const saveBtn = screen.queryByRole("button", { name: "Save changes" });
    expect(saveBtn).toBeNull();

    // Modify name
    fireEvent.change(nameInput, { target: { value: "Launch v2.0" } });

    // Now Save changes and Discard buttons appear
    expect(screen.getByRole("button", { name: "Save changes" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Discard" })).toBeVisible();

    // Reverting to original value clears dirty state
    fireEvent.change(nameInput, { target: { value: "Launch v1.0" } });
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
  });

  it("discards changes and restores baseline upon clicking Discard", () => {
    renderWithClient(
      <MilestoneDetailsSheet
        projectId="p-456"
        milestoneId="m-123"
        onClose={onClose}
        onSelectTask={onSelectTask}
        onCreateTask={onCreateTask}
      />,
    );

    const nameInput = screen.getByDisplayValue("Launch v1.0");
    fireEvent.change(nameInput, { target: { value: "Temporary Draft Name" } });

    const discardBtn = screen.getByRole("button", { name: "Discard" });
    fireEvent.click(discardBtn);

    expect(screen.getByDisplayValue("Launch v1.0")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
  });

  it("submits only modified fields in diff payload on save", async () => {
    renderWithClient(
      <MilestoneDetailsSheet
        projectId="p-456"
        milestoneId="m-123"
        onClose={onClose}
        onSelectTask={onSelectTask}
        onCreateTask={onCreateTask}
      />,
    );

    const nameInput = screen.getByDisplayValue("Launch v1.0");
    fireEvent.change(nameInput, { target: { value: "Release 1.0 Final" } });

    const saveBtn = screen.getByRole("button", { name: "Save changes" });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(mockMutateUpdate).toHaveBeenCalledTimes(1);
    });

    expect(mockMutateUpdate).toHaveBeenCalledWith({
      id: "m-123",
      projectId: "p-456",
      payload: {
        name: "Release 1.0 Final",
      },
    });
  });

  it("detects remote conflicts when another session updates a modified field", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <MilestoneDetailsSheet
          projectId="p-456"
          milestoneId="m-123"
          onClose={onClose}
          onSelectTask={onSelectTask}
          onCreateTask={onCreateTask}
        />
      </QueryClientProvider>,
    );

    const descInput = screen.getByDisplayValue("Initial production release");
    fireEvent.change(descInput, { target: { value: "My local edit" } });

    // Simulate server push / refetch with different remote description
    currentMilestoneData = {
      ...mockMilestone,
      description: "Remote concurrent update from user B",
    };

    rerender(
      <QueryClientProvider client={queryClient}>
        <MilestoneDetailsSheet
          projectId="p-456"
          milestoneId="m-123"
          onClose={onClose}
          onSelectTask={onSelectTask}
          onCreateTask={onCreateTask}
        />
      </QueryClientProvider>,
    );

    // Conflict banner should be displayed
    await waitFor(() => {
      expect(screen.getByText(/Remote changes detected/i)).toBeVisible();
    });

    // Choose to adopt remote
    const adoptBtn = screen.getByRole("button", { name: /Adopt remote/i });
    fireEvent.click(adoptBtn);

    expect(
      screen.getByDisplayValue("Remote concurrent update from user B"),
    ).toBeVisible();
  });

  it("allows unlinking a task with permission check", async () => {
    renderWithClient(
      <MilestoneDetailsSheet
        projectId="p-456"
        milestoneId="m-123"
        onClose={onClose}
        onSelectTask={onSelectTask}
        onCreateTask={onCreateTask}
      />,
    );

    const unlinkBtns = screen.getAllByLabelText(/Unlink/i);
    expect(unlinkBtns.length).toBeGreaterThan(0);

    fireEvent.click(unlinkBtns[0]);

    await waitFor(() => {
      expect(mockMutateTaskMilestone).toHaveBeenCalledWith({
        projectId: "p-456",
        taskId: "task-1",
        milestoneId: null,
      });
    });
  });

  it("disables Save button when remote conflicts exist and does not send save request", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <MilestoneDetailsSheet
          projectId="p-456"
          milestoneId="m-123"
          onClose={onClose}
          onSelectTask={onSelectTask}
          onCreateTask={onCreateTask}
        />
      </QueryClientProvider>,
    );

    const descInput = screen.getByDisplayValue("Initial production release");
    fireEvent.change(descInput, { target: { value: "My draft change" } });

    // Simulate remote conflict
    currentMilestoneData = {
      ...mockMilestone,
      description: "Concurrent server change",
    };

    rerender(
      <QueryClientProvider client={queryClient}>
        <MilestoneDetailsSheet
          projectId="p-456"
          milestoneId="m-123"
          onClose={onClose}
          onSelectTask={onSelectTask}
          onCreateTask={onCreateTask}
        />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText(/Remote changes detected/i)).toBeVisible();
    });

    const saveBtn = screen.getByRole("button", { name: "Save changes" });
    expect(saveBtn).toBeDisabled();

    fireEvent.click(saveBtn);
    expect(mockMutateUpdate).not.toHaveBeenCalled();

    // After resolving conflict (e.g. keep local)
    const keepLocalBtn = screen.getByRole("button", {
      name: /Keep my edits/i,
    });
    fireEvent.click(keepLocalBtn);

    expect(saveBtn).not.toBeDisabled();
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(mockMutateUpdate).toHaveBeenCalledTimes(1);
    });
  });

  it("handles project mismatch securely by disabling edits, deletes, task linking, and tasks query", () => {
    currentMilestoneData = {
      ...mockMilestone,
      projectId: "different-project-789",
    };

    renderWithClient(
      <MilestoneDetailsSheet
        projectId="current-project-123"
        milestoneId="m-123"
        onClose={onClose}
        onSelectTask={onSelectTask}
        onCreateTask={onCreateTask}
      />,
    );

    expect(
      screen.getByText("This milestone belongs to another project."),
    ).toBeVisible();
    expect(
      screen.getByText(
        "Editing, deleting, and linking tasks are disabled for milestones from another project.",
      ),
    ).toBeVisible();

    // Delete button in header is hidden or disabled
    expect(screen.queryByTitle("Delete")).toBeNull();

    // Form inputs and task action buttons should not be present
    expect(screen.queryByRole("button", { name: "New task" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Link task" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();

    // useGetMilestoneTasks should have been called with undefined milestoneId
    expect(mockUseGetMilestoneTasks).toHaveBeenCalledWith(
      "current-project-123",
      undefined,
      1,
    );
  });

  it("separately controls New task and Link task based on create vs update permissions", () => {
    // Only create permission
    mockCanCreateTasks = true;
    mockCanUpdateTasks = false;

    const { unmount } = renderWithClient(
      <MilestoneDetailsSheet
        projectId="p-456"
        milestoneId="m-123"
        onClose={onClose}
        onSelectTask={onSelectTask}
        onCreateTask={onCreateTask}
      />,
    );

    expect(screen.getByRole("button", { name: /New task/i })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Link task/i })).toBeNull();

    unmount();

    // Only update permission
    mockCanCreateTasks = false;
    mockCanUpdateTasks = true;

    renderWithClient(
      <MilestoneDetailsSheet
        projectId="p-456"
        milestoneId="m-123"
        onClose={onClose}
        onSelectTask={onSelectTask}
        onCreateTask={onCreateTask}
      />,
    );

    expect(screen.queryByRole("button", { name: /New task/i })).toBeNull();
    expect(screen.getByRole("button", { name: /Link task/i })).toBeVisible();
  });

  it("does not overwrite draft of newly opened milestone when a previous save completes late (A save -> switch B -> A returns)", async () => {
    const milestoneA: MilestoneSummary = {
      ...mockMilestone,
      id: "m-123",
      name: "Milestone A Original",
    };
    const milestoneB: MilestoneSummary = {
      ...mockMilestone,
      id: "m-456",
      name: "Milestone B Original",
    };
    milestonesById["m-123"] = milestoneA;
    milestonesById["m-456"] = milestoneB;

    let resolveSaveA!: (value: MilestoneSummary) => void;
    const saveAPromise = new Promise<MilestoneSummary>((resolve) => {
      resolveSaveA = resolve;
    });

    mockMutateUpdate.mockImplementation(({ id }: { id: string }) => {
      if (id === "m-123") {
        return saveAPromise;
      }
      return Promise.resolve({ ...mockMilestone, id });
    });

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const { rerender } = render(
      <QueryClientProvider client={client}>
        <MilestoneDetailsSheet
          projectId="p-456"
          milestoneId="m-123"
          onClose={onClose}
          onSelectTask={onSelectTask}
          onCreateTask={onCreateTask}
        />
      </QueryClientProvider>,
    );

    // Edit Milestone A
    const nameInputA = screen.getByDisplayValue("Milestone A Original");
    fireEvent.change(nameInputA, { target: { value: "Milestone A Modified" } });

    // Click Save changes on Milestone A -> mutation is pending
    const saveBtn = screen.getByRole("button", { name: "Save changes" });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(mockMutateUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ id: "m-123" }),
      );
    });

    // Switch to Milestone B before Save A resolves
    rerender(
      <QueryClientProvider client={client}>
        <MilestoneDetailsSheet
          projectId="p-456"
          milestoneId="m-456"
          onClose={onClose}
          onSelectTask={onSelectTask}
          onCreateTask={onCreateTask}
        />
      </QueryClientProvider>,
    );

    // Verify Milestone B is loaded
    expect(screen.getByDisplayValue("Milestone B Original")).toBeVisible();

    // Now resolve Save A's response
    resolveSaveA({
      ...milestoneA,
      name: "Milestone A Saved On Server",
    });

    // Wait a tick for any async side effects to settle
    await new Promise((r) => setTimeout(r, 50));

    // Milestone B's draft should NOT be corrupted by Milestone A's returned data
    expect(screen.getByDisplayValue("Milestone B Original")).toBeVisible();
    expect(
      screen.queryByDisplayValue("Milestone A Saved On Server"),
    ).toBeNull();
    expect(screen.queryByDisplayValue("Milestone A Modified")).toBeNull();
  });

  it("prevents closing the sheet while save is in-flight", () => {
    mockIsUpdating = true;

    renderWithClient(
      <MilestoneDetailsSheet
        projectId="p-456"
        milestoneId="m-123"
        onClose={onClose}
        onSelectTask={onSelectTask}
        onCreateTask={onCreateTask}
      />,
    );

    // Attempt to close by finding the Sheet close button
    const closeBtn = screen.getByRole("button", { name: /close/i });
    fireEvent.click(closeBtn);

    // onClose should not be called while save is pending
    expect(onClose).not.toHaveBeenCalled();
  });
});
