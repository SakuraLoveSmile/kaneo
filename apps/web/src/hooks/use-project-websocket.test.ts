import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@kaneo/libs", () => ({
  windowId: "test-window-id",
}));

const mockUseSession = vi.fn();
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: () => mockUseSession(),
  },
}));

import { getWsUrl, useProjectWebSocket } from "./use-project-websocket";

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  url: string;
  readyState = 1; // WebSocket.OPEN
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => {
    if (this.onclose) this.onclose();
  });

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }
}

describe("useProjectWebSocket", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_API_URL", "http://localhost:1337");
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
    mockUseSession.mockReturnValue({
      data: { user: { id: "user-123" } },
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  describe("getWsUrl", () => {
    it("builds a ws:// URL from an http API base", () => {
      expect(getWsUrl("project-123")).toBe(
        "ws://localhost:1337/api/ws/project-123?windowId=test-window-id",
      );
    });

    it("builds a wss:// URL from an https API base", () => {
      vi.stubEnv("VITE_API_URL", "https://example.com");
      expect(getWsUrl("project-123")).toBe(
        "wss://example.com/api/ws/project-123?windowId=test-window-id",
      );
    });

    it("does not append /api when the base already ends with /api", () => {
      vi.stubEnv("VITE_API_URL", "https://example.com/api");
      expect(getWsUrl("p1")).toBe(
        "wss://example.com/api/ws/p1?windowId=test-window-id",
      );
    });

    it("trims trailing slashes from the API base", () => {
      vi.stubEnv("VITE_API_URL", "http://localhost:1337///");
      expect(getWsUrl("p1")).toBe(
        "ws://localhost:1337/api/ws/p1?windowId=test-window-id",
      );
    });

    it("URL-encodes the projectId", () => {
      expect(getWsUrl("a b/c?d")).toBe(
        "ws://localhost:1337/api/ws/a%20b%2Fc%3Fd?windowId=test-window-id",
      );
    });
  });

  describe("message reception & cache invalidation", () => {
    it("invalidates milestone and task queries upon receiving MILESTONES_UPDATED", () => {
      const queryClient = new QueryClient();
      const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

      const wrapper = ({ children }: { children: ReactNode }) =>
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          children,
        );

      renderHook(() => useProjectWebSocket("p1"), { wrapper });

      const ws = MockWebSocket.instances[0];
      expect(ws).toBeDefined();

      ws.onmessage?.({
        data: JSON.stringify({
          type: "MILESTONES_UPDATED",
          projectId: "p1",
        }),
      });

      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ["milestones", "p1"],
      });
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ["milestone", "p1"],
      });
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ["milestone-tasks", "p1"],
      });
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ["milestone-task-options", "p1"],
      });
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ["tasks", "p1"],
      });
    });

    it("invalidates milestone queries when tasks are updated", () => {
      const queryClient = new QueryClient();
      const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

      const wrapper = ({ children }: { children: ReactNode }) =>
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          children,
        );

      renderHook(() => useProjectWebSocket("p1"), { wrapper });

      const ws = MockWebSocket.instances[0];
      expect(ws).toBeDefined();

      ws.onmessage?.({
        data: JSON.stringify({
          type: "TASK_UPDATED",
          projectId: "p1",
          taskId: "t1",
        }),
      });

      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ["milestones", "p1"],
      });
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ["milestone-tasks", "p1"],
      });
    });
  });
});
