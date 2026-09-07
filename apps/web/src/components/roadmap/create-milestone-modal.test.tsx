import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CreateMilestoneModal from "./create-milestone-modal";

let mockLocale: "en" | "zh" = "zh";

const TRANSLATIONS: Record<"en" | "zh", Record<string, string>> = {
  zh: {
    "roadmap:createMilestone": "新建里程碑",
    "roadmap:createMilestoneDesc": "规划项目重大目标、交付物和时间周期。",
    "roadmap:fields.name": "名称",
    "roadmap:fields.namePlaceholder": "例如：v1.0 发布",
    "roadmap:fields.description": "描述",
    "roadmap:fields.descriptionPlaceholder": "简要说明这个阶段需要完成什么",
    "roadmap:fields.status": "状态",
    "roadmap:fields.startDate": "开始日期",
    "roadmap:fields.targetDate": "目标日期",
    "roadmap:fields.pickDate": "选择日期",
    "roadmap:fields.clearDate": "清除",
    "roadmap:fields.optional": "（可选）",
    "roadmap:status.planned": "计划中",
    "roadmap:status.active": "进行中",
    "roadmap:status.completed": "已完成",
    "roadmap:status.canceled": "已取消",
    "roadmap:form.nameRequired": "请输入里程碑名称",
    "roadmap:form.invalidDateRange": "开始日期必须早于或等于目标日期",
    "roadmap:form.invalidDescriptionLength": "描述不能超过 20,000 个字符",
    "roadmap:form.createButton": "创建里程碑",
    "roadmap:form.creatingButton": "创建中…",
    "roadmap:form.createSuccess": "里程碑创建成功",
    "common:actions.cancel": "取消",
  },
  en: {
    "roadmap:createMilestone": "Create milestone",
    "roadmap:createMilestoneDesc":
      "Plan major project goals, deliverables, and timelines.",
    "roadmap:fields.name": "Name",
    "roadmap:fields.namePlaceholder": "e.g., v1.0 Launch, Beta Release",
    "roadmap:fields.description": "Description",
    "roadmap:fields.descriptionPlaceholder":
      "Briefly describe what this milestone will achieve...",
    "roadmap:fields.status": "Status",
    "roadmap:fields.startDate": "Start date",
    "roadmap:fields.targetDate": "Target date",
    "roadmap:fields.pickDate": "Pick date",
    "roadmap:fields.clearDate": "Clear",
    "roadmap:fields.optional": "(optional)",
    "roadmap:status.planned": "Planned",
    "roadmap:status.active": "In Progress",
    "roadmap:status.completed": "Completed",
    "roadmap:status.canceled": "Canceled",
    "roadmap:form.nameRequired": "Name is required",
    "roadmap:form.invalidDateRange":
      "Start date must be on or before target date",
    "roadmap:form.invalidDescriptionLength":
      "Description must be 20,000 characters or less",
    "roadmap:form.createButton": "Create milestone",
    "roadmap:form.creatingButton": "Creating...",
    "roadmap:form.createSuccess": "Milestone created successfully",
    "common:actions.cancel": "Cancel",
  },
};

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, opts?: { defaultValue?: string }) =>
        TRANSLATIONS[mockLocale][key] ?? opts?.defaultValue ?? key,
    }),
  };
});

const mockMutateAsync = vi.fn();
let mockIsPending = false;

vi.mock("@/hooks/mutations/milestone/use-create-milestone", () => ({
  useCreateMilestone: () => ({
    mutateAsync: mockMutateAsync,
    isPending: mockIsPending,
  }),
}));

const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();

vi.mock("@/lib/toast", () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: (...args: unknown[]) => mockToastError(...args),
  },
}));

vi.mock("@/components/ui/calendar", () => ({
  Calendar: ({
    selected: _selected,
    onSelect,
    disabled,
  }: {
    selected?: Date;
    onSelect?: (date?: Date) => void;
    disabled?: (date: Date) => boolean;
  }) => (
    <div data-testid="mock-calendar">
      <button
        type="button"
        data-testid="mock-day-20"
        data-disabled={disabled ? disabled(new Date(2026, 8, 20)) : false}
        onClick={() => onSelect?.(new Date(2026, 8, 20))}
      >
        Day 20
      </button>
      <button
        type="button"
        data-testid="mock-day-10"
        data-disabled={disabled ? disabled(new Date(2026, 8, 10)) : false}
        onClick={() => onSelect?.(new Date(2026, 8, 10))}
      >
        Day 10
      </button>
      <button
        type="button"
        data-testid="mock-day-25"
        data-disabled={disabled ? disabled(new Date(2026, 8, 25)) : false}
        onClick={() => onSelect?.(new Date(2026, 8, 25))}
      >
        Day 25
      </button>
    </div>
  ),
}));

