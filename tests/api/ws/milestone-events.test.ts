import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type EventHandler = (data: Record<string, unknown>) => Promise<void>;

const { subscriptions } = vi.hoisted(() => ({
  subscriptions: new Map<string, EventHandler>(),
}));

vi.mock("../../../apps/api/src/events", () => ({
  publishEvent: vi.fn(),
  subscribeToEvent: vi.fn((eventName: string, handler: EventHandler) => {
    subscriptions.set(eventName, handler);
  }),
}));

import {
  addConnection,
  initializeWebSocketAdapter,
  removeConnection,
  shutdownWebSocketAdapter,
} from "../../../apps/api/src/ws";

function makeFakeWs() {
  return {
    send: vi.fn(),
    close: vi.fn(),
    readyState: 1,
    raw: undefined,
    url: null,
    protocol: null,
  } as never;
}

function messages(ws: unknown) {
  return (ws as { send: ReturnType<typeof vi.fn> }).send.mock.calls.map(
    ([payload]) => JSON.parse(String(payload)) as { type: string },
  );
}

describe("project milestone WebSocket refresh events", () => {
  beforeEach(async () => {
    await initializeWebSocketAdapter();
  });

  afterEach(async () => {
    await shutdownWebSocketAdapter();
  });

  it("delivers milestone updates to the initiating and other windows", async () => {
    const first = makeFakeWs();
    const second = makeFakeWs();
    const firstConnection = addConnection(
      "project-1",
      first,
      "user-1",
      "window-1",
    );
    const secondConnection = addConnection(
      "project-1",
      second,
      "user-1",
      "window-2",
    );

    await subscriptions.get("milestone.updated")?.({ projectId: "project-1" });

    await vi.waitFor(
      () => {
        expect(messages(first)).toContainEqual({
          type: "MILESTONES_UPDATED",
          projectId: "project-1",
        });
        expect(messages(second)).toContainEqual({
          type: "MILESTONES_UPDATED",
          projectId: "project-1",
        });
      },
      { timeout: 300 },
    );

    removeConnection("project-1", firstConnection);
    removeConnection("project-1", secondConnection);
  });

  it("refreshes both projects after a task move", async () => {
    const source = makeFakeWs();
    const destination = makeFakeWs();
    const sourceConnection = addConnection(
      "project-1",
      source,
      "user-1",
      "window-1",
    );
    const destinationConnection = addConnection(
      "project-2",
      destination,
      "user-2",
      "window-2",
    );

    await subscriptions.get("task.moved")?.({
      fromProjectId: "project-1",
      toProjectId: "project-2",
      taskId: "task-1",
      initiatorId: "user-1:window-1",
    });

    await vi.waitFor(
      () => {
        expect(messages(source)).toContainEqual({
          type: "MILESTONES_UPDATED",
          projectId: "project-1",
        });
        expect(messages(destination)).toContainEqual({
          type: "MILESTONES_UPDATED",
          projectId: "project-2",
        });
      },
      { timeout: 300 },
    );

    removeConnection("project-1", sourceConnection);
    removeConnection("project-2", destinationConnection);
  });
});
