import { createHash, randomUUID } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client, Pool, PoolClient } from "pg";
import { z } from "zod";
import { getDatabasePool } from "../src/database";

export type NormalizeMode = "preview" | "apply" | "rollback" | "verify";

export type NormalizeOptions = {
  mode: NormalizeMode;
  manifestPath?: string;
  defaultTimezone?: string;
  projectTimezones: Record<string, string>;
  overrides: Record<string, string>; // `${milestoneId}.${field}` => YYYY-MM-DD
};

export type FieldAuditAction =
  | "KEPT_NULL"
  | "KEPT_UTC_MIDNIGHT"
  | "NORMALIZED"
  | "OVERRIDDEN"
  | "PENDING_CONFIRMATION"
  | "INVALID_FORMAT";

export type MilestoneDbRawRow = {
  id: string;
  project_id: string;
  name: string;
  start_date_raw: string | null; // e.g. "2026-09-05 16:00:00.123456" or "2026-09-06 00:00:00"
  target_date_raw: string | null;
  updated_at_raw: string; // e.g. "2026-09-01 10:00:00.654321"
};

export type MilestoneAuditRecord = {
  milestoneId: string;
  projectId: string;
  name: string;
  originalStartDate: string | null;
  originalTargetDate: string | null;
  originalUpdatedAt: string;
  targetStartDate: string | null;
  targetTargetDate: string | null;
  startDateAction: FieldAuditAction;
  targetDateAction: FieldAuditAction;
  startDateReason?: string;
  targetDateReason?: string;
  hasError: boolean;
  errorReason?: string;
  needsUpdate: boolean;
};

export type MigrationManifestRecordV2 = {
  milestoneId: string;
  projectId: string;
  name: string;
  original: {
    startDate: string | null;
    targetDate: string | null;
    updatedAt: string;
  };
  target: {
    startDate: string | null;
    targetDate: string | null;
  };
  actions: {
    startDate: FieldAuditAction;
    targetDate: FieldAuditAction;
  };
  reasons: {
    startDate?: string;
    targetDate?: string;
  };
  needsUpdate: boolean;
};

export type MigrationManifestV2 = {
  version: 2;
  migrationId: string;
  createdAt: string;
  database: {
    name: string;
    schema: string;
  };
  rules: {
    defaultTimezone?: string;
    projectTimezones: Record<string, string>;
    overrides: Record<string, string>;
  };
  summary: {
    totalInspected: number;
    totalUpdated: number;
    totalUnchanged: number;
  };
  records: MigrationManifestRecordV2[];
};

export type MigrationReceiptV2 = {
  version: 2;
  receiptId: string;
  migrationId: string;
  manifestPath: string;
  manifestSha256: string;
  action: "apply" | "rollback";
  timestamp: string;
  database: {
    name: string;
    schema: string;
  };
  affectedRows: number;
  status: "committed";
};

export type AuditSummary = {
  totalInspected: number;
  totalKeptNull: number;
  totalKeptUtcMidnight: number;
  totalNormalized: number;
  totalOverridden: number;
  totalPendingConfirmation: number;
  totalInvalidRange: number;
  totalErrors: number;
  totalNeedsUpdate: number;
  records: MilestoneAuditRecord[];
};

export type DatabaseTargetInfo = {
  name: string;
  schema: string;
};

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function getDaysInMonth(year: number, month: number): number {
  switch (month) {
    case 1:
    case 3:
    case 5:
    case 7:
    case 8:
    case 10:
    case 12:
      return 31;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    case 2:
      return isLeapYear(year) ? 29 : 28;
    default:
      return 0;
  }
}

export const STRICT_DB_TIMESTAMP_REGEX =
  /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/;
export const PURE_DATE_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;
export const STRICT_ISO_UTC_REGEX =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/;

export function validateStrictDbTimestamp(raw: string): boolean {
  if (typeof raw !== "string") return false;
  const match = raw.match(STRICT_DB_TIMESTAMP_REGEX);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);

  if (year < 1 || year > 9999) return false;
  if (month < 1 || month > 12) return false;
  const maxDays = getDaysInMonth(year, month);
  if (day < 1 || day > maxDays) return false;
  if (hour < 0 || hour > 23) return false;
  if (minute < 0 || minute > 59) return false;
  if (second < 0 || second > 59) return false;

  return true;
}

export function validateStrictUtcMidnight(raw: string): boolean {
  if (!validateStrictDbTimestamp(raw)) return false;
  const match = raw.match(STRICT_DB_TIMESTAMP_REGEX);
  if (!match) return false;
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7];
  return (
    hour === 0 &&
    minute === 0 &&
    second === 0 &&
    (!fraction || Number(fraction) === 0)
  );
}

export function validateIsoUtcTimestamp(raw: string): boolean {
  if (typeof raw !== "string") return false;
  const match = raw.match(STRICT_ISO_UTC_REGEX);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);

  if (year < 1 || year > 9999) return false;
  if (month < 1 || month > 12) return false;
  const maxDays = getDaysInMonth(year, month);
  if (day < 1 || day > maxDays) return false;
  if (hour < 0 || hour > 23) return false;
  if (minute < 0 || minute > 59) return false;
  if (second < 0 || second > 59) return false;

  return true;
}

export function isValidTimeZone(tz: string): boolean {
  if (!tz || tz.trim() === "") return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function isUtcMidnightRaw(raw: string | null): boolean {
  if (!raw) return false;
  return validateStrictUtcMidnight(raw);
}

export function parseDbTimestampToUtcInstant(raw: string): Date | null {
  if (!validateStrictDbTimestamp(raw)) return null;
  const match = raw.match(STRICT_DB_TIMESTAMP_REGEX);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const ms = match[7] ? Number(match[7].slice(0, 3).padEnd(3, "0")) : 0;
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second, ms));
}

export function parseCalendarDateString(str: string): {
  year: number;
  month: number;
  day: number;
  formatted: string;
} | null {
  const match = str.trim().match(PURE_DATE_REGEX);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || year > 9999) return null;
  if (month < 1 || month > 12) return null;
  const maxDays = getDaysInMonth(year, month);
  if (day < 1 || day > maxDays) return null;

  const formatted = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return { year, month, day, formatted };
}

export function convertTimestampToCalendarDate(
  date: Date,
  timeZone: string,
): { year: number; month: number; day: number; formatted: string } {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(date);
  let year = 0;
  let month = 0;
  let day = 0;
  for (const part of parts) {
    if (part.type === "year") year = Number(part.value);
    if (part.type === "month") month = Number(part.value);
    if (part.type === "day") day = Number(part.value);
  }
  const formatted = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return { year, month, day, formatted };
}

