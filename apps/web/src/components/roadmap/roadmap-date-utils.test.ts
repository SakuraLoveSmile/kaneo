import { afterEach, describe, expect, it } from "vitest";
import {
  calculateMilestoneVisual,
  formatCalendarDate,
  getMilestoneStatusLabel,
  getShiftedDate,
  getTimelinePeriod,
  isMilestoneOverdue,
  parseCalendarDate,
  sortMilestones,
} from "./roadmap-date-utils";

describe("roadmap-date-utils", () => {
  describe("isMilestoneOverdue", () => {
    const today = new Date("2026-06-15T12:00:00Z");

    it("returns false if targetDate is today", () => {
      expect(
        isMilestoneOverdue(
          { targetDate: "2026-06-15", status: "active" },
          today,
        ),
      ).toBe(false);
    });

    it("returns true if targetDate is before today and active", () => {
      expect(
        isMilestoneOverdue(
          { targetDate: "2026-06-14", status: "active" },
          today,
        ),
      ).toBe(true);
    });

    it("returns true if targetDate is before today and planned", () => {
      expect(
        isMilestoneOverdue(
          { targetDate: "2026-06-14", status: "planned" },
          today,
        ),
      ).toBe(true);
    });

    it("returns false if completed or canceled even if targetDate is past", () => {
      expect(
        isMilestoneOverdue(
          { targetDate: "2026-06-10", status: "completed" },
          today,
        ),
      ).toBe(false);
      expect(
        isMilestoneOverdue(
          { targetDate: "2026-06-10", status: "canceled" },
          today,
        ),
      ).toBe(false);
    });

    it("returns false if no targetDate", () => {
      expect(
        isMilestoneOverdue({ targetDate: null, status: "active" }, today),
      ).toBe(false);
    });
  });

  describe("sortMilestones", () => {
    it("sorts by targetDate ascending with nulls last and stable secondary keys", () => {
      const milestones = [
        { id: "m3", targetDate: null, createdAt: "2026-01-01" },
        { id: "m2", targetDate: "2026-08-01", createdAt: "2026-01-02" },
        { id: "m1", targetDate: "2026-05-01", createdAt: "2026-01-03" },
        { id: "m4", targetDate: "2026-05-01", createdAt: "2026-01-01" },
      ];

      const sorted = sortMilestones(milestones);
      expect(sorted.map((m) => m.id)).toEqual(["m4", "m1", "m2", "m3"]);
    });
  });

  describe("getTimelinePeriod & getShiftedDate", () => {
    it("handles month scale correctly including leap year February", () => {
      const febLeap = new Date("2024-02-10T00:00:00Z");
      const period = getTimelinePeriod(febLeap, "month");
      expect(period.totalDays).toBe(29);
      expect(period.days.length).toBe(29);
    });

    it("shifts months and quarters accurately", () => {
      const d = new Date("2026-05-15T00:00:00Z");
      const nextMonth = getShiftedDate(d, "month", "next");
      expect(nextMonth.getMonth()).toBe(5); // June (0-indexed 5)

      const prevQuarter = getShiftedDate(d, "quarter", "prev");
      expect(prevQuarter.getMonth()).toBe(1); // Feb (Q1)
    });
  });

  describe("calculateMilestoneVisual", () => {
    const anchor = new Date("2026-06-15T00:00:00Z");
    const period = getTimelinePeriod(anchor, "month");

    it("handles unscheduled milestones", () => {
      const visual = calculateMilestoneVisual(
        { startDate: null, targetDate: null },
        period,
      );
      expect(visual.type).toBe("unscheduled");
    });

    it("handles target-only milestone inside month", () => {
      const visual = calculateMilestoneVisual(
        { startDate: null, targetDate: "2026-06-15" },
        period,
      );
      expect(visual.type).toBe("target-only");
      expect(visual.leftPercent).toBeGreaterThan(0);
    });

    it("handles start-only milestone inside month", () => {
      const visual = calculateMilestoneVisual(
        { startDate: "2026-06-05", targetDate: null },
        period,
      );
      expect(visual.type).toBe("start-only");
      expect(visual.leftPercent).toBeGreaterThan(0);
    });

    it("handles interval contained in month", () => {
      const visual = calculateMilestoneVisual(
        { startDate: "2026-06-05", targetDate: "2026-06-20" },
        period,
      );
      expect(visual.type).toBe("interval");
      expect(visual.clippedLeft).toBe(false);
      expect(visual.clippedRight).toBe(false);
    });

    it("handles interval spanning before and after the month with clipping", () => {
      const visual = calculateMilestoneVisual(
        { startDate: "2026-05-10", targetDate: "2026-07-10" },
        period,
      );
      expect(visual.type).toBe("interval");
      expect(visual.clippedLeft).toBe(true);
      expect(visual.clippedRight).toBe(true);
      expect(visual.leftPercent).toBe(0);
      expect(visual.widthPercent).toBe(100);
    });

    it("marks out-of-range milestones", () => {
      const visual = calculateMilestoneVisual(
        { startDate: "2026-01-01", targetDate: "2026-02-01" },
        period,
      );
      expect(visual.type).toBe("out-of-range");
    });
  });

  describe("parseCalendarDate & formatCalendarDate", () => {
    it("parses pure YYYY-MM-DD into local midnight date", () => {
      const date = parseCalendarDate("2026-06-15");
      expect(date).not.toBeNull();
      expect(date?.getFullYear()).toBe(2026);
      expect(date?.getMonth()).toBe(5); // June
      expect(date?.getDate()).toBe(15);
      expect(date?.getHours()).toBe(0);
      expect(date?.getMinutes()).toBe(0);
      expect(formatCalendarDate(date)).toBe("2026-06-15");
    });

    it("parses ISO UTC midnight string into local midnight date with identical calendar day", () => {
      const date = parseCalendarDate("2026-06-15T00:00:00.000Z");
      expect(date).not.toBeNull();
      expect(date?.getFullYear()).toBe(2026);
      expect(date?.getMonth()).toBe(5);
      expect(date?.getDate()).toBe(15);
      expect(formatCalendarDate(date)).toBe("2026-06-15");

      const dateWithoutMs = parseCalendarDate("2026-06-15T00:00:00Z");
      expect(dateWithoutMs?.getDate()).toBe(15);
    });

    it("strictly rejects non-midnight timestamps and non-UTC offsets", () => {
      expect(parseCalendarDate("2026-06-15T12:30:00.000Z")).toBeNull();
      expect(parseCalendarDate("2026-09-05T16:00:00.000Z")).toBeNull();
      expect(parseCalendarDate("2026-06-15T00:00:00+08:00")).toBeNull();
      expect(parseCalendarDate("2026-06-15T00:00:00-05:00")).toBeNull();
    });

    describe("cross-timezone consistency and strict rejection", () => {
      const originalTz = process.env.TZ;

      afterEach(() => {
        if (originalTz !== undefined) {
          process.env.TZ = originalTz;
        } else {
          delete process.env.TZ;
        }
      });

      it("guarantees identical calendar date across timezones for pure YYYY-MM-DD and UTC midnight ISO", () => {
        const timezones = [
          "Asia/Shanghai",
          "UTC",
          "America/Los_Angeles",
          "Europe/London",
          "Australia/Sydney",
        ];

        for (const tz of timezones) {
          process.env.TZ = tz;

          const pure = parseCalendarDate("2026-09-05");
          expect(formatCalendarDate(pure)).toBe("2026-09-05");
          expect(pure?.getFullYear()).toBe(2026);
          expect(pure?.getMonth()).toBe(8); // September (0-indexed)
          expect(pure?.getDate()).toBe(5);

          const utcMidnight = parseCalendarDate("2026-09-05T00:00:00.000Z");
          expect(formatCalendarDate(utcMidnight)).toBe("2026-09-05");
          expect(utcMidnight?.getFullYear()).toBe(2026);
          expect(utcMidnight?.getMonth()).toBe(8);
          expect(utcMidnight?.getDate()).toBe(5);
        }
      });

      it("strictly returns null for non-midnight timestamps across timezones", () => {
        const timezones = ["Asia/Shanghai", "UTC", "America/Los_Angeles"];

        for (const tz of timezones) {
          process.env.TZ = tz;
          expect(parseCalendarDate("2026-09-05T16:00:00.000Z")).toBeNull();
          expect(parseCalendarDate("2026-09-05T00:00:01.000Z")).toBeNull();
        }
      });
    });

    it("strictly rejects strings with trailing garbage characters", () => {
      expect(parseCalendarDate("2026-06-15abc")).toBeNull();
      expect(parseCalendarDate("2026-06-15 garbage")).toBeNull();
      expect(parseCalendarDate("2026-06-15T00:00:00.000Zextra")).toBeNull();
      expect(parseCalendarDate("2026-06-15T00:00:00.000Z 123")).toBeNull();
    });

    it("strictly rejects invalid calendar dates and impossible days", () => {
      expect(parseCalendarDate("2026-02-31")).toBeNull();
      expect(parseCalendarDate("2026-02-29")).toBeNull(); // 2026 is not a leap year
      expect(parseCalendarDate("2024-02-29")).not.toBeNull(); // 2024 is a leap year
      expect(parseCalendarDate("2026-04-31")).toBeNull(); // April has 30 days
      expect(parseCalendarDate("2026-13-01")).toBeNull(); // Invalid month
      expect(parseCalendarDate("2026-00-15")).toBeNull(); // Invalid month 0
      expect(parseCalendarDate("2026-01-32")).toBeNull(); // Invalid day
      expect(parseCalendarDate("2026-02-31T00:00:00.000Z")).toBeNull();
    });

    it("returns null for empty, null, undefined or malformed strings", () => {
      expect(parseCalendarDate(null)).toBeNull();
      expect(parseCalendarDate(undefined)).toBeNull();
      expect(parseCalendarDate("")).toBeNull();
      expect(parseCalendarDate("   ")).toBeNull();
      expect(parseCalendarDate("not-a-date")).toBeNull();
      expect(parseCalendarDate("2026/06/15")).toBeNull();
      expect(parseCalendarDate("06-15-2026")).toBeNull();
    });

    it("handles formatCalendarDate null/undefined safely", () => {
      expect(formatCalendarDate(null)).toBeNull();
      expect(formatCalendarDate(undefined)).toBeNull();
      expect(formatCalendarDate(new Date("invalid"))).toBeNull();
    });
  });

  describe("getMilestoneStatusLabel", () => {
    const mockT = (key: string, opts?: { defaultValue?: string }) =>
      opts?.defaultValue ?? key;

    it("maps each status to the correct static label", () => {
      expect(getMilestoneStatusLabel("planned", mockT)).toBe("Planned");
      expect(getMilestoneStatusLabel("active", mockT)).toBe("In Progress");
      expect(getMilestoneStatusLabel("completed", mockT)).toBe("Completed");
      expect(getMilestoneStatusLabel("canceled", mockT)).toBe("Canceled");
    });
  });
});
