import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstanceStorageCheckResult } from "@/fetchers/instance/check-instance-storage";
import type { InstanceStorageStatus } from "@/fetchers/instance/get-instance-storage";
import { Route } from "./storage";

const mockRefetch = vi.fn();
const mockCheckMutateAsync = vi.fn();
const mockUpdateMutateAsync = vi.fn();

let mockQueryState = {
  data: null as InstanceStorageStatus | null,
  isLoading: false,
  isError: false,
  isRefetching: false,
  refetch: mockRefetch,
};

let mockCheckMutationState = {
  mutateAsync: mockCheckMutateAsync,
  isPending: false,
};

let mockUpdateMutationState = {
  mutateAsync: mockUpdateMutateAsync,
  isPending: false,
};

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (opts: { component: React.ComponentType }) => opts,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { error?: string; time?: string }) => {
      if (key === "settings:storage.checkResult.failed" && opts?.error) {
        return `Connection test failed: ${opts.error}`;
      }
      return key;
    },
  }),
}));

vi.mock("@/components/page-title", () => ({
  default: () => null,
}));

vi.mock("@/hooks/queries/instance/use-get-instance-storage", () => ({
  default: () => mockQueryState,
}));

vi.mock("@/hooks/mutations/instance/use-check-instance-storage", () => ({
  default: () => mockCheckMutationState,
}));

vi.mock("@/hooks/mutations/instance/use-update-instance-storage", () => ({
  default: () => mockUpdateMutationState,
}));