export function auditMilestoneRow(
  row: MilestoneDbRawRow,
  options: Pick<
    NormalizeOptions,
    "defaultTimezone" | "projectTimezones" | "overrides"
  >,
): MilestoneAuditRecord {
  let hasError = false;
  let startDateAction: FieldAuditAction = "KEPT_NULL";
  let targetDateAction: FieldAuditAction = "KEPT_NULL";
  let startDateReason: string | undefined;
  let targetDateReason: string | undefined;
  let targetStartDate: string | null = null;
  let targetTargetDate: string | null = null;

  // 1. Audit startDate
  const startOverride = options.overrides[`${row.id}.startDate`];
  if (startOverride !== undefined) {
    const parsed = parseCalendarDateString(startOverride);
    if (!parsed) {
      startDateAction = "INVALID_FORMAT";
      startDateReason = `Invalid override date "${startOverride}" for startDate`;
      hasError = true;
    } else {
      startDateAction = "OVERRIDDEN";
      targetStartDate = `${parsed.formatted} 00:00:00`;
      startDateReason = `Explicitly overridden to ${parsed.formatted}`;
    }
  } else if (row.start_date_raw === null) {
    startDateAction = "KEPT_NULL";
    targetStartDate = null;
    startDateReason = "Kept null";
  } else if (isUtcMidnightRaw(row.start_date_raw)) {
    startDateAction = "KEPT_UTC_MIDNIGHT";
    // Standardize midnight format to "YYYY-MM-DD 00:00:00"
    const match = row.start_date_raw.match(STRICT_DB_TIMESTAMP_REGEX);
    targetStartDate = match
      ? `${match[1]}-${match[2]}-${match[3]} 00:00:00`
      : row.start_date_raw;
    startDateReason = "Already standard UTC midnight";
  } else {
    const tz =
      options.projectTimezones[row.project_id] ?? options.defaultTimezone;
    if (!tz) {
      startDateAction = "PENDING_CONFIRMATION";
      startDateReason = `Non-midnight timestamp (${row.start_date_raw}) requires timezone. Specify via --timezone or --project-tz=${row.project_id}=<tz>`;
      targetStartDate = row.start_date_raw;
      hasError = true;
    } else {
      const instant = parseDbTimestampToUtcInstant(row.start_date_raw);
      if (!instant) {
        startDateAction = "INVALID_FORMAT";
        startDateReason = `Failed to parse database timestamp: "${row.start_date_raw}"`;
        hasError = true;
      } else {
        const { formatted } = convertTimestampToCalendarDate(instant, tz);
        targetStartDate = `${formatted} 00:00:00`;
        startDateAction = "NORMALIZED";
        startDateReason = `Normalized from ${row.start_date_raw} to ${formatted} (via ${tz})`;
      }
    }
  }

  // 2. Audit targetDate
  const targetOverride = options.overrides[`${row.id}.targetDate`];
  if (targetOverride !== undefined) {
    const parsed = parseCalendarDateString(targetOverride);
    if (!parsed) {
      targetDateAction = "INVALID_FORMAT";
      targetDateReason = `Invalid override date "${targetOverride}" for targetDate`;
      hasError = true;
    } else {
      targetDateAction = "OVERRIDDEN";
      targetTargetDate = `${parsed.formatted} 00:00:00`;
      targetDateReason = `Explicitly overridden to ${parsed.formatted}`;
    }
  } else if (row.target_date_raw === null) {
    targetDateAction = "KEPT_NULL";
    targetTargetDate = null;
    targetDateReason = "Kept null";
  } else if (isUtcMidnightRaw(row.target_date_raw)) {
    targetDateAction = "KEPT_UTC_MIDNIGHT";
    const match = row.target_date_raw.match(STRICT_DB_TIMESTAMP_REGEX);
    targetTargetDate = match
      ? `${match[1]}-${match[2]}-${match[3]} 00:00:00`
      : row.target_date_raw;
    targetDateReason = "Already standard UTC midnight";
  } else {
    const tz =
      options.projectTimezones[row.project_id] ?? options.defaultTimezone;
    if (!tz) {
      targetDateAction = "PENDING_CONFIRMATION";
      targetDateReason = `Non-midnight timestamp (${row.target_date_raw}) requires timezone. Specify via --timezone or --project-tz=${row.project_id}=<tz>`;
      targetTargetDate = row.target_date_raw;
      hasError = true;
    } else {
      const instant = parseDbTimestampToUtcInstant(row.target_date_raw);
      if (!instant) {
        targetDateAction = "INVALID_FORMAT";
        targetDateReason = `Failed to parse database timestamp: "${row.target_date_raw}"`;
        hasError = true;
      } else {
        const { formatted } = convertTimestampToCalendarDate(instant, tz);
        targetTargetDate = `${formatted} 00:00:00`;
        targetDateAction = "NORMALIZED";
        targetDateReason = `Normalized from ${row.target_date_raw} to ${formatted} (via ${tz})`;
      }
    }
  }

  // 3. Range check (targetStartDate <= targetTargetDate)
  let errorReason: string | undefined;
  if (!hasError && targetStartDate && targetTargetDate) {
    // Both are "YYYY-MM-DD 00:00:00", string comparison is chronologically exact
    if (targetStartDate > targetTargetDate) {
      hasError = true;
      errorReason = `INVALID_RANGE: startDate (${targetStartDate.slice(0, 10)}) cannot be after targetDate (${targetTargetDate.slice(0, 10)})`;
    }
  }

  // 4. Determine if database change is needed
  const startChanged = row.start_date_raw !== targetStartDate;
  const targetChanged = row.target_date_raw !== targetTargetDate;
  const needsUpdate = !hasError && (startChanged || targetChanged);

  return {
    milestoneId: row.id,
    projectId: row.project_id,
    name: row.name,
    originalStartDate: row.start_date_raw,
    originalTargetDate: row.target_date_raw,
    originalUpdatedAt: row.updated_at_raw,
    targetStartDate,
    targetTargetDate,
    startDateAction,
    targetDateAction,
    startDateReason,
    targetDateReason,
    hasError,
    errorReason,
    needsUpdate,
  };
}

export function auditAllMilestones(
  rows: MilestoneDbRawRow[],
  options: Pick<
    NormalizeOptions,
    "defaultTimezone" | "projectTimezones" | "overrides"
  >,
): AuditSummary {
  // Check for invalid override targets (overrides pointing to nonexistent milestones)
  const existingIds = new Set(rows.map((r) => r.id));
  const invalidOverrideErrors: string[] = [];
  for (const key of Object.keys(options.overrides)) {
    const id = key.split(".")[0];
    if (id && !existingIds.has(id)) {
      invalidOverrideErrors.push(
        `Invalid override target: Milestone "${id}" does not exist in the database.`,
      );
    }
  }

  const records = rows.map((row) => auditMilestoneRow(row, options));

  let totalKeptNull = 0;
  let totalKeptUtcMidnight = 0;
  let totalNormalized = 0;
  let totalOverridden = 0;
  let totalPendingConfirmation = 0;
  let totalInvalidRange = 0;
  let totalErrors = invalidOverrideErrors.length;
  let totalNeedsUpdate = 0;

  for (const r of records) {
    if (r.hasError) {
      totalErrors++;
      if (
        r.startDateAction === "PENDING_CONFIRMATION" ||
        r.targetDateAction === "PENDING_CONFIRMATION"
      ) {
        totalPendingConfirmation++;
      }
      if (r.errorReason?.startsWith("INVALID_RANGE")) {
        totalInvalidRange++;
      }
    }
    if (r.needsUpdate) {
      totalNeedsUpdate++;
    }
    if (
      r.startDateAction === "NORMALIZED" ||
      r.targetDateAction === "NORMALIZED"
    ) {
      totalNormalized++;
    }
    if (
      r.startDateAction === "OVERRIDDEN" ||
      r.targetDateAction === "OVERRIDDEN"
    ) {
      totalOverridden++;
    }
    if (
      r.startDateAction === "KEPT_UTC_MIDNIGHT" &&
      r.targetDateAction === "KEPT_UTC_MIDNIGHT"
    ) {
      totalKeptUtcMidnight++;
    }
    if (
      r.startDateAction === "KEPT_NULL" &&
      r.targetDateAction === "KEPT_NULL"
    ) {
      totalKeptNull++;
    }
  }

  // If there were invalid override errors, append an error record to represent them
  if (invalidOverrideErrors.length > 0) {
    records.push({
      milestoneId: "OVERRIDE_ERROR",
      projectId: "N/A",
      name: "Override Target Validation",
      originalStartDate: null,
      originalTargetDate: null,
      originalUpdatedAt: "",
      targetStartDate: null,
      targetTargetDate: null,
      startDateAction: "INVALID_FORMAT",
      targetDateAction: "INVALID_FORMAT",
      hasError: true,
      errorReason: invalidOverrideErrors.join(" "),
      needsUpdate: false,
    });
  }

  return {
    totalInspected: rows.length,
    totalKeptNull,
    totalKeptUtcMidnight,
    totalNormalized,
    totalOverridden,
    totalPendingConfirmation,
    totalInvalidRange,
    totalErrors,
    totalNeedsUpdate,
    records,
  };
}

