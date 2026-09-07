import {
  addMonths,
  addQuarters,
  differenceInCalendarDays,
  eachDayOfInterval,
  eachWeekOfInterval,
  endOfMonth,
  endOfQuarter,
  endOfWeek,
  format,
  isBefore,
  startOfDay,
  startOfMonth,
  startOfQuarter,
  subMonths,
  subQuarters,
} from "date-fns";
import type { Milestone, MilestoneStatus } from "@/types/milestone";

export type RoadmapScale = "month" | "quarter";

export type PeriodInfo = {
  startDate: Date;
  endDate: Date;
  days: Date[];
  weeks: Array<{
    startDate: Date;
    endDate: Date;
    label: string;
    actualDays: number;
  }>;
  totalDays: number;
};

const PURE_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const UTC_MIDNIGHT_ISO_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T00:00:00(?:\.000)?Z$/i;

function isValidCalendarValues(
  year: number,
  month: number,
  day: number,
): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(year, month - 1, day, 0, 0, 0, 0);
  return (
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day
  );
}

/**
 * Parse date string (YYYY-MM-DD or UTC midnight ISO) into a local midnight Date.
 *
 * Strictly accepts only calendar dates:
 * - Pure "YYYY-MM-DD"
 * - Standard UTC midnight ISO: "YYYY-MM-DDT00:00:00.000Z" or "YYYY-MM-DDT00:00:00Z"
 *
 * They preserve the exact calendar year, month, and day identically across all
 * viewer timezones without any drift.
 *
 * Any timestamp with non-zero time (e.g. "2026-09-06T14:30:00Z"), non-UTC offset (e.g. "+08:00"),
 * invalid calendar dates (e.g. Feb 31), or trailing garbage characters are strictly rejected (returns null).
 */
export function parseCalendarDate(
  value: string | null | undefined,
): Date | null {
  if (!value) return null;
  const str = value.trim();
  if (!str) return null;

  const match =
    str.match(PURE_DATE_PATTERN) ?? str.match(UTC_MIDNIGHT_ISO_PATTERN);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!isValidCalendarValues(year, month, day)) {
    return null;
  }

  return new Date(year, month - 1, day, 0, 0, 0, 0);
}

/**
 * Safely parse date string into local calendar Date object or null.
 */
export function parseDateSafe(value: string | null | undefined): Date | null {
  return parseCalendarDate(value);
}

/**
 * Resolves static i18n label for a milestone status using static string literals
 * to facilitate translation key extraction and avoid dynamic interpolation.
 */
export function getMilestoneStatusLabel(
  status: MilestoneStatus,
  t: (key: string, opts?: { defaultValue?: string }) => string,
): string {
  switch (status) {
    case "planned":
      return t("roadmap:status.planned", { defaultValue: "Planned" });
    case "active":
      return t("roadmap:status.active", { defaultValue: "In Progress" });
    case "completed":
      return t("roadmap:status.completed", { defaultValue: "Completed" });
    case "canceled":
      return t("roadmap:status.canceled", { defaultValue: "Canceled" });
    default:
      return status;
  }
}

/**
 * Format date to YYYY-MM-DD for storage, URL, or inputs.
 */
export function formatCalendarDate(
  date: Date | null | undefined,
): string | null {
  if (!date || Number.isNaN(date.getTime())) return null;
  return format(date, "yyyy-MM-dd");
}

/**
 * Check if a milestone is overdue:
 * - 目标日当天不算逾期；
 * - 目标日在本地今天之前且处于计划中(planned)或进行中(active)才算逾期。
 */
export function isMilestoneOverdue(
  milestone: Pick<Milestone, "targetDate" | "status">,
  referenceDate = new Date(),
): boolean {
  if (!milestone.targetDate) return false;
  if (milestone.status !== "planned" && milestone.status !== "active") {
    return false;
  }

  const target = parseDateSafe(milestone.targetDate);
  if (!target) return false;

  const today = startOfDay(referenceDate);
  const targetDay = startOfDay(target);

  // Target day itself is NOT overdue. It must be strictly before today.
  return isBefore(targetDay, today);
}