describe("CreateMilestoneModal Component", () => {
  const mockOnClose = vi.fn();
  const mockOnSuccess = vi.fn();

  beforeEach(() => {
    mockLocale = "zh";
    mockIsPending = false;
    mockMutateAsync.mockReset();
    mockMutateAsync.mockResolvedValue({ id: "milestone-new-123" });
    mockToastSuccess.mockReset();
    mockToastError.mockReset();
    mockOnClose.mockReset();
    mockOnSuccess.mockReset();
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("renders modal with Chinese translations and no leaked English enums/buttons", () => {
    mockLocale = "zh";
    render(
      <CreateMilestoneModal
        open={true}
        projectId="proj-1"
        onClose={mockOnClose}
        onSuccess={mockOnSuccess}
      />,
    );

    // Title & Description
    expect(
      screen.getByRole("heading", { name: "新建里程碑" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("规划项目重大目标、交付物和时间周期。"),
    ).toBeInTheDocument();

    // Default status display should be "计划中"
    expect(screen.getByText("计划中")).toBeInTheDocument();

    // Buttons
    expect(screen.getByRole("button", { name: "取消" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "创建里程碑" }),
    ).toBeInTheDocument();

    // In Chinese mode, raw English words "planned", standalone "Cancel" or "Create" must not appear
    expect(screen.queryByText(/^planned$/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^Cancel$/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^Create$/i }),
    ).not.toBeInTheDocument();
  });

  it("renders modal with English translations when locale is en", () => {
    mockLocale = "en";
    render(
      <CreateMilestoneModal
        open={true}
        projectId="proj-1"
        onClose={mockOnClose}
        onSuccess={mockOnSuccess}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Create milestone" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Planned")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Create milestone" }),
    ).toBeInTheDocument();
  });

  it("validates required name and shows in-place error with aria attributes", async () => {
    mockLocale = "zh";
    render(
      <CreateMilestoneModal
        open={true}
        projectId="proj-1"
        onClose={mockOnClose}
        onSuccess={mockOnSuccess}
      />,
    );

    const submitBtn = screen.getByRole("button", { name: "创建里程碑" });
    fireEvent.click(submitBtn);

    const nameError = screen.getByText("请输入里程碑名称");
    expect(nameError).toBeInTheDocument();
    expect(nameError).toHaveAttribute("role", "alert");

    const nameInput = screen.getByPlaceholderText("例如：v1.0 发布");
    expect(nameInput).toHaveAttribute("aria-invalid", "true");
    expect(nameInput).toHaveAttribute(
      "aria-describedby",
      "milestone-name-error",
    );

    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it("clears name error when user types into the input", () => {
    mockLocale = "zh";
    render(
      <CreateMilestoneModal
        open={true}
        projectId="proj-1"
        onClose={mockOnClose}
        onSuccess={mockOnSuccess}
      />,
    );

    const submitBtn = screen.getByRole("button", { name: "创建里程碑" });
    fireEvent.click(submitBtn);
    expect(screen.getByText("请输入里程碑名称")).toBeInTheDocument();

    const nameInput = screen.getByPlaceholderText("例如：v1.0 发布");
    fireEvent.change(nameInput, { target: { value: "Sprint 42" } });

    expect(screen.queryByText("请输入里程碑名称")).not.toBeInTheDocument();
  });

  it("validates description length exceeding 20,000 characters", () => {
    mockLocale = "zh";
    render(
      <CreateMilestoneModal
        open={true}
        projectId="proj-1"
        onClose={mockOnClose}
        onSuccess={mockOnSuccess}
      />,
    );

    const nameInput = screen.getByPlaceholderText("例如：v1.0 发布");
    fireEvent.change(nameInput, { target: { value: "Valid Name" } });

    const descInput = screen.getByPlaceholderText(
      "简要说明这个阶段需要完成什么",
    );
    const oversizedText = "x".repeat(20001);
    fireEvent.change(descInput, { target: { value: oversizedText } });

    const submitBtn = screen.getByRole("button", { name: "创建里程碑" });
    fireEvent.click(submitBtn);

    expect(screen.getByText("描述不能超过 20,000 个字符")).toBeInTheDocument();
    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it("validates date range when start date is after target date", async () => {
    mockLocale = "zh";
    render(
      <CreateMilestoneModal
        open={true}
        projectId="proj-1"
        onClose={mockOnClose}
        onSuccess={mockOnSuccess}
      />,
    );

    const nameInput = screen.getByPlaceholderText("例如：v1.0 发布");
    fireEvent.change(nameInput, { target: { value: "Valid Milestone" } });

    // Open start date picker and pick day 20 (Sep 20, 2026)
    const dateButtons = screen.getAllByRole("button", { name: /选择日期/ });
    expect(dateButtons).toHaveLength(2);

    fireEvent.click(dateButtons[0]);
    const startDay20 = await screen.findByTestId("mock-day-20");
    fireEvent.click(startDay20);

    // Pick target date (now the only button with "选择日期") and pick day 10 (Sep 10, 2026)
    await waitFor(() => {
      expect(
        screen.queryAllByRole("button", { name: /选择日期/ }),
      ).toHaveLength(1);
    });
    const targetDateBtn = screen.getByRole("button", { name: /选择日期/ });
    fireEvent.click(targetDateBtn);
    const targetDay10 = await screen.findByTestId("mock-day-10");

    // Verify disabled attribute is applied because day 10 is before start date (day 20)
    expect(targetDay10).toHaveAttribute("data-disabled", "true");

    // Click day 10 to trigger date range mismatch in form
    fireEvent.click(targetDay10);

    // Submit form
    const submitBtn = screen.getByRole("button", { name: "创建里程碑" });
    fireEvent.click(submitBtn);

    expect(
      screen.getByText("开始日期必须早于或等于目标日期"),
    ).toBeInTheDocument();
    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it("supports picking dates, clearing dates, and submits formatted ISO dates", async () => {
    mockLocale = "zh";
    render(
      <CreateMilestoneModal
        open={true}
        projectId="proj-1"
        onClose={mockOnClose}
        onSuccess={mockOnSuccess}
      />,
    );

    const nameInput = screen.getByPlaceholderText("例如：v1.0 发布");
    fireEvent.change(nameInput, { target: { value: "Scheduled Milestone" } });

    // 1. Pick start date (Day 10)
    let dateButtons = screen.getAllByRole("button", { name: /选择日期/ });
    fireEvent.click(dateButtons[0]);
    fireEvent.click(await screen.findByTestId("mock-day-10"));

    // 2. Pick target date (Day 25)
    await waitFor(() => {
      expect(
        screen.queryAllByRole("button", { name: /选择日期/ }),
      ).toHaveLength(1);
    });
    dateButtons = screen.getAllByRole("button", { name: /选择日期/ });
    fireEvent.click(dateButtons[0]);
    fireEvent.click(await screen.findByTestId("mock-day-25"));

    // Both dates are picked, so neither button says "选择日期"
    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: /选择日期/ }),
      ).not.toBeInTheDocument();
    });

    // 3. Clear start date
    // Click start date trigger to open its popover containing Clear button
    const startDateTrigger = screen.getByRole("button", {
      name: /Sep 10, 2026/,
    });
    fireEvent.click(startDateTrigger);
    const clearBtn = await screen.findByRole("button", { name: "清除" });
    fireEvent.click(clearBtn);

    // Start date button displays "选择日期" again
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /选择日期/ }),
      ).toBeInTheDocument();
    });

    // 4. Re-pick start date (Day 20) directly from the open calendar
    fireEvent.click(await screen.findByTestId("mock-day-20"));

    // 5. Submit form
    const submitBtn = screen.getByRole("button", { name: "创建里程碑" });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledTimes(1);
    });

    expect(mockMutateAsync).toHaveBeenCalledWith({
      projectId: "proj-1",
      payload: {
        name: "Scheduled Milestone",
        description: null,
        status: "planned",
        startDate: "2026-09-20",
        targetDate: "2026-09-25",
      },
    });

    expect(mockToastSuccess).toHaveBeenCalledWith("里程碑创建成功");
    expect(mockOnSuccess).toHaveBeenCalledWith("milestone-new-123");
    expect(mockOnClose).toHaveBeenCalledTimes(1);
  });

  it("successfully creates milestone with correct payload and calls onSuccess", async () => {
    mockLocale = "zh";
    render(
      <CreateMilestoneModal
        open={true}
        projectId="proj-1"
        onClose={mockOnClose}
        onSuccess={mockOnSuccess}
      />,
    );

    const nameInput = screen.getByPlaceholderText("例如：v1.0 发布");
    fireEvent.change(nameInput, { target: { value: "  Release v2.0  " } });

    const descInput = screen.getByPlaceholderText(
      "简要说明这个阶段需要完成什么",
    );
    fireEvent.change(descInput, {
      target: { value: "  Milestone goal details  " },
    });

    const submitBtn = screen.getByRole("button", { name: "创建里程碑" });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledTimes(1);
    });

    expect(mockMutateAsync).toHaveBeenCalledWith({
      projectId: "proj-1",
      payload: {
        name: "Release v2.0",
        description: "Milestone goal details",
        status: "planned",
        startDate: null,
        targetDate: null,
      },
    });

    expect(mockToastSuccess).toHaveBeenCalledWith("里程碑创建成功");
    expect(mockOnSuccess).toHaveBeenCalledWith("milestone-new-123");
    expect(mockOnClose).toHaveBeenCalledTimes(1);
  });

  it("handles server error and preserves form inputs for retry", async () => {
    mockLocale = "zh";
    mockMutateAsync.mockRejectedValueOnce(new Error("Server connection lost"));

    render(
      <CreateMilestoneModal
        open={true}
        projectId="proj-1"
        onClose={mockOnClose}
        onSuccess={mockOnSuccess}
      />,
    );

    const nameInput = screen.getByPlaceholderText("例如：v1.0 发布");
    fireEvent.change(nameInput, { target: { value: "Draft Beta" } });

    const descInput = screen.getByPlaceholderText(
      "简要说明这个阶段需要完成什么",
    );
    fireEvent.change(descInput, { target: { value: "Preserved description" } });

    const submitBtn = screen.getByRole("button", { name: "创建里程碑" });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    expect(screen.getByText("Server connection lost")).toBeInTheDocument();

    // Verify inputs were preserved
    expect(nameInput).toHaveValue("Draft Beta");
    expect(descInput).toHaveValue("Preserved description");

    // Avoid duplicate toasts when server error banner is rendered
    expect(mockToastError).not.toHaveBeenCalled();

    // Modal was not closed
    expect(mockOnClose).not.toHaveBeenCalled();
  });

  it("disables inputs and buttons during pending submission", () => {
    mockLocale = "zh";
    mockIsPending = true;

    render(
      <CreateMilestoneModal
        open={true}
        projectId="proj-1"
        onClose={mockOnClose}
        onSuccess={mockOnSuccess}
      />,
    );

    // Submit button displays creating text and is disabled
    const submitBtn = screen.getByRole("button", { name: /创建中…/ });
    expect(submitBtn).toBeInTheDocument();
    expect(submitBtn).toBeDisabled();

    // Cancel button is disabled
    const cancelBtn = screen.getByRole("button", { name: "取消" });
    expect(cancelBtn).toBeDisabled();

    // Form inputs are disabled
    const nameInput = screen.getByPlaceholderText("例如：v1.0 发布");
    expect(nameInput).toBeDisabled();

    const descInput = screen.getByPlaceholderText(
      "简要说明这个阶段需要完成什么",
    );
    expect(descInput).toBeDisabled();
  });

  it("calls onClose and resets form when Cancel is clicked", () => {
    mockLocale = "zh";
    render(
      <CreateMilestoneModal
        open={true}
        projectId="proj-1"
        onClose={mockOnClose}
        onSuccess={mockOnSuccess}
      />,
    );

    const nameInput = screen.getByPlaceholderText("例如：v1.0 发布");
    fireEvent.change(nameInput, { target: { value: "Temporary" } });

    const cancelBtn = screen.getByRole("button", { name: "取消" });
    fireEvent.click(cancelBtn);

    expect(mockOnClose).toHaveBeenCalledTimes(1);
    expect(mockOnSuccess).not.toHaveBeenCalled();
  });
});