export function parseNormalizeArgs(argv: string[]): NormalizeOptions {
  let mode: NormalizeMode | undefined;
  let manifestPath: string | undefined;
  let defaultTimezone: string | undefined;
  const projectTimezones: Record<string, string> = {};
  const overrides: Record<string, string> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) break;

    if (arg === "--force" || arg.startsWith("--force=")) {
      throw new Error(
        "--force is prohibited. The migration tool enforces strict safety checks.",
      );
    }

    if (arg === "--help" || arg === "-h") {
      // Return preview mode for help display
      return {
        mode: "preview",
        manifestPath: undefined,
        projectTimezones: {},
        overrides: {},
      };
    }

    if (arg === "--preview") {
      if (mode && mode !== "preview") {
        throw new Error(`Cannot combine --preview with --${mode}.`);
      }
      mode = "preview";
    } else if (arg === "--apply") {
      if (mode && mode !== "apply") {
        throw new Error(`Cannot combine --apply with --${mode}.`);
      }
      mode = "apply";
    } else if (arg === "--rollback") {
      if (mode && mode !== "rollback") {
        throw new Error(`Cannot combine --rollback with --${mode}.`);
      }
      mode = "rollback";
    } else if (arg === "--verify") {
      if (mode && mode !== "verify") {
        throw new Error(`Cannot combine --verify with --${mode}.`);
      }
      mode = "verify";
    } else if (arg.startsWith("--manifest=")) {
      const val = arg.slice("--manifest=".length).trim();
      if (!val) throw new Error("Missing path in --manifest=<path> option.");
      manifestPath = resolve(process.cwd(), val);
    } else if (arg === "--manifest") {
      const next = argv[++i];
      if (!next || next.startsWith("-")) {
        throw new Error("Missing path after --manifest flag.");
      }
      manifestPath = resolve(process.cwd(), next.trim());
    } else if (arg.startsWith("--timezone=")) {
      const val = arg.slice("--timezone=".length).trim();
      if (!val)
        throw new Error("Missing timezone in --timezone=<iana-tz> option.");
      defaultTimezone = val;
    } else if (arg === "--timezone") {
      const next = argv[++i];
      if (!next || next.startsWith("-")) {
        throw new Error("Missing timezone after --timezone flag.");
      }
      defaultTimezone = next.trim();
    } else if (arg.startsWith("--project-tz=")) {
      const val = arg.slice("--project-tz=".length).trim();
      if (!val) throw new Error("Missing mapping in --project-tz option.");
      for (const pair of val.split(",")) {
        const [projectId, tz] = pair.split("=");
        if (!projectId || !tz) {
          throw new Error(
            `Invalid --project-tz format "${pair}". Expected <projectId>=<iana-tz>.`,
          );
        }
        projectTimezones[projectId.trim()] = tz.trim();
      }
    } else if (arg.startsWith("--override=")) {
      const val = arg.slice("--override=".length).trim();
      if (!val) throw new Error("Missing override in --override option.");
      for (const pair of val.split(",")) {
        const match = pair.match(/^([^.]+)\.(startDate|targetDate)=(.+)$/);
        if (!match?.[1] || !match[2] || !match[3]) {
          throw new Error(
            `Invalid --override format "${pair}". Expected <milestoneId>.<startDate|targetDate>=YYYY-MM-DD.`,
          );
        }
        const id = match[1];
        const field = match[2];
        const dateStr = match[3];
        if (!parseCalendarDateString(dateStr)) {
          throw new Error(
            `Invalid override date "${dateStr}" in "${pair}". Must be a valid YYYY-MM-DD date.`,
          );
        }
        overrides[`${id}.${field}`] = dateStr;
      }
    } else {
      throw new Error(`Unknown option "${arg}". Run with --help for usage.`);
    }
  }

  // Default mode is preview
  const resolvedMode = mode ?? "preview";

  // Validate mode rules
  if (
    resolvedMode === "apply" ||
    resolvedMode === "rollback" ||
    resolvedMode === "verify"
  ) {
    if (!manifestPath) {
      throw new Error(`--manifest=<path> is required for --${resolvedMode}.`);
    }
    if (defaultTimezone !== undefined) {
      throw new Error("--timezone is only permitted in --preview mode.");
    }
    if (Object.keys(projectTimezones).length > 0) {
      throw new Error("--project-tz is only permitted in --preview mode.");
    }
    if (Object.keys(overrides).length > 0) {
      throw new Error("--override is only permitted in --preview mode.");
    }
  }

  // Validate timezones if in preview
  if (defaultTimezone && !isValidTimeZone(defaultTimezone)) {
    throw new Error(
      `Invalid default timezone "${defaultTimezone}". Must be a valid IANA timezone (e.g. "Asia/Shanghai", "UTC", "America/New_York").`,
    );
  }

  for (const [projectId, tz] of Object.entries(projectTimezones)) {
    if (!isValidTimeZone(tz)) {
      throw new Error(
        `Invalid timezone "${tz}" for project "${projectId}". Must be a valid IANA timezone.`,
      );
    }
  }

  return {
    mode: resolvedMode,
    manifestPath,
    defaultTimezone,
    projectTimezones,
    overrides,
  };
}

export function computeSha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export async function writeExclusiveFile(
  filePath: string,
  content: string,
  openFn: typeof open = open,
): Promise<void> {
  const resolvedPath = resolve(filePath);
  let fileHandle: Awaited<ReturnType<typeof open>>;
  try {
    fileHandle = await openFn(resolvedPath, "wx", 0o600);
  } catch (openErr: unknown) {
    const isExist =
      typeof openErr === "object" &&
      openErr !== null &&
      "code" in openErr &&
      (openErr as { code?: string }).code === "EEXIST";
    if (isExist) {
      throw openErr;
    }
    throw new Error(
      `Failed to open file "${filePath}" for exclusive creation: ${openErr instanceof Error ? openErr.message : String(openErr)}`,
      { cause: openErr },
    );
  }

  let writeSyncErr: unknown;
  try {
    await fileHandle.writeFile(content, "utf8");
    await fileHandle.sync();
  } catch (err) {
    writeSyncErr = err;
  }

  let closeErr: unknown;
  try {
    await fileHandle.close();
  } catch (err) {
    closeErr = err;
  }

  if (writeSyncErr) {
    if (closeErr) {
      throw new Error(
        `Failed writing/syncing file "${filePath}": ${writeSyncErr instanceof Error ? writeSyncErr.message : String(writeSyncErr)} (Secondary error closing file handle: ${closeErr instanceof Error ? closeErr.message : String(closeErr)})`,
        { cause: writeSyncErr },
      );
    }
    throw writeSyncErr;
  }
  if (closeErr) {
    throw closeErr;
  }

  // Parent directory fsync
  const dirPath = dirname(resolvedPath);
  let dirHandle: Awaited<ReturnType<typeof open>>;
  try {
    dirHandle = await openFn(dirPath, "r");
  } catch (dirOpenErr) {
    throw new Error(
      `Failed to open parent directory "${dirPath}" to sync directory entry for "${filePath}": ${dirOpenErr instanceof Error ? dirOpenErr.message : String(dirOpenErr)}`,
      { cause: dirOpenErr },
    );
  }

  let dirSyncErr: unknown;
  try {
    await dirHandle.sync();
  } catch (err) {
    dirSyncErr = err;
  }

  let dirCloseErr: unknown;
  try {
    await dirHandle.close();
  } catch (err) {
    dirCloseErr = err;
  }

  if (dirSyncErr) {
    if (dirCloseErr) {
      throw new Error(
        `Failed syncing parent directory "${dirPath}": ${dirSyncErr instanceof Error ? dirSyncErr.message : String(dirSyncErr)} (Secondary error closing directory handle: ${dirCloseErr instanceof Error ? dirCloseErr.message : String(dirCloseErr)})`,
        { cause: dirSyncErr },
      );
    }
    throw dirSyncErr;
  }
  if (dirCloseErr) {
    throw dirCloseErr;
  }
}