/**
 * Format date to YYYY-MM-DD for URL or inputs.
 */
export function formatDateToIsoDay(date: Date): string {
  return format(date, "yyyy-MM-dd");
}

/**
 * Parse YYYY-MM-DD from URL, falling back to current date if invalid.
 */
export function parseUrlDateOrToday(dateStr: string | undefined): Date {
  if (!dateStr) return new Date();
  const parsed = parseDateSafe(dateStr);
  return parsed ?? new Date();
}

/**
 * Compute the timeline period for the given anchor date and scale.
 */
export function getTimelinePeriod(
  anchorDate: Date,
  scale: RoadmapScale,
  weekStartsOn: 0 | 1 | 6 = 1,
): PeriodInfo {
  if (scale === "quarter") {
    const startDate = startOfQuarter(anchorDate);
    const endDate = endOfQuarter(anchorDate);
    const days = eachDayOfInterval({ start: startDate, end: endDate });
    const weekStarts = eachWeekOfInterval(
      { start: startDate, end: endDate },
      { weekStartsOn },
    );
    const weeks = weekStarts.map((wStart, idx) => {
      const wEnd = endOfWeek(wStart, { weekStartsOn });
      const effectiveStart = wStart < startDate ? startDate : wStart;
      const effectiveEnd = wEnd > endDate ? endDate : wEnd;
      const actualDays =
        differenceInCalendarDays(effectiveEnd, effectiveStart) + 1;
      return {
        startDate: effectiveStart,
        endDate: effectiveEnd,
        label: `W${idx + 1}`,
        actualDays,
      };
    });

    const totalDays = differenceInCalendarDays(endDate, startDate) + 1;

    return {
      startDate,
      endDate,
      days,
      weeks,
      totalDays,
    };
  }

  // Month scale
  const startDate = startOfMonth(anchorDate);
  const endDate = endOfMonth(anchorDate);
  const days = eachDayOfInterval({ start: startDate, end: endDate });
  const totalDays = differenceInCalendarDays(endDate, startDate) + 1;

  return {
    startDate,
    endDate,
    days,
    weeks: [],
    totalDays,
  };
}

/**
 * Navigate to previous/next period or today.
 */
export function getShiftedDate(
  currentDate: Date,
  scale: RoadmapScale,
  direction: "prev" | "next" | "today",
): Date {
  if (direction === "today") return new Date();

  if (scale === "quarter") {
    return direction === "prev"
      ? subQuarters(currentDate, 1)
      : addQuarters(currentDate, 1);
  }

  return direction === "prev"
    ? subMonths(currentDate, 1)
    : addMonths(currentDate, 1);
}

export type MilestoneVisualSchedule = {
  type:
    | "interval"
    | "target-only"
    | "start-only"
    | "unscheduled"
    | "out-of-range";
  leftPercent: number; // 0 to 100
  widthPercent: number; // 0 to 100
  clippedLeft: boolean;
  clippedRight: boolean;
};

/**
 * Calculate horizontal placement and clipping for milestone on timeline:
 * - Both dates: range bar from startDate to targetDate.
 * - Only targetDate: single point at targetDate.
 * - Only startDate: single point at startDate.
 * - No dates: unscheduled.
 * - Completely outside period: out-of-range.
 * - Uses calendar days difference to avoid DST drift.
 */