vi.mock("@/lib/toast", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

function renderComponent() {
  const queryClient = new QueryClient();
  const Component = (Route as unknown as { component: React.ComponentType })
    .component;
  return render(
    <QueryClientProvider client={queryClient}>
      <Component />
    </QueryClientProvider>,
  );
}

describe("StorageSettingsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQueryState = {
      data: {
        backend: "s3",
        source: "environment",
        version: 1,
        localConfigured: true,
        s3Configured: true,
        localReason: null,
        s3Reason: null,
      },
      isLoading: false,
      isError: false,
      isRefetching: false,
      refetch: mockRefetch,
    };
    mockCheckMutationState = {
      mutateAsync: mockCheckMutateAsync,
      isPending: false,
    };
    mockUpdateMutationState = {
      mutateAsync: mockUpdateMutateAsync,
      isPending: false,
    };
  });

  afterEach(() => {
    cleanup();
  });

  it("shows loading state on initial load without disguised default S3", () => {
    mockQueryState = {
      data: null,
      isLoading: true,
      isError: false,
      isRefetching: false,
      refetch: mockRefetch,
    };

    renderComponent();

    expect(screen.queryByText("settings:storage.effectiveBackend")).toBeNull();
    expect(screen.getByText("settings:storage.actions.checking")).toBeDefined();
  });

  it("shows load error state with retry button when initial fetch fails", () => {
    mockQueryState = {
      data: null,
      isLoading: false,
      isError: true,
      isRefetching: false,
      refetch: mockRefetch,
    };

    renderComponent();

    expect(screen.getByText("settings:storage.loadError.title")).toBeDefined();
    expect(
      screen.getByText("settings:storage.loadError.description"),
    ).toBeDefined();

    const retryButton = screen.getByText("settings:storage.loadError.retry");
    fireEvent.click(retryButton);
    expect(mockRefetch).toHaveBeenCalledTimes(1);
  });

  it("shows refresh failed banner and disables save when background refetch fails", () => {
    mockQueryState.isError = true;

    renderComponent();

    expect(
      screen.getByText("settings:storage.refreshFailed.title"),
    ).toBeDefined();

    const saveButton = screen
      .getByText("settings:storage.actions.save")
      .closest("button");
    const restoreButton = screen
      .getByText("settings:storage.actions.restoreDefault")
      .closest("button");

    expect(saveButton?.disabled).toBe(true);
    expect(restoreButton?.disabled).toBe(true);
  });

  it("renders effective storage, migration warning, and options when loaded", () => {
    renderComponent();

    expect(screen.getByText("settings:storage.title")).toBeDefined();
    expect(
      screen.getByText("settings:storage.migrationWarning.title"),
    ).toBeDefined();
    expect(
      screen.getAllByText("settings:storage.backends.s3").length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      screen.getAllByText("settings:storage.backends.local").length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("displays missing configuration notice and disables unavailable option", () => {
    if (mockQueryState.data) {
      mockQueryState.data.s3Configured = false;
    }
    renderComponent();

    expect(screen.getByText("settings:storage.notConfigured.s3")).toBeDefined();
    const s3Radio = document.getElementById("storage-s3") as HTMLInputElement;
    expect(s3Radio.disabled).toBe(true);
  });

  it("triggers connection probe on click and labels the probed backend", async () => {
    mockCheckMutateAsync.mockResolvedValueOnce({
      backend: "s3",
      success: true,
      checkedAt: "2026-09-16T12:00:00.000Z",
      error: null,
    });

    renderComponent();

    const checkButton = screen.getByText(
      "settings:storage.actions.checkConnection",
    );
    fireEvent.click(checkButton);

    await waitFor(() => {
      expect(mockCheckMutateAsync).toHaveBeenCalledWith("s3");
    });

    expect(
      screen.getByText("settings:storage.checkResult.success"),
    ).toBeDefined();
    expect(
      screen.getAllByText("settings:storage.backends.s3").length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("clears probe result when user switches backend", async () => {
    mockCheckMutateAsync.mockResolvedValueOnce({
      backend: "local",
      success: true,
      checkedAt: "2026-09-16T12:00:00.000Z",
      error: null,
    });

    renderComponent();

    // Switch to local first
    const localRadio = document.getElementById(
      "storage-local",
    ) as HTMLInputElement;
    fireEvent.click(localRadio);

    const checkButton = screen.getByText(
      "settings:storage.actions.checkConnection",
    );
    fireEvent.click(checkButton);

    await waitFor(() => {
      expect(
        screen.getByText("settings:storage.checkResult.success"),
      ).toBeDefined();
    });

    // Switch back to s3
    const s3Radio = document.getElementById("storage-s3") as HTMLInputElement;
    fireEvent.click(s3Radio);

    // Old check result must be cleared
    expect(
      screen.queryByText("settings:storage.checkResult.success"),
    ).toBeNull();
  });

  it("ignores late arrival of probe response from a previous request", async () => {
    let delayedResolve: (val: InstanceStorageCheckResult) => void = () => {};
    mockCheckMutateAsync.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          delayedResolve = resolve;
        }),
    );

    renderComponent();

    const checkButton = screen.getByText(
      "settings:storage.actions.checkConnection",
    );
    fireEvent.click(checkButton);

    // User switches to local before the S3 check resolves
    const localRadio = document.getElementById(
      "storage-local",
    ) as HTMLInputElement;
    fireEvent.click(localRadio);

    // Now S3 check finally resolves
    delayedResolve({
      backend: "s3",
      success: true,
      checkedAt: "2026-09-16T12:00:00.000Z",
      error: null,
    });

    await waitFor(() => {
      expect(
        screen.queryByText("settings:storage.checkResult.success"),
      ).toBeNull();
    });
  });

  it("discards a check result when a server refresh changes the settings version", async () => {
    let finish!: (result: {
      backend: string;
      success: boolean;
      checkedAt: string;
      error: null;
    }) => void;
    mockCheckMutateAsync.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const view = renderComponent();
    fireEvent.click(
      screen.getByText("settings:storage.actions.checkConnection"),
    );
    await waitFor(() => expect(mockCheckMutateAsync).toHaveBeenCalled());
    if (!mockQueryState.data) throw new Error("Missing test storage status");
    mockQueryState.data = {
      ...mockQueryState.data,
      backend: "local",
      version: 2,
    };
    // Re-render the same route; a refresh can arrive while a probe is in flight.
    const Component = (Route as unknown as { component: React.ComponentType })
      .component;
    view.rerender(
      <QueryClientProvider client={new QueryClient()}>
        <Component />
      </QueryClientProvider>,
    );
    await act(async () => {
      finish({
        backend: "s3",
        success: true,
        checkedAt: new Date().toISOString(),
        error: null,
      });
    });
    await waitFor(() =>
      expect(
        screen.queryByText("settings:storage.checkResult.success"),
      ).toBeNull(),
    );
  });

  it("saves selected backend with optimistic version", async () => {
    mockUpdateMutateAsync.mockResolvedValueOnce({
      backend: "local",
      source: "database",
      version: 2,
      localConfigured: true,
      s3Configured: true,
    });

    renderComponent();

    const saveButton = screen.getByText("settings:storage.actions.save");
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(mockUpdateMutateAsync).toHaveBeenCalledWith({
        backend: "s3",
        version: 1,
      });
    });
  });

  it("restores deployment default with backend: 'default'", async () => {
    mockUpdateMutateAsync.mockResolvedValueOnce({
      backend: "s3",
      source: "environment",
      version: 2,
      localConfigured: true,
      s3Configured: true,
    });

    renderComponent();

    const restoreButton = screen.getByText(
      "settings:storage.actions.restoreDefault",
    );
    fireEvent.click(restoreButton);

    await waitFor(() => {
      expect(mockUpdateMutateAsync).toHaveBeenCalledWith({
        backend: "default",
        version: 1,
      });
    });
  });

  it("handles 409 conflict and triggers refetch", async () => {
    mockUpdateMutateAsync.mockRejectedValueOnce(
      new Error(
        "409: Storage settings have been modified by another administrator.",
      ),
    );

    renderComponent();

    const saveButton = screen.getByText("settings:storage.actions.save");
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(mockRefetch).toHaveBeenCalled();
    });
  });

  it("disables operations when checking or saving is in progress", () => {
    mockCheckMutationState.isPending = true;

    renderComponent();

    const checkButton = screen
      .getByText("settings:storage.actions.checking")
      .closest("button");
    const saveButton = screen
      .getByText("settings:storage.actions.save")
      .closest("button");
    const localRadio = document.getElementById(
      "storage-local",
    ) as HTMLInputElement;

    expect(checkButton?.disabled).toBe(true);
    expect(saveButton?.disabled).toBe(true);
    expect(localRadio?.disabled).toBe(true);
  });
});
