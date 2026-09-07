import { describe, expect, it } from "vitest";
import { resolveCompletedAt } from "../../apps/api/src/milestone/resolve-completed-at";

const now = new Date("2026-09-06T08:00:00.000Z");

describe("resolveCompletedAt", () => {
  it("uses the server time when a milestone enters completed without a timestamp", () => {
    expect(
      resolveCompletedAt({
        nextStatus: "completed",
        requestedCompletedAt: undefined,
        previousStatus: "active",
        previousCompletedAt: null,
        now,
      }),
    ).toEqual(now);
  });

  it("preserves an existing completion time while staying completed", () => {
    const previousCompletedAt = new Date("2026-09-01T08:00:00.000Z");

    expect(
      resolveCompletedAt({
        nextStatus: "completed",
        requestedCompletedAt: undefined,
        previousStatus: "completed",
        previousCompletedAt,
        now,
      }),
    ).toEqual(previousCompletedAt);
  });

  it("accepts an explicit historical timestamp and clears it when reopening", () => {
    const historical = new Date("2026-08-31T08:00:00.000Z");

    expect(
      resolveCompletedAt({
        nextStatus: "completed",
        requestedCompletedAt: historical,
        previousStatus: "active",
        previousCompletedAt: null,
        now,
      }),
    ).toEqual(historical);

    expect(
      resolveCompletedAt({
        nextStatus: "active",
        requestedCompletedAt: undefined,
        previousStatus: "completed",
        previousCompletedAt: historical,
        now,
      }),
    ).toBeNull();
  });

  it("rejects a timestamp that conflicts with the resulting status", () => {
    expect(() =>
      resolveCompletedAt({
        nextStatus: "planned",
        requestedCompletedAt: now,
        now,
      }),
    ).toThrow(/only be set/i);

    expect(() =>
      resolveCompletedAt({
        nextStatus: "completed",
        requestedCompletedAt: null,
        now,
      }),
    ).toThrow(/cannot be null/i);
  });
});