export async function queryDatabaseTargetInfo(
  client: PoolClient | Client,
): Promise<DatabaseTargetInfo> {
  const res = await client.query<{ db_name: string; schema_name: string }>(
    "SELECT current_database() as db_name, current_schema() as schema_name;",
  );
  const firstRow = res.rows[0];
  if (!firstRow) {
    throw new Error("Unable to query database name and schema.");
  }
  return {
    name: firstRow.db_name,
    schema: firstRow.schema_name,
  };
}

export async function queryAllMilestonesRaw(
  client: PoolClient | Client,
): Promise<MilestoneDbRawRow[]> {
  const res = await client.query<MilestoneDbRawRow>(`
    SELECT
      id,
      project_id,
      name,
      start_date::text as start_date_raw,
      target_date::text as target_date_raw,
      updated_at::text as updated_at_raw
    FROM milestone
    ORDER BY id ASC;
  `);
  return res.rows;
}

export function printAuditSummary(summary: AuditSummary, mode: NormalizeMode) {
  console.log(
    `\n=== Milestone Calendar Date Audit (${mode.toUpperCase()}) ===`,
  );
  console.log(`Total milestones inspected:      ${summary.totalInspected}`);
  console.log(`Kept null:                       ${summary.totalKeptNull}`);
  console.log(
    `Kept UTC midnight (already OK):  ${summary.totalKeptUtcMidnight}`,
  );
  console.log(`Normalized from non-midnight tz: ${summary.totalNormalized}`);
  console.log(`Overridden via manual flag:      ${summary.totalOverridden}`);
  console.log(
    `Pending confirmation (no tz):    ${summary.totalPendingConfirmation}`,
  );
  console.log(`Invalid date range:              ${summary.totalInvalidRange}`);
  console.log(`Total needing updates:           ${summary.totalNeedsUpdate}`);
  console.log(`Total errors / blocking issues:  ${summary.totalErrors}\n`);

  if (summary.totalErrors > 0) {
    console.error("--- Blocking Issues Found ---");
    for (const r of summary.records) {
      if (r.hasError) {
        if (r.milestoneId === "OVERRIDE_ERROR") {
          console.error(`  - ${r.errorReason}`);
          continue;
        }
        console.error(
          `  - Milestone ${r.milestoneId} ("${r.name}", project: ${r.projectId}):`,
        );
        if (r.startDateAction === "PENDING_CONFIRMATION") {
          console.error(`      startDate: ${r.startDateReason}`);
        }
        if (r.targetDateAction === "PENDING_CONFIRMATION") {
          console.error(`      targetDate: ${r.targetDateReason}`);
        }
        if (r.errorReason) {
          console.error(`      ${r.errorReason}`);
        }
      }
    }
    console.error("");
  }

  const updates = summary.records.filter((r) => r.needsUpdate);
  if (updates.length > 0 && summary.totalErrors === 0) {
    console.log("--- Rows to be updated ---");
    for (const r of updates) {
      const startInfo =
        r.originalStartDate !== r.targetStartDate
          ? `${r.originalStartDate} -> ${r.targetStartDate} (${r.startDateAction})`
          : "unchanged";
      const targetInfo =
        r.originalTargetDate !== r.targetTargetDate
          ? `${r.originalTargetDate} -> ${r.targetTargetDate} (${r.targetDateAction})`
          : "unchanged";
      console.log(
        `  - ${r.milestoneId} ("${r.name}"): startDate: ${startInfo}, targetDate: ${targetInfo}`,
      );
    }
    console.log("");
  }
}

const EXECUTABLE_ACTIONS = [
  "KEPT_NULL",
  "KEPT_UTC_MIDNIGHT",
  "NORMALIZED",
  "OVERRIDDEN",
] as const;

export const manifestRecordZodSchema = z
  .object({
    milestoneId: z.string().min(1, "milestoneId must be non-empty"),
    projectId: z.string().min(1, "projectId must be non-empty"),
    name: z.string(),
    original: z
      .object({
        startDate: z
          .string()
          .refine(
            validateStrictDbTimestamp,
            "original.startDate must be a valid database timestamp (YYYY-MM-DD HH:mm:ss[.uuuuuu]) without timezone suffix",
          )
          .nullable(),
        targetDate: z
          .string()
          .refine(
            validateStrictDbTimestamp,
            "original.targetDate must be a valid database timestamp (YYYY-MM-DD HH:mm:ss[.uuuuuu]) without timezone suffix",
          )
          .nullable(),
        updatedAt: z
          .string()
          .refine(
            validateStrictDbTimestamp,
            "original.updatedAt must be a valid database timestamp (YYYY-MM-DD HH:mm:ss[.uuuuuu]) without timezone suffix",
          ),
      })
      .strict(),
    target: z
      .object({
        startDate: z
          .string()
          .refine(
            validateStrictUtcMidnight,
            "target.startDate must be a valid UTC midnight timestamp (YYYY-MM-DD 00:00:00)",
          )
          .nullable(),
        targetDate: z
          .string()
          .refine(
            validateStrictUtcMidnight,
            "target.targetDate must be a valid UTC midnight timestamp (YYYY-MM-DD 00:00:00)",
          )
          .nullable(),
      })
      .strict(),
    actions: z
      .object({
        startDate: z.enum(EXECUTABLE_ACTIONS),
        targetDate: z.enum(EXECUTABLE_ACTIONS),
      })
      .strict(),
    reasons: z
      .object({
        startDate: z.string().optional(),
        targetDate: z.string().optional(),
      })
      .strict(),
    needsUpdate: z.boolean(),
  })
  .strict();

export const manifestV2ZodSchema = z
  .object({
    version: z.literal(2),
    migrationId: z.string().uuid("migrationId must be a valid UUID"),
    createdAt: z
      .string()
      .refine(
        validateIsoUtcTimestamp,
        "createdAt must be a valid UTC ISO 8601 timestamp string",
      ),
    database: z
      .object({
        name: z.string().min(1, "database.name must be non-empty"),
        schema: z.string().min(1, "database.schema must be non-empty"),
      })
      .strict(),
    rules: z
      .object({
        defaultTimezone: z
          .string()
          .refine(
            isValidTimeZone,
            "defaultTimezone must be a valid IANA timezone",
          )
          .optional(),
        projectTimezones: z.record(
          z.string(),
          z
            .string()
            .refine(
              isValidTimeZone,
              "project timezone value must be a valid IANA timezone",
            ),
        ),
        overrides: z.record(
          z
            .string()
            .regex(
              /^[^.]+\.(startDate|targetDate)$/,
              "override key must match <milestoneId>.<startDate|targetDate>",
            ),
          z
            .string()
            .refine(
              (v) => parseCalendarDateString(v) !== null,
              "override value must be a valid YYYY-MM-DD calendar date",
            ),
        ),
      })
      .strict(),
    summary: z
      .object({
        totalInspected: z.number().int().nonnegative(),
        totalUpdated: z.number().int().nonnegative(),
        totalUnchanged: z.number().int().nonnegative(),
      })
      .strict(),
    records: z.array(manifestRecordZodSchema),
  })
  .strict();

