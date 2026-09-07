import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LinkTaskPopover from "./link-task-popover";

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

let mockTaskData: {
  tasks: Array<{
    id: string;
    title: string;
    status: string;
    milestoneId: string | null;
  }>;
  totalPages: number;
} | null = {
  tasks: [
    { id: "t-1", title: "Implement Auth", status: "todo", milestoneId: null },
    {
      id: "t-2",
      title: "Setup Database",
      status: "done",
      milestoneId: "m-other",
    },
    {
      id: "t-3",
      title: "Deploy App",
      status: "in-progress",
      milestoneId: "m-current",
    },
  ],
  totalPages: 3,
};

let isTaskLoading = false;
let isTaskFetching = false;
let isTaskPlaceholderData = false;
let isTaskError = false;
let taskErrorObj: Error | null = null;
const mockRefetch = vi.fn();

vi.mock("@/hooks/queries/milestone/use-get-milestone-task-options", () => ({
  useGetMilestoneTaskOptions: () => ({
    data: mockTaskData,
    isLoading: isTaskLoading,
    isFetching: isTaskFetching,
    isPlaceholderData: isTaskPlaceholderData,
    isError: isTaskError,
    error: taskErrorObj,
    refetch: mockRefetch,
  }),
}));

vi.mock("@/hooks/queries/milestone/use-get-milestones", () => ({
  useGetMilestones: () => ({
    data: [
      { id: "m-current", name: "Current Sprint" },
      { id: "m-other", name: "Next Release" },
    ],
  }),
}));

const mockMutateTaskMilestone = vi.fn().mockResolvedValue({});
vi.mock("@/hooks/mutations/task/use-update-task-milestone", () => ({
  useUpdateTaskMilestone: () => ({
    mutateAsync: mockMutateTaskMilestone,
    isPending: false,
  }),
}));

let mockCanUpdate = true;
vi.mock("@/hooks/use-workspace-permission", () => ({
  useWorkspacePermission: () => ({
    canUpdateTasks: () => mockCanUpdate,
  }),
}));

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

beforeEach(() => {
  mockCanUpdate = true;
  isTaskLoading = false;
  isTaskFetching = false;
  isTaskPlaceholderData = false;
  isTaskError = false;
  taskErrorObj = null;
  mockTaskData = {
    tasks: [
      { id: "t-1", title: "Implement Auth", status: "todo", milestoneId: null },
      {
        id: "t-2",
        title: "Setup Database",
        status: "done",
        milestoneId: "m-other",
      },
      {
        id: "t-3",
        title: "Deploy App",
        status: "in-progress",
        milestoneId: "m-current",
      },
    ],
    totalPages: 3,
  };
});

function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

describe("LinkTaskPopover", () => {
  it("renders popover button and opens task list", async () => {
    renderWithClient(
      <LinkTaskPopover projectId="p-1" milestoneId="m-current" />,
    );

    const triggerBtn = screen.getByRole("button", { name: /Link task/i });
    expect(triggerBtn).toBeVisible();

    fireEvent.click(triggerBtn);

    expect(
      await screen.findByPlaceholderText("Search tasks..."),
    ).toBeInTheDocument();
    expect(screen.getByText("Implement Auth")).toBeInTheDocument();
    expect(screen.getByText("Setup Database")).toBeInTheDocument();
    expect(
      screen.getByText("Already linked to this milestone"),
    ).toBeInTheDocument();
  });

  it("links an unlinked task to current milestone", async () => {
    renderWithClient(
      <LinkTaskPopover projectId="p-1" milestoneId="m-current" />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Link task/i }));

    const linkBtn = await screen.findByRole("button", { name: "Link" });
    fireEvent.click(linkBtn);

    await waitFor(() => {
      expect(mockMutateTaskMilestone).toHaveBeenCalledWith({
        taskId: "t-1",
        milestoneId: "m-current",
        projectId: "p-1",
      });
    });
  });

  it("switches a task associated with another milestone", async () => {
    renderWithClient(
      <LinkTaskPopover projectId="p-1" milestoneId="m-current" />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Link task/i }));

    const switchBtn = await screen.findByRole("button", { name: "Switch" });
    fireEvent.click(switchBtn);

    await waitFor(() => {
      expect(mockMutateTaskMilestone).toHaveBeenCalledWith({
        taskId: "t-2",
        milestoneId: "m-current",
        projectId: "p-1",
      });
    });
  });

  it("disables operations on stale placeholder results when search changes", async () => {
    renderWithClient(
      <LinkTaskPopover projectId="p-1" milestoneId="m-current" />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Link task/i }));

    const searchInput = await screen.findByPlaceholderText("Search tasks...");
    const linkBtn = screen.getByRole("button", { name: "Link" });
    expect(linkBtn).not.toBeDisabled();

    // User types new search query (debouncing / in-flight search)
    fireEvent.change(searchInput, { target: { value: "Frontend" } });

    // Link button is now disabled because search has changed and debouncedSearch has not settled
    expect(linkBtn).toBeDisabled();

    fireEvent.click(linkBtn);
    expect(mockMutateTaskMilestone).not.toHaveBeenCalled();
  });

  it("shows error view and retry button when query fails, not 'No tasks found'", async () => {
    isTaskError = true;
    taskErrorObj = new Error("Failed to fetch task options");
    mockTaskData = null;

    renderWithClient(
      <LinkTaskPopover projectId="p-1" milestoneId="m-current" />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Link task/i }));

    expect(
      await screen.findByText("Failed to fetch task options"),
    ).toBeInTheDocument();
    expect(screen.queryByText("No tasks found")).toBeNull();

    const retryBtn = screen.getByRole("button", { name: /Retry/i });
    expect(retryBtn).toBeInTheDocument();

    fireEvent.click(retryBtn);
    expect(mockRefetch).toHaveBeenCalledTimes(1);
  });

  it("enforces maxLength=200 on search input", async () => {
    renderWithClient(
      <LinkTaskPopover projectId="p-1" milestoneId="m-current" />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Link task/i }));

    const searchInput = (await screen.findByPlaceholderText(
      "Search tasks...",
    )) as HTMLInputElement;
    expect(searchInput.maxLength).toBe(200);

    const longText = "a".repeat(250);
    fireEvent.change(searchInput, { target: { value: longText } });

    expect(searchInput.value.length).toBe(200);
  });

  it("disables Link buttons and pagination buttons during pagination fetching", async () => {
    isTaskFetching = true;
    isTaskPlaceholderData = true;

    renderWithClient(
      <LinkTaskPopover projectId="p-1" milestoneId="m-current" />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Link task/i }));

    const linkBtn = await screen.findByRole("button", { name: "Link" });
    expect(linkBtn).toBeDisabled();

    const prevBtn = screen.getByRole("button", { name: "Previous" });
    const nextBtn = screen.getByRole("button", { name: "Next" });
    expect(prevBtn).toBeDisabled();
    expect(nextBtn).toBeDisabled();
  });
});
