import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listeners: Array<
  (pattern: string, channel: string, data: string) => void
> = [];
const publish = vi.fn();
const subscriber = {
  psubscribe: vi.fn().mockResolvedValue(undefined),
  punsubscribe: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(
    (
      _event: string,
      handler: (pattern: string, channel: string, data: string) => void,
    ) => {
      listeners.push(handler);
    },
  ),
  off: vi.fn(),
};

vi.mock("../../../apps/api/src/redis", () => ({
  closeRedis: vi.fn().mockResolvedValue(undefined),
  getRedisPub: () => ({ publish }),
  getRedisSub: () => subscriber,
}));

import { RedisBroadcastAdapter } from "../../../apps/api/src/ws/redis-broadcast-adapter";

const PROJECT_PATTERN = "kaneo:ws:*:broadcast";
let activeAdapter: RedisBroadcastAdapter | undefined;

describe("RedisBroadcastAdapter project messages", () => {
  beforeEach(() => {
    listeners.length = 0;
    publish.mockReset().mockResolvedValue(1);
    activeAdapter = undefined;
  });

  afterEach(async () => {
    await activeAdapter?.shutdown();
  });

  it("parses a MILESTONES_UPDATED message through the Redis schema", async () => {
    const adapter = new RedisBroadcastAdapter();
    activeAdapter = adapter;
    const received: unknown[] = [];
    await adapter.subscribe((message) => received.push(message));

    const payload = {
      projectId: "project-1",
      message: {
        type: "MILESTONES_UPDATED",
        projectId: "project-1",
      },
    };
    listeners[0]?.(
      PROJECT_PATTERN,
      "kaneo:ws:project-1:broadcast",
      JSON.stringify(payload),
    );

    expect(received).toEqual([payload]);
  });
});