export function validateManifestV2Structure(
  parsed: unknown,
  filePath: string,
): MigrationManifestV2 {
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(
      `Invalid manifest file "${filePath}": root must be an object.`,
    );
  }

  const rawObj = parsed as Record<string, unknown>;
  if (rawObj.version === 1) {
    throw new Error(
      `Manifest "${filePath}" is version 1. Version 1 manifests cannot be automatically applied or rolled back. Please inspect manually or generate a version 2 manifest using --preview --manifest=<new_path>.`,
    );
  }

  const parseResult = manifestV2ZodSchema.safeParse(parsed);
  if (!parseResult.success) {
    const issues = parseResult.error.issues.map((issue) => {
      const pathStr = issue.path.join(".");
      let recordContext = "";
      if (issue.path[0] === "records" && typeof issue.path[1] === "number") {
        const rawRec = (
          parsed as { records?: Array<{ milestoneId?: unknown }> }
        )?.records?.[issue.path[1]];
        if (rawRec && typeof rawRec.milestoneId === "string") {
          recordContext = ` (milestone: "${rawRec.milestoneId}")`;
        }
      }
      return `  - [${pathStr || "root"}]${recordContext}: ${issue.message}`;
    });
    throw new Error(
      `Manifest "${filePath}" validation failed:\n${issues.join("\n")}`,
    );
  }

  const manifest = parseResult.data as MigrationManifestV2;

  // 1. Check duplicate milestone IDs
  const seenIds = new Set<string>();
  for (let i = 0; i < manifest.records.length; i++) {
    const rec = manifest.records[i];
    if (!rec) continue;
    if (seenIds.has(rec.milestoneId)) {
      throw new Error(
        `Manifest "${filePath}" contains duplicate milestoneId "${rec.milestoneId}" at record index ${i}.`,
      );
    }
    seenIds.add(rec.milestoneId);
  }

  // 2. Check override targets exist in records
  for (const overrideKey of Object.keys(manifest.rules.overrides)) {
    const targetMilestoneId = overrideKey.split(".")[0];
    if (!targetMilestoneId || !seenIds.has(targetMilestoneId)) {
      throw new Error(
        `Manifest "${filePath}" rule override "${overrideKey}" targets nonexistent milestoneId "${targetMilestoneId ?? ""}".`,
      );
    }
  }

  // 3. Check target date range: targetStartDate <= targetTargetDate
  for (const rec of manifest.records) {
    if (
      rec.target.startDate &&
      rec.target.targetDate &&
      rec.target.startDate > rec.target.targetDate
    ) {
      throw new Error(
        `Manifest record "${rec.milestoneId}" has invalid target date range: target.startDate (${rec.target.startDate}) cannot be after target.targetDate (${rec.target.targetDate}).`,
      );
    }
  }

  // 4. Recalculate needsUpdate for each record
  for (const rec of manifest.records) {
    const expectedNeedsUpdate =
      rec.original.startDate !== rec.target.startDate ||
      rec.original.targetDate !== rec.target.targetDate;
    if (rec.needsUpdate !== expectedNeedsUpdate) {
      throw new Error(
        `Manifest record "${rec.milestoneId}" has mismatched needsUpdate: manifest states ${rec.needsUpdate}, but calculated value is ${expectedNeedsUpdate}.`,
      );
    }
  }

  // 5. Recalculate summary statistics
  const calculatedInspected = manifest.records.length;
  const calculatedUpdated = manifest.records.filter(
    (r) => r.needsUpdate,
  ).length;
  const calculatedUnchanged = manifest.records.filter(
    (r) => !r.needsUpdate,
  ).length;

  if (manifest.summary.totalInspected !== calculatedInspected) {
    throw new Error(
      `Manifest "${filePath}" summary.totalInspected mismatch: manifest states ${manifest.summary.totalInspected}, but record count is ${calculatedInspected}.`,
    );
  }
  if (manifest.summary.totalUpdated !== calculatedUpdated) {
    throw new Error(
      `Manifest "${filePath}" summary.totalUpdated mismatch: manifest states ${manifest.summary.totalUpdated}, but calculated updated count is ${calculatedUpdated}.`,
    );
  }
  if (manifest.summary.totalUnchanged !== calculatedUnchanged) {
    throw new Error(
      `Manifest "${filePath}" summary.totalUnchanged mismatch: manifest states ${manifest.summary.totalUnchanged}, but calculated unchanged count is ${calculatedUnchanged}.`,
    );
  }

  // 6. Re-run auditMilestoneRow on original values + rules to verify target values and actions
  for (const rec of manifest.records) {
    const reAudited = auditMilestoneRow(
      {
        id: rec.milestoneId,
        project_id: rec.projectId,
        name: rec.name,
        start_date_raw: rec.original.startDate,
        target_date_raw: rec.original.targetDate,
        updated_at_raw: rec.original.updatedAt,
      },
      manifest.rules,
    );

    if (reAudited.hasError) {
      throw new Error(
        `Manifest record "${rec.milestoneId}" failed rule re-audit: ${reAudited.errorReason ?? "unresolved conversion issue"}.`,
      );
    }

    if (reAudited.targetStartDate !== rec.target.startDate) {
      throw new Error(
        `Manifest record "${rec.milestoneId}" target.startDate mismatch: manifest states "${rec.target.startDate}", but rule re-audit produced "${reAudited.targetStartDate}".`,
      );
    }
    if (reAudited.targetTargetDate !== rec.target.targetDate) {
      throw new Error(
        `Manifest record "${rec.milestoneId}" target.targetDate mismatch: manifest states "${rec.target.targetDate}", but rule re-audit produced "${reAudited.targetTargetDate}".`,
      );
    }
    if (reAudited.startDateAction !== rec.actions.startDate) {
      throw new Error(
        `Manifest record "${rec.milestoneId}" actions.startDate mismatch: manifest states "${rec.actions.startDate}", but rule re-audit produced "${reAudited.startDateAction}".`,
      );
    }
    if (reAudited.targetDateAction !== rec.actions.targetDate) {
      throw new Error(
        `Manifest record "${rec.milestoneId}" actions.targetDate mismatch: manifest states "${rec.actions.targetDate}", but rule re-audit produced "${reAudited.targetDateAction}".`,
      );
    }
    if (reAudited.needsUpdate !== rec.needsUpdate) {
      throw new Error(
        `Manifest record "${rec.milestoneId}" needsUpdate mismatch: manifest states ${rec.needsUpdate}, but rule re-audit produced ${reAudited.needsUpdate}.`,
      );
    }
  }

  return manifest;
}