export function calculateMilestoneVisual(
  milestone: Pick<Milestone, "startDate" | "targetDate">,
  period: PeriodInfo,
): MilestoneVisualSchedule {
  const start = parseDateSafe(milestone.startDate);
  const target = parseDateSafe(milestone.targetDate);

  if (!start && !target) {
    return {
      type: "unscheduled",
      leftPercent: 0,
      widthPercent: 0,
      clippedLeft: false,
      clippedRight: false,
    };
  }

  const periodStart = startOfDay(period.startDate);
  const periodEnd = startOfDay(period.endDate);
  const totalDays = period.totalDays;

  // Single date: only targetDate
  if (!start && target) {
    const targetDay = startOfDay(target);
    if (isBefore(targetDay, periodStart) || isBefore(periodEnd, targetDay)) {
      return {
        type: "out-of-range",
        leftPercent: 0,
        widthPercent: 0,
        clippedLeft: false,
        clippedRight: false,
      };
    }
    const dayOffset = differenceInCalendarDays(targetDay, periodStart);
    // Center point in the day's column
    const leftPercent = ((dayOffset + 0.5) / totalDays) * 100;
    return {
      type: "target-only",
      leftPercent,
      widthPercent: 0,
      clippedLeft: false,
      clippedRight: false,
    };
  }

  // Single date: only startDate
  if (start && !target) {
    const startDay = startOfDay(start);
    if (isBefore(startDay, periodStart) || isBefore(periodEnd, startDay)) {
      return {
        type: "out-of-range",
        leftPercent: 0,
        widthPercent: 0,
        clippedLeft: false,
        clippedRight: false,
      };
    }
    const dayOffset = differenceInCalendarDays(startDay, periodStart);
    const leftPercent = ((dayOffset + 0.5) / totalDays) * 100;
    return {
      type: "start-only",
      leftPercent,
      widthPercent: 0,
      clippedLeft: false,
      clippedRight: false,
    };
  }

  // Both dates present
  if (start && target) {
    const startDay = startOfDay(start);
    const targetDay = startOfDay(target);

    // Completely before or completely after
    if (isBefore(targetDay, periodStart) || isBefore(periodEnd, startDay)) {
      return {
        type: "out-of-range",
        leftPercent: 0,
        widthPercent: 0,
        clippedLeft: false,
        clippedRight: false,
      };
    }

    const clippedLeft = isBefore(startDay, periodStart);
    const clippedRight = isBefore(periodEnd, targetDay);

    const effectiveStart = clippedLeft ? periodStart : startDay;
    const effectiveEnd = clippedRight ? periodEnd : targetDay;

    const startOffset = differenceInCalendarDays(effectiveStart, periodStart);
    const durationDays =
      differenceInCalendarDays(effectiveEnd, effectiveStart) + 1;

    const leftPercent = (startOffset / totalDays) * 100;
    const widthPercent = (durationDays / totalDays) * 100;

    return {
      type: "interval",
      leftPercent,
      widthPercent,
      clippedLeft,
      clippedRight,
    };
  }

  return {
    type: "unscheduled",
    leftPercent: 0,
    widthPercent: 0,
    clippedLeft: false,
    clippedRight: false,
  };
}

/**
 * Sort milestones according to F02 specification:
 * - targetDate ascending
 * - no targetDate placed at the end
 * - identical targetDate sorted stably by createdAt ascending, then id
 */
export function sortMilestones<
  T extends Pick<Milestone, "id" | "targetDate" | "createdAt">,
>(milestones: T[]): T[] {
  return [...milestones].sort((a, b) => {
    // Both have targetDate
    if (a.targetDate && b.targetDate) {
      const dateA = parseCalendarDate(a.targetDate);
      const dateB = parseCalendarDate(b.targetDate);
      const timeA = dateA ? dateA.getTime() : 0;
      const timeB = dateB ? dateB.getTime() : 0;
      const diff = timeA - timeB;
      if (diff !== 0) return diff;
    } else if (a.targetDate && !b.targetDate) {
      return -1;
    } else if (!a.targetDate && b.targetDate) {
      return 1;
    }

    // Stable secondary sort: createdAt asc
    const createdA = new Date(a.createdAt).getTime();
    const createdB = new Date(b.createdAt).getTime();
    if (createdA !== createdB) return createdA - createdB;

    // Tertiary: id
    return a.id.localeCompare(b.id);
  });
}
