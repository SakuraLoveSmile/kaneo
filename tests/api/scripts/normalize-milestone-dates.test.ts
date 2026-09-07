import type { open } from "node:fs/promises";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  auditAllMilestones,
  auditMilestoneRow,
  computeSha256,
  convertTimestampToCalendarDate,
  getDaysInMonth,
  isLeapYear,
  isUtcMidnightRaw,
  isValidTimeZone,
  parseCalendarDateString,
  parseDbTimestampToUtcInstant,
  parseNormalizeArgs,
  validateIsoUtcTimestamp,
  validateManifestV2Structure,
  validateStrictDbTimestamp,
  validateStrictUtcMidnight,
  writeExclusiveFile,
} from "../../../apps/api/scripts/normalize-milestone-dates";

describe("normalize-milestone-dates unit tests", () => {
  describe("utility functions", () => {
    it("determines leap years accurately", () => {
      // Divisible by 4, not 100
      expect(isLeapYear(2024)).toBe(true);
      expect(isLeapYear(2028)).toBe(true);
      // Divisible by 400
      expect(isLeapYear(2000)).toBe(true);
      expect(isLeapYear(2400)).toBe(true);
      // Divisible by 100 but not 400
      expect(isLeapYear(1900)).toBe(false);
      expect(isLeapYear(2100)).toBe(false);
      // Normal non-leap years
      expect(isLeapYear(2023)).toBe(false);
      expect(isLeapYear(2025)).toBe(false);
      expect(isLeapYear(2026)).toBe(false);
    });

    it("returns correct days in month respecting leap years", () => {
      // 31 days
      for (const m of [1, 3, 5, 7, 8, 10, 12]) {
        expect(getDaysInMonth(2026, m)).toBe(31);
      }
      // 30 days
      for (const m of [4, 6, 9, 11]) {
        expect(getDaysInMonth(2026, m)).toBe(30);
      }
      // February leap vs non-leap
      expect(getDaysInMonth(2024, 2)).toBe(29);
      expect(getDaysInMonth(2000, 2)).toBe(29);
      expect(getDaysInMonth(2023, 2)).toBe(28);
      expect(getDaysInMonth(2100, 2)).toBe(28);
      // Invalid months
      expect(getDaysInMonth(2026, 0)).toBe(0);
      expect(getDaysInMonth(2026, 13)).toBe(0);
    });

    it("strictly validates database timestamps without Date parsing rollover", () => {
      // Valid timestamps
      expect(validateStrictDbTimestamp("2026-09-06 00:00:00")).toBe(true);
      expect(validateStrictDbTimestamp("2026-09-06 23:59:59")).toBe(true);
      expect(validateStrictDbTimestamp("2026-09-06 00:00:00.1")).toBe(true);
      expect(validateStrictDbTimestamp("2026-09-06 00:00:00.123456")).toBe(
        true,
      );
      expect(validateStrictDbTimestamp("2024-02-29 12:00:00")).toBe(true);

      // Invalid dates (calendar math)
      expect(validateStrictDbTimestamp("2023-02-29 00:00:00")).toBe(false);
      expect(validateStrictDbTimestamp("2024-02-30 00:00:00")).toBe(false);
      expect(validateStrictDbTimestamp("2026-04-31 00:00:00")).toBe(false);
      expect(validateStrictDbTimestamp("2026-00-01 00:00:00")).toBe(false);
      expect(validateStrictDbTimestamp("2026-13-01 00:00:00")).toBe(false);
      expect(validateStrictDbTimestamp("2026-01-00 00:00:00")).toBe(false);
      expect(validateStrictDbTimestamp("2026-01-32 00:00:00")).toBe(false);
      expect(validateStrictDbTimestamp("0000-01-01 00:00:00")).toBe(false);

      // Invalid times
      expect(validateStrictDbTimestamp("2026-01-01 24:00:00")).toBe(false);
      expect(validateStrictDbTimestamp("2026-01-01 12:60:00")).toBe(false);
      expect(validateStrictDbTimestamp("2026-01-01 12:00:60")).toBe(false);

      // Invalid precision / suffixes / trailing garbage
      expect(validateStrictDbTimestamp("2026-09-06 00:00:00.1234567")).toBe(
        false,
      );
      expect(validateStrictDbTimestamp("2026-09-06 00:00:00Z")).toBe(false);
      expect(validateStrictDbTimestamp("2026-09-06 00:00:00+08:00")).toBe(
        false,
      );
      expect(validateStrictDbTimestamp("2026-09-06 00:00:00 trailing")).toBe(
        false,
      );
      expect(validateStrictDbTimestamp("")).toBe(false);
      // @ts-expect-error test non-string input
      expect(validateStrictDbTimestamp(null)).toBe(false);
      // @ts-expect-error test non-string input
      expect(validateStrictDbTimestamp(12345)).toBe(false);
    });

    it("strictly validates UTC midnight timestamps", () => {
      expect(validateStrictUtcMidnight("2026-09-06 00:00:00")).toBe(true);
      expect(validateStrictUtcMidnight("2026-09-06 00:00:00.0")).toBe(true);
      expect(validateStrictUtcMidnight("2026-09-06 00:00:00.000")).toBe(true);
      expect(validateStrictUtcMidnight("2026-09-06 00:00:00.000000")).toBe(
        true,
      );

      // Non-midnight
      expect(validateStrictUtcMidnight("2026-09-06 01:00:00")).toBe(false);
      expect(validateStrictUtcMidnight("2026-09-06 00:01:00")).toBe(false);
      expect(validateStrictUtcMidnight("2026-09-06 00:00:01")).toBe(false);
      expect(validateStrictUtcMidnight("2026-09-06 00:00:00.000001")).toBe(
        false,
      );
      expect(validateStrictUtcMidnight("2026-09-06 00:00:00.123456")).toBe(
        false,
      );
      // Invalid date
      expect(validateStrictUtcMidnight("2023-02-29 00:00:00")).toBe(false);
    });

    it("strictly validates ISO UTC timestamps", () => {
      expect(validateIsoUtcTimestamp("2026-09-07T00:00:00.000Z")).toBe(true);
      expect(validateIsoUtcTimestamp("2026-09-07T12:34:56Z")).toBe(true);
      expect(validateIsoUtcTimestamp("2024-02-29T23:59:59.123456Z")).toBe(true);

      // Missing Z / offset
      expect(validateIsoUtcTimestamp("2026-09-07T00:00:00")).toBe(false);
      expect(validateIsoUtcTimestamp("2026-09-07T00:00:00+08:00")).toBe(false);
      expect(validateIsoUtcTimestamp("2026-09-07 00:00:00")).toBe(false);
      // Invalid date
      expect(validateIsoUtcTimestamp("2023-02-29T00:00:00.000Z")).toBe(false);
      expect(validateIsoUtcTimestamp("2026-02-30T00:00:00.000Z")).toBe(false);
    });
    it("validates timezones correctly", () => {
      expect(isValidTimeZone("UTC")).toBe(true);
      expect(isValidTimeZone("Asia/Shanghai")).toBe(true);
      expect(isValidTimeZone("America/New_York")).toBe(true);
      expect(isValidTimeZone("Invalid/Zone_123")).toBe(false);
      expect(isValidTimeZone("")).toBe(false);
    });

    it("identifies UTC midnight raw database timestamps correctly", () => {
      expect(isUtcMidnightRaw("2026-09-06 00:00:00")).toBe(true);
      expect(isUtcMidnightRaw("2026-09-06 00:00:00.000")).toBe(true);
      expect(isUtcMidnightRaw("2026-09-06 00:00:00.000000")).toBe(true);
      expect(isUtcMidnightRaw("2026-09-06 16:00:00")).toBe(false);
      expect(isUtcMidnightRaw("2026-09-06 00:00:01")).toBe(false);
      expect(isUtcMidnightRaw("2026-09-06 00:00:00.000001")).toBe(false);
      expect(isUtcMidnightRaw("2026-09-06 00:00:00.123456")).toBe(false);
      expect(isUtcMidnightRaw(null)).toBe(false);
      expect(isUtcMidnightRaw("")).toBe(false);
    });

    it("parses database raw timestamps to UTC Date accurately", () => {
      const instant = parseDbTimestampToUtcInstant(
        "2026-09-05 16:00:00.123456",
      );
      expect(instant).not.toBeNull();
      expect(instant?.toISOString()).toBe("2026-09-05T16:00:00.123Z");
      expect(instant?.getUTCFullYear()).toBe(2026);
      expect(instant?.getUTCMonth()).toBe(8); // September
      expect(instant?.getUTCDate()).toBe(5);
      expect(instant?.getUTCHours()).toBe(16);

      expect(parseDbTimestampToUtcInstant("invalid")).toBeNull();
    });

    it("parses calendar date strings with strict validation", () => {
      const valid = parseCalendarDateString("2026-09-06");
      expect(valid).not.toBeNull();
      expect(valid?.formatted).toBe("2026-09-06");
      expect(valid?.year).toBe(2026);
      expect(valid?.month).toBe(9);
      expect(valid?.day).toBe(6);

      expect(parseCalendarDateString("2026-02-30")).toBeNull();
      expect(parseCalendarDateString("2026-13-01")).toBeNull();
      expect(parseCalendarDateString("invalid")).toBeNull();
      expect(parseCalendarDateString("2026-09-06extra")).toBeNull();
    });

    it("converts timestamps to calendar dates in specified timezone", () => {
      const ts = new Date("2026-09-05T16:00:00.000Z");

      // In Asia/Shanghai (+08:00): 16:00 + 8h = Sept 6 00:00
      const shanghai = convertTimestampToCalendarDate(ts, "Asia/Shanghai");
      expect(shanghai.formatted).toBe("2026-09-06");
      expect(shanghai.year).toBe(2026);
      expect(shanghai.month).toBe(9);
      expect(shanghai.day).toBe(6);

      // In UTC (+00:00): Sept 5
      const utc = convertTimestampToCalendarDate(ts, "UTC");
      expect(utc.formatted).toBe("2026-09-05");

      // In America/New_York (-04:00 EDT): 16:00 - 4h = 12:00 Sept 5
      const ny = convertTimestampToCalendarDate(ts, "America/New_York");
      expect(ny.formatted).toBe("2026-09-05");
    });

    it("computes deterministic SHA-256 hash", () => {
      const h1 = computeSha256("test-content");
      const h2 = computeSha256("test-content");
      const h3 = computeSha256("other-content");
      expect(h1).toBe(h2);
      expect(h1).not.toBe(h3);
      expect(h1).toHaveLength(64);
    });
  });

  describe("parseNormalizeArgs", () => {
    it("defaults to preview mode with undefined manifest path", () => {
      const opts = parseNormalizeArgs([]);
      expect(opts.mode).toBe("preview");
      expect(opts.manifestPath).toBeUndefined();
      expect(opts.defaultTimezone).toBeUndefined();
      expect(opts.projectTimezones).toEqual({});
      expect(opts.overrides).toEqual({});
    });

    it("parses preview with manifest path", () => {
      const opts = parseNormalizeArgs([
        "--preview",
        "--manifest=/tmp/manifest.json",
      ]);
      expect(opts.mode).toBe("preview");
      expect(opts.manifestPath).toBe("/tmp/manifest.json");
    });

    it("parses --apply, --rollback, and --verify with manifest", () => {
      const applyOpts = parseNormalizeArgs([
        "--apply",
        "--manifest=/tmp/manifest.json",
      ]);
      expect(applyOpts.mode).toBe("apply");
      expect(applyOpts.manifestPath).toBe("/tmp/manifest.json");

      const rollbackOpts = parseNormalizeArgs([
        "--rollback",
        "--manifest=/tmp/manifest.json",
      ]);
      expect(rollbackOpts.mode).toBe("rollback");
      expect(rollbackOpts.manifestPath).toBe("/tmp/manifest.json");

      const verifyOpts = parseNormalizeArgs([
        "--verify",
        "--manifest=/tmp/manifest.json",
      ]);
      expect(verifyOpts.mode).toBe("verify");
      expect(verifyOpts.manifestPath).toBe("/tmp/manifest.json");
    });

    it("strictly prohibits --force", () => {
      expect(() => parseNormalizeArgs(["--force"])).toThrowError(
        /--force is prohibited/,
      );
      expect(() => parseNormalizeArgs(["--apply", "--force"])).toThrowError(
        /--force is prohibited/,
      );
    });

    it("strictly requires --manifest for apply, rollback, and verify", () => {
      expect(() => parseNormalizeArgs(["--apply"])).toThrowError(
        /--manifest=<path> is required for --apply/,
      );
      expect(() => parseNormalizeArgs(["--rollback"])).toThrowError(
        /--manifest=<path> is required for --rollback/,
      );
      expect(() => parseNormalizeArgs(["--verify"])).toThrowError(
        /--manifest=<path> is required for --verify/,
      );
    });

    it("strictly forbids transformation rules on apply, rollback, and verify", () => {
      expect(() =>
        parseNormalizeArgs([
          "--apply",
          "--manifest=/tmp/m.json",
          "--timezone=Asia/Shanghai",
        ]),
      ).toThrowError(/--timezone is only permitted in --preview mode/);

      expect(() =>
        parseNormalizeArgs([
          "--rollback",
          "--manifest=/tmp/m.json",
          "--project-tz=p1=UTC",
        ]),
      ).toThrowError(/--project-tz is only permitted in --preview mode/);

      expect(() =>
        parseNormalizeArgs([
          "--verify",
          "--manifest=/tmp/m.json",
          "--override=m1.startDate=2026-09-01",
        ]),
      ).toThrowError(/--override is only permitted in --preview mode/);
    });

    it("parses --timezone, --project-tz, and --override in preview mode", () => {
      const opts = parseNormalizeArgs([
        "--timezone=Asia/Shanghai",
        "--project-tz=proj_1=UTC,proj_2=America/New_York",
        "--override=m1.startDate=2026-09-01,m1.targetDate=2026-09-10",
      ]);
      expect(opts.defaultTimezone).toBe("Asia/Shanghai");
      expect(opts.projectTimezones).toEqual({
        proj_1: "UTC",
        proj_2: "America/New_York",
      });
      expect(opts.overrides).toEqual({
        "m1.startDate": "2026-09-01",
        "m1.targetDate": "2026-09-10",
      });
    });

    it("throws when combining conflicting modes", () => {
      expect(() => parseNormalizeArgs(["--apply", "--rollback"])).toThrowError(
        /Cannot combine --rollback with --apply/,
      );
      expect(() => parseNormalizeArgs(["--preview", "--apply"])).toThrowError(
        /Cannot combine --apply with --preview/,
      );
    });

    it("throws on unknown options or missing values", () => {
      expect(() => parseNormalizeArgs(["--unknown-flag"])).toThrowError(
        /Unknown option "--unknown-flag"/,
      );
      expect(() => parseNormalizeArgs(["--manifest="])).toThrowError(
        /Missing path in --manifest=<path>/,
      );
      expect(() => parseNormalizeArgs(["--manifest"])).toThrowError(
        /Missing path after --manifest flag/,
      );
      expect(() => parseNormalizeArgs(["--timezone="])).toThrowError(
        /Missing timezone in --timezone=<iana-tz>/,
      );
    });
  });

  describe("validateManifestV2Structure", () => {
    const validManifest = {
      version: 2 as const,
      migrationId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      createdAt: "2026-09-07T00:00:00.000Z",
      database: { name: "kaneo_test", schema: "public" },
      rules: {
        defaultTimezone: "Asia/Shanghai",
        projectTimezones: {},
        overrides: {},
      },
      summary: { totalInspected: 1, totalUpdated: 1, totalUnchanged: 0 },
      records: [
        {
          milestoneId: "m1",
          projectId: "p1",
          name: "M1",
          original: {
            startDate: "2026-09-05 16:00:00",
            targetDate: null,
            updatedAt: "2026-09-01 10:00:00",
          },
          target: {
            startDate: "2026-09-06 00:00:00",
            targetDate: null,
          },
          actions: {
            startDate: "NORMALIZED" as const,
            targetDate: "KEPT_NULL" as const,
          },
          reasons: {
            startDate:
              "Normalized from 2026-09-05 16:00:00 to 2026-09-06 (via Asia/Shanghai)",
            targetDate: "Kept null",
          },
          needsUpdate: true,
        },
      ],
    };

    it("accepts a valid version 2 manifest", () => {
      expect(() =>
        validateManifestV2Structure(validManifest, "/tmp/m.json"),
      ).not.toThrow();
    });

    it("rejects non-object or null root", () => {
      expect(() =>
        validateManifestV2Structure(null, "/tmp/m.json"),
      ).toThrowError(/root must be an object/);
      expect(() =>
        validateManifestV2Structure("string", "/tmp/m.json"),
      ).toThrowError(/root must be an object/);
    });

    it("rejects version 1 manifest with clear manual inspection requirement", () => {
      const v1 = { ...validManifest, version: 1 };
      expect(() => validateManifestV2Structure(v1, "/tmp/m.json")).toThrowError(
        /Manifest "\/tmp\/m\.json" is version 1\. Version 1 manifests cannot be automatically applied/,
      );
    });

    it("rejects version other than 2", () => {
      const v3 = { ...validManifest, version: 3 };
      expect(() => validateManifestV2Structure(v3, "/tmp/m.json")).toThrowError(
        /expected 2/,
      );
    });

    it("rejects invalid migrationId (not UUID)", () => {
      const invalidUuid = { ...validManifest, migrationId: "not-a-uuid-123" };
      expect(() =>
        validateManifestV2Structure(invalidUuid, "/tmp/m.json"),
      ).toThrowError(/migrationId must be a valid UUID/);
    });

    it("rejects empty database name", () => {
      const emptyDb = {
        ...validManifest,
        database: { name: "", schema: "public" },
      };
      expect(() =>
        validateManifestV2Structure(emptyDb, "/tmp/m.json"),
      ).toThrowError(/database\.name must be non-empty/);
    });

    it("rejects invalid timezone in rules", () => {
      const invalidTz = {
        ...validManifest,
        rules: {
          defaultTimezone: "Invalid/Zone",
          projectTimezones: {},
          overrides: {},
        },
      };
      expect(() =>
        validateManifestV2Structure(invalidTz, "/tmp/m.json"),
      ).toThrowError(/defaultTimezone must be a valid IANA timezone/);
    });

    it("rejects unknown fields on root (.strict)", () => {
      const unknownRoot = { ...validManifest, extraRootField: "unexpected" };
      expect(() =>
        validateManifestV2Structure(unknownRoot, "/tmp/m.json"),
      ).toThrowError(/Unrecognized key/);
    });

    it("rejects unknown fields on database (.strict)", () => {
      const unknownDb = {
        ...validManifest,
        database: { ...validManifest.database, host: "localhost" },
      };
      expect(() =>
        validateManifestV2Structure(unknownDb, "/tmp/m.json"),
      ).toThrowError(/Unrecognized key/);
    });

    it("rejects unknown fields on rules (.strict)", () => {
      const unknownRules = {
        ...validManifest,
        rules: { ...validManifest.rules, dryRun: true },
      };
      expect(() =>
        validateManifestV2Structure(unknownRules, "/tmp/m.json"),
      ).toThrowError(/Unrecognized key/);
    });

    it("rejects unknown fields on summary (.strict)", () => {
      const unknownSummary = {
        ...validManifest,
        summary: { ...validManifest.summary, skipped: 0 },
      };
      expect(() =>
        validateManifestV2Structure(unknownSummary, "/tmp/m.json"),
      ).toThrowError(/Unrecognized key/);
    });

    it("rejects unknown fields on records (.strict)", () => {
      const unknownRec = {
        ...validManifest,
        records: [{ ...validManifest.records[0], extraProperty: 123 }],
      };
      expect(() =>
        validateManifestV2Structure(unknownRec, "/tmp/m.json"),
      ).toThrowError(/Unrecognized key/);
    });

    it("rejects unknown fields on original (.strict)", () => {
      const unknownOrig = {
        ...validManifest,
        records: [
          {
            ...validManifest.records[0],
            original: {
              ...validManifest.records[0].original,
              createdAt: "2026-09-01 00:00:00",
            },
          },
        ],
      };
      expect(() =>
        validateManifestV2Structure(unknownOrig, "/tmp/m.json"),
      ).toThrowError(/Unrecognized key/);
    });

    it("rejects unknown fields on target (.strict)", () => {
      const unknownTarget = {
        ...validManifest,
        records: [
          {
            ...validManifest.records[0],
            target: {
              ...validManifest.records[0].target,
              timezone: "UTC",
            },
          },
        ],
      };
      expect(() =>
        validateManifestV2Structure(unknownTarget, "/tmp/m.json"),
      ).toThrowError(/Unrecognized key/);
    });

    it("rejects unknown fields on actions (.strict)", () => {
      const unknownActions = {
        ...validManifest,
        records: [
          {
            ...validManifest.records[0],
            actions: {
              ...validManifest.records[0].actions,
              overallStatus: "done",
            },
          },
        ],
      };
      expect(() =>
        validateManifestV2Structure(unknownActions, "/tmp/m.json"),
      ).toThrowError(/Unrecognized key/);
    });

    it("rejects disallowed actions like PENDING_CONFIRMATION or INVALID_FORMAT", () => {
      const disallowed = {
        ...validManifest,
        records: [
          {
            ...validManifest.records[0],
            actions: {
              startDate: "PENDING_CONFIRMATION",
              targetDate: "KEPT_NULL",
            },
          },
        ],
      };
      expect(() =>
        validateManifestV2Structure(disallowed, "/tmp/m.json"),
      ).toThrowError(
        /expected one of "KEPT_NULL"\|"KEPT_UTC_MIDNIGHT"\|"NORMALIZED"\|"OVERRIDDEN"/,
      );
    });

    it("rejects non-midnight target dates", () => {
      const nonMidnight = {
        ...validManifest,
        records: [
          {
            ...validManifest.records[0],
            target: {
              startDate: "2026-09-06 14:00:00",
              targetDate: null,
            },
          },
        ],
      };
      expect(() =>
        validateManifestV2Structure(nonMidnight, "/tmp/m.json"),
      ).toThrowError(
        /target\.startDate must be a valid UTC midnight timestamp/,
      );
    });

    it("rejects duplicate milestone IDs", () => {
      const dup = {
        ...validManifest,
        records: [
          validManifest.records[0],
          { ...validManifest.records[0], name: "M1 Duplicate" },
        ],
      };
      expect(() =>
        validateManifestV2Structure(dup, "/tmp/m.json"),
      ).toThrowError(/contains duplicate milestoneId "m1"/);
    });

    it("rejects rule overrides targeting nonexistent milestone IDs", () => {
      const invalidOverride = {
        ...validManifest,
        rules: {
          ...validManifest.rules,
          overrides: { "nonexistent_m99.startDate": "2026-09-01" },
        },
      };
      expect(() =>
        validateManifestV2Structure(invalidOverride, "/tmp/m.json"),
      ).toThrowError(/targets nonexistent milestoneId "nonexistent_m99"/);
    });

    it("rejects invalid date range in target dates", () => {
      const invalidRange = {
        ...validManifest,
        records: [
          {
            ...validManifest.records[0],
            target: {
              startDate: "2026-09-10 00:00:00",
              targetDate: "2026-09-05 00:00:00",
            },
          },
        ],
      };
      expect(() =>
        validateManifestV2Structure(invalidRange, "/tmp/m.json"),
      ).toThrowError(/has invalid target date range/);
    });

    it("rejects mismatched needsUpdate flag", () => {
      const tamperedNeedsUpdate = {
        ...validManifest,
        records: [
          {
            ...validManifest.records[0],
            needsUpdate: false, // Actually needs update because original !== target
          },
        ],
      };
      expect(() =>
        validateManifestV2Structure(tamperedNeedsUpdate, "/tmp/m.json"),
      ).toThrowError(
        /has mismatched needsUpdate: manifest states false, but calculated value is true/,
      );
    });

    it("rejects mismatched summary counts", () => {
      const tamperedInspected = {
        ...validManifest,
        summary: { ...validManifest.summary, totalInspected: 99 },
      };
      expect(() =>
        validateManifestV2Structure(tamperedInspected, "/tmp/m.json"),
      ).toThrowError(/summary\.totalInspected mismatch/);

      const tamperedUpdated = {
        ...validManifest,
        summary: { ...validManifest.summary, totalUpdated: 0 },
      };
      expect(() =>
        validateManifestV2Structure(tamperedUpdated, "/tmp/m.json"),
      ).toThrowError(/summary\.totalUpdated mismatch/);

      const tamperedUnchanged = {
        ...validManifest,
        summary: { ...validManifest.summary, totalUnchanged: 5 },
      };
      expect(() =>
        validateManifestV2Structure(tamperedUnchanged, "/tmp/m.json"),
      ).toThrowError(/summary\.totalUnchanged mismatch/);
    });

    it("rejects tampered target dates failing rule re-audit", () => {
      const tamperedTarget = {
        ...validManifest,
        records: [
          {
            ...validManifest.records[0],
            target: {
              startDate: "2026-09-07 00:00:00", // Rule re-audit produces 2026-09-06 00:00:00
              targetDate: null,
            },
          },
        ],
      };
      expect(() =>
        validateManifestV2Structure(tamperedTarget, "/tmp/m.json"),
      ).toThrowError(
        /target\.startDate mismatch.*rule re-audit produced "2026-09-06 00:00:00"/,
      );
    });

    it("rejects tampered actions failing rule re-audit", () => {
      const tamperedAction = {
        ...validManifest,
        records: [
          {
            ...validManifest.records[0],
            actions: {
              startDate: "OVERRIDDEN" as const, // Rule re-audit produces NORMALIZED
              targetDate: "KEPT_NULL" as const,
            },
          },
        ],
      };
      expect(() =>
        validateManifestV2Structure(tamperedAction, "/tmp/m.json"),
      ).toThrowError(
        /actions\.startDate mismatch.*rule re-audit produced "NORMALIZED"/,
      );
    });
  });

  describe("writeExclusiveFile", () => {
    it("creates a new file with 0o600 permissions and durable fsyncs", async () => {
      const dir = await mkdtemp(join(tmpdir(), "kaneo-write-exclusive-"));
      try {
        const testFile = join(dir, "manifest.json");
        await writeExclusiveFile(testFile, '{"test":true}');

        const content = await readFile(testFile, "utf8");
        expect(content).toBe('{"test":true}');

        const stats = await stat(testFile);
        expect(stats.mode & 0o777).toBe(0o600);

        // Exclusive write must refuse to overwrite existing file
        await expect(
          writeExclusiveFile(testFile, '{"test":false}'),
        ).rejects.toThrow();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("closes file handle and propagates error on write failure", async () => {
      const mockFileHandle = {
        writeFile: vi.fn().mockRejectedValue(new Error("disk full")),
        sync: vi.fn(),
        close: vi.fn().mockResolvedValue(undefined),
      };
      const mockOpen = vi.fn().mockResolvedValueOnce(mockFileHandle);

      await expect(
        writeExclusiveFile(
          "/tmp/test-write-fail.json",
          "content",
          mockOpen as unknown as typeof open,
        ),
      ).rejects.toThrow("disk full");
      expect(mockFileHandle.close).toHaveBeenCalledTimes(1);
    });

    it("preserves primary error and includes secondary error if handle close throws", async () => {
      const mockFileHandle = {
        writeFile: vi.fn().mockRejectedValue(new Error("io error on write")),
        sync: vi.fn(),
        close: vi.fn().mockRejectedValue(new Error("error on close handle")),
      };
      const mockOpen = vi.fn().mockResolvedValueOnce(mockFileHandle);

      await expect(
        writeExclusiveFile(
          "/tmp/test-close-fail.json",
          "content",
          mockOpen as unknown as typeof open,
        ),
      ).rejects.toThrowError(
        /Failed writing\/syncing file.*io error on write.*Secondary error closing file handle: error on close handle/,
      );
      expect(mockFileHandle.close).toHaveBeenCalledTimes(1);
    });

    it("fails closed if parent directory sync fails", async () => {
      const mockFileHandle = {
        writeFile: vi.fn().mockResolvedValue(undefined),
        sync: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      };
      const mockDirHandle = {
        sync: vi
          .fn()
          .mockRejectedValue(new Error("dir sync not supported on filesystem")),
        close: vi.fn().mockResolvedValue(undefined),
      };
      const mockOpen = vi
        .fn()
        .mockResolvedValueOnce(mockFileHandle)
        .mockResolvedValueOnce(mockDirHandle);

      await expect(
        writeExclusiveFile(
          "/tmp/test-dir-sync.json",
          "content",
          mockOpen as unknown as typeof open,
        ),
      ).rejects.toThrow("dir sync not supported on filesystem");
      expect(mockFileHandle.close).toHaveBeenCalledTimes(1);
      expect(mockDirHandle.close).toHaveBeenCalledTimes(1);
    });
  });

  describe("auditMilestoneRow", () => {
    const emptyOptions = {
      projectTimezones: {},
      overrides: {},
    };

    it("keeps null dates as KEPT_NULL", () => {
      const record = auditMilestoneRow(
        {
          id: "m1",
          project_id: "p1",
          name: "Milestone 1",
          start_date_raw: null,
          target_date_raw: null,
          updated_at_raw: "2026-09-01 10:00:00",
        },
        emptyOptions,
      );

      expect(record.startDateAction).toBe("KEPT_NULL");
      expect(record.targetDateAction).toBe("KEPT_NULL");
      expect(record.targetStartDate).toBeNull();
      expect(record.targetTargetDate).toBeNull();
      expect(record.hasError).toBe(false);
      expect(record.needsUpdate).toBe(false);
    });

    it("keeps UTC midnight dates as KEPT_UTC_MIDNIGHT", () => {
      const record = auditMilestoneRow(
        {
          id: "m1",
          project_id: "p1",
          name: "Milestone 1",
          start_date_raw: "2026-09-01 00:00:00",
          target_date_raw: "2026-09-10 00:00:00",
          updated_at_raw: "2026-09-01 10:00:00",
        },
        emptyOptions,
      );

      expect(record.startDateAction).toBe("KEPT_UTC_MIDNIGHT");
      expect(record.targetDateAction).toBe("KEPT_UTC_MIDNIGHT");
      expect(record.hasError).toBe(false);
      expect(record.needsUpdate).toBe(false);
    });

    it("flags non-midnight timestamp as PENDING_CONFIRMATION when no timezone provided", () => {
      const record = auditMilestoneRow(
        {
          id: "m1",
          project_id: "p1",
          name: "Milestone 1",
          start_date_raw: "2026-09-05 16:00:00.123456",
          target_date_raw: null,
          updated_at_raw: "2026-09-01 10:00:00",
        },
        emptyOptions,
      );

      expect(record.startDateAction).toBe("PENDING_CONFIRMATION");
      expect(record.targetDateAction).toBe("KEPT_NULL");
      expect(record.hasError).toBe(true);
      expect(record.needsUpdate).toBe(false);
    });

    it("normalizes non-midnight timestamps with microsecond precision when timezone is provided", () => {
      const record = auditMilestoneRow(
        {
          id: "m1",
          project_id: "p1",
          name: "Milestone 1",
          start_date_raw: "2026-09-05 16:00:00.123456",
          target_date_raw: "2026-09-09 16:00:00.654321",
          updated_at_raw: "2026-09-01 10:00:00.000000",
        },
        {
          defaultTimezone: "Asia/Shanghai",
          projectTimezones: {},
          overrides: {},
        },
      );

      expect(record.startDateAction).toBe("NORMALIZED");
      expect(record.targetDateAction).toBe("NORMALIZED");
      expect(record.hasError).toBe(false);
      expect(record.needsUpdate).toBe(true);
      expect(record.targetStartDate).toBe("2026-09-06 00:00:00");
      expect(record.targetTargetDate).toBe("2026-09-10 00:00:00");
    });

    it("prefers project-specific timezone over default timezone", () => {
      const record = auditMilestoneRow(
        {
          id: "m1",
          project_id: "project_us",
          name: "US Project Milestone",
          start_date_raw: "2026-09-05 16:00:00",
          target_date_raw: null,
          updated_at_raw: "2026-09-01 10:00:00",
        },
        {
          defaultTimezone: "Asia/Shanghai",
          projectTimezones: { project_us: "America/New_York" },
          overrides: {},
        },
      );

      expect(record.startDateAction).toBe("NORMALIZED");
      // America/New_York: 16:00 UTC - 4h = 12:00 Sept 5
      expect(record.targetStartDate).toBe("2026-09-05 00:00:00");
    });

    it("applies manual overrides regardless of existing timestamp", () => {
      const record = auditMilestoneRow(
        {
          id: "m1",
          project_id: "p1",
          name: "Milestone 1",
          start_date_raw: "2026-09-05 16:00:00",
          target_date_raw: "2026-09-10 00:00:00",
          updated_at_raw: "2026-09-01 10:00:00",
        },
        {
          defaultTimezone: "Asia/Shanghai",
          projectTimezones: {},
          overrides: { "m1.startDate": "2026-09-01" },
        },
      );

      expect(record.startDateAction).toBe("OVERRIDDEN");
      expect(record.targetStartDate).toBe("2026-09-01 00:00:00");
      expect(record.targetDateAction).toBe("KEPT_UTC_MIDNIGHT");
      expect(record.needsUpdate).toBe(true);
    });

    it("detects invalid date range (startDate > targetDate)", () => {
      const record = auditMilestoneRow(
        {
          id: "m1",
          project_id: "p1",
          name: "Milestone 1",
          start_date_raw: "2026-09-10 00:00:00",
          target_date_raw: "2026-09-05 00:00:00",
          updated_at_raw: "2026-09-01 10:00:00",
        },
        emptyOptions,
      );

      expect(record.hasError).toBe(true);
      expect(record.errorReason).toContain("INVALID_RANGE");
      expect(record.needsUpdate).toBe(false);
    });
  });

  describe("auditAllMilestones", () => {
    it("detects invalid override targets pointing to nonexistent milestones", () => {
      const rows = [
        {
          id: "m1",
          project_id: "p1",
          name: "M1",
          start_date_raw: null,
          target_date_raw: null,
          updated_at_raw: "2026-09-01 10:00:00",
        },
      ];

      const summary = auditAllMilestones(rows, {
        projectTimezones: {},
        overrides: { "nonexistent_m2.startDate": "2026-09-01" },
      });

      expect(summary.totalErrors).toBeGreaterThan(0);
      expect(
        summary.records.some((r) => r.errorReason?.includes("nonexistent_m2")),
      ).toBe(true);
    });

    it("summarizes counts accurately", () => {
      const rows = [
        {
          id: "m1",
          project_id: "p1",
          name: "Nulls",
          start_date_raw: null,
          target_date_raw: null,
          updated_at_raw: "2026-09-01 10:00:00",
        },
        {
          id: "m2",
          project_id: "p1",
          name: "Already Midnight",
          start_date_raw: "2026-09-01 00:00:00",
          target_date_raw: "2026-09-10 00:00:00",
          updated_at_raw: "2026-09-01 10:00:00",
        },
        {
          id: "m3",
          project_id: "p1",
          name: "Needs Normalize",
          start_date_raw: "2026-09-05 16:00:00",
          target_date_raw: null,
          updated_at_raw: "2026-09-01 10:00:00",
        },
      ];

      const summaryWithoutTz = auditAllMilestones(rows, {
        projectTimezones: {},
        overrides: {},
      });
      expect(summaryWithoutTz.totalInspected).toBe(3);
      expect(summaryWithoutTz.totalKeptNull).toBe(1);
      expect(summaryWithoutTz.totalKeptUtcMidnight).toBe(1);
      expect(summaryWithoutTz.totalPendingConfirmation).toBe(1);
      expect(summaryWithoutTz.totalErrors).toBe(1);
      expect(summaryWithoutTz.totalNeedsUpdate).toBe(0);

      const summaryWithTz = auditAllMilestones(rows, {
        defaultTimezone: "Asia/Shanghai",
        projectTimezones: {},
        overrides: {},
      });
      expect(summaryWithTz.totalPendingConfirmation).toBe(0);
      expect(summaryWithTz.totalNormalized).toBe(1);
      expect(summaryWithTz.totalErrors).toBe(0);
      expect(summaryWithTz.totalNeedsUpdate).toBe(1);
    });
  });
});