export async function readAndValidateManifestFile(
  manifestPath: string,
): Promise<{ manifest: MigrationManifestV2; content: string; sha256: string }> {
  let content: string;
  try {
    content = await readFile(manifestPath, "utf8");
  } catch (err) {
    throw new Error(
      `Failed to read manifest file at "${manifestPath}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(
      `Failed to parse JSON in manifest "${manifestPath}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const manifest = validateManifestV2Structure(parsed, manifestPath);
  const sha256 = computeSha256(content);
  return { manifest, content, sha256 };
}

export async function executePreview(
  options: NormalizeOptions,
  pool: Pool = getDatabasePool(),
): Promise<{ summary: AuditSummary; manifestCreated: boolean }> {
  const client = await pool.connect();
  let dbInfo: DatabaseTargetInfo;
  let rows: MilestoneDbRawRow[];
  try {
    dbInfo = await queryDatabaseTargetInfo(client);
    rows = await queryAllMilestonesRaw(client);
  } finally {
    client.release();
  }

  const summary = auditAllMilestones(rows, options);
  printAuditSummary(summary, "preview");

  if (!options.manifestPath) {
    console.log(
      "Preview complete. No manifest file specified; no files or database written.\n",
    );
    return { summary, manifestCreated: false };
  }

  if (summary.totalErrors > 0) {
    throw new Error(
      `Cannot generate manifest: found ${summary.totalErrors} blocking issue(s). Resolve all pending confirmations, invalid ranges, or invalid overrides before creating a manifest.`,
    );
  }

  const manifest: MigrationManifestV2 = {
    version: 2,
    migrationId: randomUUID(),
    createdAt: new Date().toISOString(),
    database: dbInfo,
    rules: {
      defaultTimezone: options.defaultTimezone,
      projectTimezones: options.projectTimezones,
      overrides: options.overrides,
    },
    summary: {
      totalInspected: summary.totalInspected,
      totalUpdated: summary.totalNeedsUpdate,
      totalUnchanged: summary.totalInspected - summary.totalNeedsUpdate,
    },
    records: summary.records
      .filter((r) => r.milestoneId !== "OVERRIDE_ERROR")
      .map((r) => ({
        milestoneId: r.milestoneId,
        projectId: r.projectId,
        name: r.name,
        original: {
          startDate: r.originalStartDate,
          targetDate: r.originalTargetDate,
          updatedAt: r.originalUpdatedAt,
        },
        target: {
          startDate: r.targetStartDate,
          targetDate: r.targetTargetDate,
        },
        actions: {
          startDate: r.startDateAction,
          targetDate: r.targetDateAction,
        },
        reasons: {
          startDate: r.startDateReason,
          targetDate: r.targetDateReason,
        },
        needsUpdate: r.needsUpdate,
      })),
  };

  // Validate manifest structure and deep consistency before writing to disk
  validateManifestV2Structure(manifest, options.manifestPath);

  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;

  try {
    await writeExclusiveFile(options.manifestPath, manifestJson);
  } catch (err: unknown) {
    const isExist =
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      err.code === "EEXIST";
    if (isExist) {
      throw new Error(
        `Manifest file already exists at "${options.manifestPath}". Refusing to overwrite existing manifest. Specify a new path or delete the old file.`,
      );
    }
    throw new Error(
      `Failed to write manifest to "${options.manifestPath}": ${err instanceof Error ? err.message : String(err)}. File may be incomplete. Specify a new path and inspect file system.`,
    );
  }

  console.log(
    `✓ Reviewable immutable manifest written to: ${options.manifestPath}`,
  );
  console.log(
    `  Permissions: 0600, Version: 2, Migration ID: ${manifest.migrationId}\n`,
  );

  return { summary, manifestCreated: true };
}

export async function executeApply(
  options: NormalizeOptions,
  pool: Pool = getDatabasePool(),
): Promise<{
  updatedCount: number;
  status: "committed" | "idempotent_no_write";
  receiptPath?: string;
}> {
  if (!options.manifestPath) {
    throw new Error("--manifest=<path> is required for --apply.");
  }

  const { manifest, sha256 } = await readAndValidateManifestFile(
    options.manifestPath,
  );

  const client = await pool.connect();
  let updatedCount = 0;
  let status: "committed" | "idempotent_no_write" = "committed";

  try {
    await client.query("BEGIN;");
    await client.query("SET LOCAL lock_timeout = '5s';");
    await client.query("SET LOCAL statement_timeout = '30s';");
    await client.query("LOCK TABLE milestone IN SHARE ROW EXCLUSIVE MODE;");

    // 1. Verify database target
    const currentDb = await queryDatabaseTargetInfo(client);
    if (
      currentDb.name !== manifest.database.name ||
      currentDb.schema !== manifest.database.schema
    ) {
      throw new Error(
        `Database mismatch: Manifest was created for "${manifest.database.name}.${manifest.database.schema}", but current connection is "${currentDb.name}.${currentDb.schema}".`,
      );
    }

    // 2. Query all milestones with lock held
    const currentRows = await queryAllMilestonesRaw(client);
    const dbMap = new Map(currentRows.map((r) => [r.id, r]));
    const manifestMap = new Map(
      manifest.records.map((r) => [r.milestoneId, r]),
    );

    // Check for added rows
    const addedMilestones: string[] = [];
    for (const row of currentRows) {
      if (!manifestMap.has(row.id)) {
        addedMilestones.push(`${row.id} ("${row.name}")`);
      }
    }
    if (addedMilestones.length > 0) {
      throw new Error(
        `Cannot apply manifest: ${addedMilestones.length} new milestone(s) were added after manifest was generated:\n  ${addedMilestones.join("\n  ")}\nRe-run --preview to generate a fresh manifest.`,
      );
    }

    // Check for deleted rows
    const missingMilestones: string[] = [];
    for (const rec of manifest.records) {
      if (!dbMap.has(rec.milestoneId)) {
        missingMilestones.push(`${rec.milestoneId} ("${rec.name}")`);
      }
    }
    if (missingMilestones.length > 0) {
      throw new Error(
        `Cannot apply manifest: ${missingMilestones.length} milestone(s) from manifest were deleted from the database:\n  ${missingMilestones.join("\n  ")}\nRe-run --preview to generate a fresh manifest.`,
      );
    }

    // Check row state
    const modifiedMilestones: string[] = [];
    let allMatchTarget = true;
    let allMatchOriginal = true;

    for (const rec of manifest.records) {
      const current = dbMap.get(rec.milestoneId);
      if (!current) continue;

      if (current.project_id !== rec.projectId) {
        modifiedMilestones.push(
          `Milestone ${rec.milestoneId} ("${rec.name}") moved project (expected ${rec.projectId}, found ${current.project_id})`,
        );
        continue;
      }

      if (current.updated_at_raw !== rec.original.updatedAt) {
        modifiedMilestones.push(
          `Milestone ${rec.milestoneId} ("${rec.name}") has been edited since manifest was created (original updatedAt: ${rec.original.updatedAt}, current updatedAt: ${current.updated_at_raw})`,
        );
        continue;
      }

      const matchesTarget =
        current.start_date_raw === rec.target.startDate &&
        current.target_date_raw === rec.target.targetDate;

      const matchesOriginal =
        current.start_date_raw === rec.original.startDate &&
        current.target_date_raw === rec.original.targetDate;

      if (!matchesTarget) {
        allMatchTarget = false;
      }
      if (!matchesOriginal) {
        allMatchOriginal = false;
      }

      if (!matchesTarget && !matchesOriginal) {
        modifiedMilestones.push(
          `Milestone ${rec.milestoneId} ("${rec.name}") has unexpected dates (current start: ${current.start_date_raw}, target: ${current.target_date_raw}; expected original start: ${rec.original.startDate}, target: ${rec.original.targetDate})`,
        );
      }
    }

    if (modifiedMilestones.length > 0) {
      throw new Error(
        `Cannot apply manifest: Found ${modifiedMilestones.length} conflicting milestone(s):\n  ${modifiedMilestones.join("\n  ")}\nRollback or re-run --preview.`,
      );
    }

    // Idempotency check: if all rows already match target state
    if (allMatchTarget) {
      console.log(
        "✓ Idempotent success: All milestones in database already match the target migration state. 0 rows written.",
      );
      await client.query("COMMIT;");
      status = "idempotent_no_write";
      updatedCount = 0;
    } else if (allMatchOriginal) {
      // Normal apply: all rows are in pre-migration original state
      const recordsToUpdate = manifest.records.filter((r) => r.needsUpdate);

      for (const rec of recordsToUpdate) {
        const res = await client.query(
          `UPDATE milestone
           SET start_date = $1::timestamp,
               target_date = $2::timestamp
           WHERE id = $3 AND updated_at = $4::timestamp;`,
          [
            rec.target.startDate,
            rec.target.targetDate,
            rec.milestoneId,
            rec.original.updatedAt,
          ],
        );
        if (res.rowCount !== 1) {
          throw new Error(
            `Failed to update milestone ${rec.milestoneId}: row count was ${res.rowCount}, expected 1.`,
          );
        }
      }

      // Final integrity check before commit: verify range & midnight
      const rangeCheck = await client.query(`
        SELECT id, name, start_date::text, target_date::text
        FROM milestone
        WHERE start_date IS NOT NULL AND target_date IS NOT NULL AND start_date > target_date;
      `);
      if (rangeCheck.rows.length > 0) {
        throw new Error(
          `Integrity validation failed: ${rangeCheck.rows.length} milestone(s) have startDate > targetDate after update.`,
        );
      }

      const midnightCheck = await client.query(`
        SELECT id, name, start_date::text, target_date::text
        FROM milestone
        WHERE (start_date IS NOT NULL AND to_char(start_date, 'HH24:MI:SS') != '00:00:00')
           OR (target_date IS NOT NULL AND to_char(target_date, 'HH24:MI:SS') != '00:00:00');
      `);
      if (midnightCheck.rows.length > 0) {
        throw new Error(
          `Integrity validation failed: ${midnightCheck.rows.length} milestone(s) have non-midnight dates after update.`,
        );
      }

      await client.query("COMMIT;");
      updatedCount = recordsToUpdate.length;
      status = "committed";
      console.log(
        `✓ Successfully applied migration: ${updatedCount} milestone(s) normalized in database.`,
      );
    } else {
      throw new Error(
        "Cannot apply manifest: Database is in a mixed state (some milestones match target, while others match original).",
      );
    }
  } catch (err) {
    try {
      await client.query("ROLLBACK;");
    } catch {}
    throw err;
  } finally {
    client.release();
  }

  // Database transaction committed! Now write execution receipt.
  const receiptId = randomUUID();
  const receiptTimestamp = new Date().toISOString();
  const receipt: MigrationReceiptV2 = {
    version: 2,
    receiptId,
    migrationId: manifest.migrationId,
    manifestPath: options.manifestPath,
    manifestSha256: sha256,
    action: "apply",
    timestamp: receiptTimestamp,
    database: manifest.database,
    affectedRows: updatedCount,
    status: "committed",
  };

  const receiptPath = `${options.manifestPath}.receipt.apply.${Date.now()}.${receiptId.slice(0, 8)}.json`;

  try {
    await writeExclusiveFile(
      receiptPath,
      `${JSON.stringify(receipt, null, 2)}\n`,
    );
    console.log(`✓ Execution receipt written to: ${receiptPath}\n`);
  } catch (receiptErr) {
    console.error(
      `\nCRITICAL: Database transaction COMMITTED successfully, but failed to write execution receipt to "${receiptPath}": ${receiptErr instanceof Error ? receiptErr.message : String(receiptErr)}`,
    );
    throw new Error(
      `Database committed but receipt write failed: ${receiptErr instanceof Error ? receiptErr.message : String(receiptErr)}`,
    );
  }

  return { updatedCount, status, receiptPath };
}

export async function executeRollback(
  options: NormalizeOptions,
  pool: Pool = getDatabasePool(),
): Promise<{
  restoredCount: number;
  status: "committed" | "idempotent_no_write";
  receiptPath?: string;
}> {
  if (!options.manifestPath) {
    throw new Error("--manifest=<path> is required for --rollback.");
  }

  const { manifest, sha256 } = await readAndValidateManifestFile(
    options.manifestPath,
  );

  const client = await pool.connect();
  let restoredCount = 0;
  let status: "committed" | "idempotent_no_write" = "committed";

  try {
    await client.query("BEGIN;");
    await client.query("SET LOCAL lock_timeout = '5s';");
    await client.query("SET LOCAL statement_timeout = '30s';");
    await client.query("LOCK TABLE milestone IN SHARE ROW EXCLUSIVE MODE;");

    // 1. Verify database target
    const currentDb = await queryDatabaseTargetInfo(client);
    if (
      currentDb.name !== manifest.database.name ||
      currentDb.schema !== manifest.database.schema
    ) {
      throw new Error(
        `Database mismatch: Manifest was created for "${manifest.database.name}.${manifest.database.schema}", but current connection is "${currentDb.name}.${currentDb.schema}".`,
      );
    }

    // 2. Query all milestones
    const currentRows = await queryAllMilestonesRaw(client);
    const dbMap = new Map(currentRows.map((r) => [r.id, r]));

    // Check if any manifest milestone was deleted
    const deletedMilestones: string[] = [];
    for (const rec of manifest.records) {
      if (!dbMap.has(rec.milestoneId)) {
        deletedMilestones.push(`${rec.milestoneId} ("${rec.name}")`);
      }
    }
    if (deletedMilestones.length > 0) {
      throw new Error(
        `Cannot rollback: ${deletedMilestones.length} milestone(s) from manifest were deleted from the database:\n  ${deletedMilestones.join("\n  ")}\nRollback aborted.`,
      );
    }

    // Report newly added milestones if any
    const manifestIds = new Set(manifest.records.map((r) => r.milestoneId));
    const addedMilestones: string[] = [];
    for (const row of currentRows) {
      if (!manifestIds.has(row.id)) {
        addedMilestones.push(`${row.id} ("${row.name}")`);
      }
    }
    if (addedMilestones.length > 0) {
      console.log(
        `Note: ${addedMilestones.length} milestone(s) were added after migration and will be preserved untouched.`,
      );
    }

    // Verify row integrity
    const modifiedMilestones: string[] = [];
    let allAlreadyOriginal = true;
    let allMatchTarget = true;

    for (const rec of manifest.records) {
      const current = dbMap.get(rec.milestoneId);
      if (!current) continue;

      if (current.project_id !== rec.projectId) {
        modifiedMilestones.push(
          `Milestone ${rec.milestoneId} ("${rec.name}") was moved to project "${current.project_id}" (expected "${rec.projectId}")`,
        );
        continue;
      }

      if (current.updated_at_raw !== rec.original.updatedAt) {
        modifiedMilestones.push(
          `Milestone ${rec.milestoneId} ("${rec.name}") has been edited since migration (updatedAt: ${current.updated_at_raw} vs expected: ${rec.original.updatedAt})`,
        );
        continue;
      }

      const matchesOriginal =
        current.start_date_raw === rec.original.startDate &&
        current.target_date_raw === rec.original.targetDate;

      const matchesTarget =
        current.start_date_raw === rec.target.startDate &&
        current.target_date_raw === rec.target.targetDate;

      if (!matchesOriginal) {
        allAlreadyOriginal = false;
      }
      if (!matchesTarget) {
        allMatchTarget = false;
      }

      if (!matchesOriginal && !matchesTarget) {
        modifiedMilestones.push(
          `Milestone ${rec.milestoneId} ("${rec.name}") dates were modified after migration (current: start=${current.start_date_raw}, target=${current.target_date_raw}; expected target: start=${rec.target.startDate}, target=${rec.target.targetDate})`,
        );
      }
    }

    if (modifiedMilestones.length > 0) {
      throw new Error(
        `Cannot rollback: ${modifiedMilestones.length} milestone(s) were modified after migration:\n  ${modifiedMilestones.join("\n  ")}\nRollback prohibited to prevent overwriting user edits.`,
      );
    }

    if (allAlreadyOriginal) {
      console.log(
        "✓ Idempotent success: All milestones already match the original pre-migration state. No restoration needed.",
      );
      await client.query("COMMIT;");
      status = "idempotent_no_write";
      restoredCount = 0;
    } else if (allMatchTarget) {
      const recordsToRestore = manifest.records.filter((r) => r.needsUpdate);

      for (const rec of recordsToRestore) {
        const res = await client.query(
          `UPDATE milestone
           SET start_date = $1::timestamp,
               target_date = $2::timestamp
           WHERE id = $3 AND updated_at = $4::timestamp;`,
          [
            rec.original.startDate,
            rec.original.targetDate,
            rec.milestoneId,
            rec.original.updatedAt,
          ],
        );
        if (res.rowCount !== 1) {
          throw new Error(
            `Failed to restore milestone ${rec.milestoneId}: row count was ${res.rowCount}, expected 1.`,
          );
        }
      }

      await client.query("COMMIT;");
      restoredCount = recordsToRestore.length;
      status = "committed";
      console.log(
        `✓ Successfully rolled back migration: ${restoredCount} milestone(s) restored to exact original values.`,
      );
    } else {
      throw new Error(
        "Cannot rollback: Database is in a mixed state (some milestones match target, while others match original).",
      );
    }
  } catch (err) {
    try {
      await client.query("ROLLBACK;");
    } catch {}
    throw err;
  } finally {
    client.release();
  }

  // Write rollback execution receipt
  const receiptId = randomUUID();
  const receiptTimestamp = new Date().toISOString();
  const receipt: MigrationReceiptV2 = {
    version: 2,
    receiptId,
    migrationId: manifest.migrationId,
    manifestPath: options.manifestPath,
    manifestSha256: sha256,
    action: "rollback",
    timestamp: receiptTimestamp,
    database: manifest.database,
    affectedRows: restoredCount,
    status: "committed",
  };

  const receiptPath = `${options.manifestPath}.receipt.rollback.${Date.now()}.${receiptId.slice(0, 8)}.json`;

  try {
    await writeExclusiveFile(
      receiptPath,
      `${JSON.stringify(receipt, null, 2)}\n`,
    );
    console.log(`✓ Rollback execution receipt written to: ${receiptPath}\n`);
  } catch (receiptErr) {
    console.error(
      `\nCRITICAL: Database rollback COMMITTED successfully, but failed to write execution receipt to "${receiptPath}": ${receiptErr instanceof Error ? receiptErr.message : String(receiptErr)}`,
    );
    throw new Error(
      `Database rollback committed but receipt write failed: ${receiptErr instanceof Error ? receiptErr.message : String(receiptErr)}`,
    );
  }

  return { restoredCount, status, receiptPath };
}

export type VerifyState =
  | "POST_MIGRATION"
  | "PRE_MIGRATION"
  | "IDEMPOTENT_NOOP"
  | "CONFLICT";

export async function executeVerify(
  options: NormalizeOptions,
  pool: Pool = getDatabasePool(),
): Promise<{
  state: VerifyState;
  details: string[];
}> {
  if (!options.manifestPath) {
    throw new Error("--manifest=<path> is required for --verify.");
  }

  const { manifest } = await readAndValidateManifestFile(options.manifestPath);

  const client = await pool.connect();
  let currentDb: DatabaseTargetInfo;
  let currentRows: MilestoneDbRawRow[];
  try {
    currentDb = await queryDatabaseTargetInfo(client);
    currentRows = await queryAllMilestonesRaw(client);
  } finally {
    client.release();
  }

  console.log("\n=== Milestone Migration Verification ===");
  console.log(`Manifest Path: ${options.manifestPath}`);
  console.log(`Migration ID:  ${manifest.migrationId}`);
  console.log(
    `Database:      ${currentDb.name}.${currentDb.schema} (Manifest target: ${manifest.database.name}.${manifest.database.schema})`,
  );

  const details: string[] = [];

  if (
    currentDb.name !== manifest.database.name ||
    currentDb.schema !== manifest.database.schema
  ) {
    details.push(
      `Database mismatch: Manifest was created for "${manifest.database.name}.${manifest.database.schema}", but current connection is "${currentDb.name}.${currentDb.schema}".`,
    );
    console.error("Status: CONFLICT (Database mismatch)\n");
    return { state: "CONFLICT", details };
  }

  const dbMap = new Map(currentRows.map((r) => [r.id, r]));
  const manifestMap = new Map(manifest.records.map((r) => [r.milestoneId, r]));

  // Check deleted rows
  for (const rec of manifest.records) {
    if (!dbMap.has(rec.milestoneId)) {
      details.push(
        `Deleted milestone: ${rec.milestoneId} ("${rec.name}") was deleted.`,
      );
    }
  }

  // Check added rows
  for (const row of currentRows) {
    if (!manifestMap.has(row.id)) {
      details.push(
        `Added milestone: ${row.id} ("${row.name}") was added after manifest creation.`,
      );
    }
  }

  let matchOriginalCount = 0;
  let matchTargetCount = 0;

  for (const rec of manifest.records) {
    const current = dbMap.get(rec.milestoneId);
    if (!current) continue;

    if (current.project_id !== rec.projectId) {
      details.push(
        `Project mismatch: Milestone ${rec.milestoneId} ("${rec.name}") moved project (${rec.projectId} -> ${current.project_id}).`,
      );
      continue;
    }

    if (current.updated_at_raw !== rec.original.updatedAt) {
      details.push(
        `Edited milestone: Milestone ${rec.milestoneId} ("${rec.name}") was modified (updatedAt changed: ${rec.original.updatedAt} -> ${current.updated_at_raw}).`,
      );
      continue;
    }

    const matchesOriginal =
      current.start_date_raw === rec.original.startDate &&
      current.target_date_raw === rec.original.targetDate;

    const matchesTarget =
      current.start_date_raw === rec.target.startDate &&
      current.target_date_raw === rec.target.targetDate;

    if (matchesOriginal) matchOriginalCount++;
    if (matchesTarget) matchTargetCount++;

    if (!matchesOriginal && !matchesTarget) {
      details.push(
        `Date mismatch: Milestone ${rec.milestoneId} ("${rec.name}") dates modified (current start: ${current.start_date_raw}, target: ${current.target_date_raw}).`,
      );
    }
  }

  const total = manifest.records.length;
  console.log(`Milestones in manifest: ${total}`);
  console.log(`Matching target dates:  ${matchTargetCount}`);
  console.log(`Matching original dates:${matchOriginalCount}`);

  let state: VerifyState = "CONFLICT";

  if (details.length === 0) {
    if (manifest.summary.totalUpdated === 0 && matchTargetCount === total) {
      state = "IDEMPOTENT_NOOP";
      console.log(
        "\nStatus: IDEMPOTENT_READY (0 rows required migration; database is clean).\n",
      );
    } else if (matchTargetCount === total) {
      state = "POST_MIGRATION";
      console.log(
        "\nStatus: POST_MIGRATION (Database is fully converted and matches manifest target state).\n",
      );
    } else if (matchOriginalCount === total) {
      state = "PRE_MIGRATION";
      console.log(
        "\nStatus: PRE_MIGRATION (Database is in original pre-migration state).\n",
      );
    } else {
      state = "CONFLICT";
      console.log("\nStatus: CONFLICT (Database has mixed dates).\n");
    }
  } else {
    // If only added milestones exist, but all manifest records match target, state is POST_MIGRATION with added rows
    const onlyAddedRows = details.every((d) =>
      d.startsWith("Added milestone:"),
    );
    if (onlyAddedRows && matchTargetCount === total) {
      state = "POST_MIGRATION";
      console.log(
        `\nStatus: POST_MIGRATION (Manifest milestones are converted. Note: ${details.length} milestone(s) were added after migration).\n`,
      );
    } else {
      state = "CONFLICT";
      console.error(`\nStatus: CONFLICT (Found ${details.length} issue(s)):\n`);
      for (const d of details) {
        console.error(`  - ${d}`);
      }
      console.error("");
    }
  }

  return { state, details };
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`
Kaneo Milestone Calendar Date Normalization Tool (Version 2)

Usage:
  tsx scripts/normalize-milestone-dates.ts [mode] [options]

Modes:
  --preview (default)                   Audit database. If --manifest is given, writes immutable manifest v2.
  --apply --manifest=<path>             Apply reviewed manifest in a single transaction under table lock.
  --rollback --manifest=<path>          Restore original dates in a single transaction under table lock.
  --verify --manifest=<path>           Read-only verification of database state against manifest.

Options:
  --manifest=<path>                     Path to migration manifest file (required for apply, rollback, verify).
  --timezone=<iana-tz>                  (Preview only) Default historical timezone (e.g. Asia/Shanghai, UTC).
  --project-tz=<id>=<tz>                (Preview only) Project-specific timezone mapping (comma-separated).
  --override=<id>.<field>=<YYYY-MM-DD>  (Preview only) Explicit field override for milestone (startDate | targetDate).
  --help, -h                            Show this help message.

Notice:
  --force is prohibited. The migration tool enforces strict transaction-level consistency.
`);
    return;
  }

  const options = parseNormalizeArgs(argv);

  try {
    if (options.mode === "preview") {
      await executePreview(options);
    } else if (options.mode === "apply") {
      await executeApply(options);
    } else if (options.mode === "rollback") {
      await executeRollback(options);
    } else if (options.mode === "verify") {
      const { state } = await executeVerify(options);
      if (state === "CONFLICT") {
        process.exit(1);
      }
    }
  } finally {
    await getDatabasePool().end();
  }
}

// Auto-run if executed directly via CLI
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  main().catch((err) => {
    console.error(
      `\nError: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  });
}
