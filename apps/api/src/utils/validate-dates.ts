import { HTTPException } from "hono/http-exception";

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_WITH_TIMEZONE_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i;
const ISO_WITHOUT_TIMEZONE_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;

function isValidCalendarDate(year: number, month: number, day: number) {
  const value = new Date(Date.UTC(year, month - 1, day));
  return (
    value.getUTCFullYear() === year &&
    value.getUTCMonth() === month - 1 &&
    value.getUTCDate() === day
  );
}

const UTC_MIDNIGHT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T00:00:00(?:\.000)?Z$/i;

/**
 * Validates and parses a date string. Existing task endpoints retain their
 * historical timezone-less datetime behavior for client compatibility.
 */
export function validateAndParseDate(
  dateStr: string,
  fieldName: string,
  options: { requireTimezone?: boolean } = {},
): Date {
  const value = dateStr.trim();
  if (value === "") {
    throw new HTTPException(400, {
      message: `${fieldName} cannot be an empty string. Please provide a valid date or omit the field.`,
    });
  }

  const dateOnlyMatch = value.match(DATE_ONLY_PATTERN);
  const isoMatch = value.match(ISO_WITH_TIMEZONE_PATTERN);
  const localIsoMatch = value.match(ISO_WITHOUT_TIMEZONE_PATTERN);
  const dateParts = dateOnlyMatch ?? isoMatch ?? localIsoMatch;

  if (
    !dateParts ||
    (options.requireTimezone && !dateOnlyMatch && !isoMatch) ||
    !isValidCalendarDate(
      Number(dateParts[1]),
      Number(dateParts[2]),
      Number(dateParts[3]),
    )
  ) {
    throw new HTTPException(400, {
      message: `Invalid ${fieldName} "${dateStr}". Please provide a valid date string (e.g. "2025-01-15" or "2025-01-15T10:30:00Z").`,
    });
  }

  const parsed = new Date(dateOnlyMatch ? `${value}T00:00:00.000Z` : value);
  if (Number.isNaN(parsed.getTime())) {
    throw new HTTPException(400, {
      message: `Invalid ${fieldName} "${dateStr}". Please provide a valid date string (e.g. "2025-01-15" or "2025-01-15T10:30:00Z").`,
    });
  }
  return parsed;
}

/**
 * Validates and parses a milestone calendar date (startDate or targetDate).
 * Strictly accepts only:
 * - Pure date: "YYYY-MM-DD" (e.g. "2026-09-06")
 * - UTC midnight ISO: "YYYY-MM-DDT00:00:00.000Z" or "YYYY-MM-DDT00:00:00Z"
 *
 * Strictly rejects:
 * - Timestamps with non-zero time (e.g. "2026-09-06T14:30:00Z")
 * - Timestamps with non-UTC timezone offsets (e.g. "2026-09-06T00:00:00+08:00")
 * - Impossible calendar dates (e.g. "2026-02-30")
 * - Trailing garbage or empty strings
 *
 * Normalizes all valid dates to a UTC midnight Date object.
 */
export function validateAndParseMilestoneCalendarDate(
  dateStr: string,
  fieldName: string,
): Date {
  const value = dateStr.trim();
  if (value === "") {
    throw new HTTPException(400, {
      message: `${fieldName} cannot be an empty string. Please provide a valid calendar date in YYYY-MM-DD format or omit the field.`,
    });
  }

  const dateOnlyMatch = value.match(DATE_ONLY_PATTERN);
  const utcMidnightMatch = value.match(UTC_MIDNIGHT_PATTERN);
  const match = dateOnlyMatch ?? utcMidnightMatch;

  if (!match) {
    throw new HTTPException(400, {
      message: `Invalid ${fieldName} "${dateStr}". Milestone ${fieldName} must be a calendar date in YYYY-MM-DD format (or UTC midnight YYYY-MM-DDT00:00:00.000Z). Timestamps with non-zero time or non-UTC offsets are not accepted.`,
    });
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (!isValidCalendarDate(year, month, day)) {
    throw new HTTPException(400, {
      message: `Invalid ${fieldName} "${dateStr}". Please provide a valid calendar date.`,
    });
  }

  return new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
}

export const validateAndParseMilestoneDate =
  validateAndParseMilestoneCalendarDate;

/**
 * Validates that startDate is not after dueDate when both are provided.
 * Throws an HTTPException if the date range is logically invalid.
 */
export function validateDateRange(
  startDate: Date | undefined | null,
  dueDate: Date | undefined | null,
): void {
  if (startDate && dueDate && startDate.getTime() > dueDate.getTime()) {
    throw new HTTPException(400, {
      message:
        "Start date cannot be after due date. Please adjust the date range.",
    });
  }
}
