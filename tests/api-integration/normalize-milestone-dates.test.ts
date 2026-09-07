import { chmod, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  executeApply,
  executePreview,
  executeRollback,
  executeVerify,
  type MigrationManifestV2,
  type MigrationReceiptV2,
  type NormalizeOptions,
  parseNormalizeArgs,
  writeExclusiveFile,
} from "../../apps/api/scripts/normalize-milestone-dates";
import { getDatabasePool } from "../../apps/api/src/database";
import { resolveDatabaseConnectionString } from "../../apps/api/src/database/resolve-database-url";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

describe("Milestone Historical Date Migration: Integration Tests", () => {
  let testTempDir: string;
  let projectId: string;
  let workspaceId: string;

  beforeAll(async () => {
    testTempDir = await mkdtemp(join(tmpdir(), "kaneo-milestone-norm-int-"));
  });

  afterAll(async () => {
    if (testTempDir) {
      await rm(testTempDir, { recursive: true, force: true });
    }
  });

  beforeEach(async () => {
    await resetTestDatabase();
    const member = await createWorkspaceMember({ role: "admin" });
    workspaceId = member.workspace.id;
    const fixture = await createProjectFixture({ workspaceId });
    projectId = fixture.project.id;
  });

  // Helper to insert milestone with raw timestamps
  async function insertRawMilestone(data: {
    id: string;
    projectId: string;
    name: string;
    description?: string;
    status?: string;
    startDate?: string | null;
    targetDate?: string | null;
    createdAt?: string;
    updatedAt?: string;
  }) {
    const pool = getDatabasePool();
    const client = await pool.connect();
    try {
      await client.query(
        `INSERT INTO milestone (
          id, project_id, name, description, status,
          start_date, target_date, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6::timestamp, $7::timestamp, $8::timestamp, $9::timestamp
        )`,
        [
          data.id,
          data.projectId,
          data.name,
          data.description ?? null,
          data.status ?? "planned",
          data.startDate ?? null,
          data.targetDate ?? null,
          data.createdAt ?? "2026-01-01 00:00:00.000000",
          data.updatedAt ?? "2026-01-01 00:00:00.123456",
        ],
      );
    } finally {
      client.release();
    }
  }

  // Helper to fetch raw strings for a milestone
  async function queryRawMilestone(id: string) {
    const pool = getDatabasePool();
    const client = await pool.connect();
    try {
      const result = await client.query(
        `SELECT
          id,
          project_id,
          name,
          start_date::text as start_date_raw,
          target_date::text as target_date_raw,
          updated_at::text as updated_at_raw
        FROM milestone
        WHERE id = $1`,
        [id],
      );
      return result.rows[0] as
        | {
            id: string;
            project_id: string;
            name: string;
            start_date_raw: string | null;
            target_date_raw: string | null;
            updated_at_raw: string;
          }
        | undefined;
    } finally {
      client.release();
    }
  }

  describe("A. Command Interface & Option Safety", () => {
    it("rejects --force flag immediately", () => {
      expect(() => parseNormalizeArgs(["--force"])).toThrow(
        "--force is prohibited. The migration tool enforces strict safety checks.",
      );
      expect(() =>
        parseNormalizeArgs(["--apply", "--force", "--manifest=test.json"]),
      ).toThrow("--force is prohibited.");
    });

    it("rejects rule flags in apply, rollback, and verify modes", () => {
      expect(() =>
        parseNormalizeArgs([
          "--apply",
          "--manifest=test.json",
          "--timezone=UTC",
        ]),
      ).toThrow("--timezone is only permitted in --preview mode.");

      expect(() =>
        parseNormalizeArgs([
          "--rollback",
          "--manifest=test.json",
          "--project-tz=p1=UTC",
        ]),
      ).toThrow("--project-tz is only permitted in --preview mode.");

      expect(() =>
        parseNormalizeArgs([
          "--verify",
          "--manifest=test.json",
          "--override=m1.startDate=2026-01-01",
        ]),
      ).toThrow("--override is only permitted in --preview mode.");
    });

    it("rejects apply, rollback, and verify when manifest is missing", () => {
      expect(() => parseNormalizeArgs(["--apply"])).toThrow(
        "--manifest=<path> is required for --apply.",
      );
      expect(() => parseNormalizeArgs(["--rollback"])).toThrow(
        "--manifest=<path> is required for --rollback.",
      );
      expect(() => parseNormalizeArgs(["--verify"])).toThrow(
        "--manifest=<path> is required for --verify.",
      );
    });
  });

  describe("B. Preview Mode & Manifest Generation", () => {
    it("runs preview without --manifest as a pure read-only check", async () => {
      await insertRawMilestone({
        id: "mls_preview_1",
        projectId,
        name: "Preview Milestone 1",
        startDate: "2026-03-01 12:34:56.789012",
        targetDate: "2026-03-10 18:00:00.000000",
      });

      const options: NormalizeOptions = {
        mode: "preview",
        defaultTimezone: "Asia/Shanghai",
        projectTimezones: {},
        overrides: {},
      };

      const result = await executePreview(options);
      expect(result.manifestCreated).toBe(false);
      expect(result.summary.totalInspected).toBe(1);
      expect(result.summary.totalErrors).toBe(0);

      // Verify DB row remains completely unchanged
      const raw = await queryRawMilestone("mls_preview_1");
      expect(raw?.start_date_raw).toBe("2026-03-01 12:34:56.789012");
      expect(raw?.target_date_raw).toBe("2026-03-10 18:00:00");
    });

    it("generates immutable manifest v2 with 0600 permissions when 0 errors exist", async () => {
      await insertRawMilestone({
        id: "mls_man_1",
        projectId,
        name: "Milestone for Manifest",
        startDate: "2026-03-01 16:00:00.000000",
        targetDate: "2026-03-10 18:00:00.000000",
        updatedAt: "2026-01-15 08:30:00.654321",
      });

      const manifestPath = join(testTempDir, "valid-manifest.json");
      const options: NormalizeOptions = {
        mode: "preview",
        manifestPath,
        defaultTimezone: "Asia/Shanghai",
        projectTimezones: {},
        overrides: {},
      };

      const result = await executePreview(options);
      expect(result.manifestCreated).toBe(true);
      expect(result.summary.totalErrors).toBe(0);

      // Verify file permissions (0600 -> mode & 0o777 === 0o600)
      const fileStat = await stat(manifestPath);
      expect(fileStat.mode & 0o777).toBe(0o600);

      // Verify manifest content
      const content = JSON.parse(
        await readFile(manifestPath, "utf-8"),
      ) as MigrationManifestV2;
      expect(content.version).toBe(2);
      expect(content.migrationId).toBeDefined();
      expect(content.records).toHaveLength(1);
      expect(content.records[0].milestoneId).toBe("mls_man_1");
      expect(content.records[0].original.updatedAt).toBe(
        "2026-01-15 08:30:00.654321",
      );
      expect(content.records[0].target.startDate).toBe("2026-03-02 00:00:00");
      expect(content.records[0].target.targetDate).toBe("2026-03-11 00:00:00");
      expect(content.records[0].needsUpdate).toBe(true);
    });

    it("refuses to overwrite an existing manifest file (EEXIST)", async () => {
      const manifestPath = join(testTempDir, "collision-manifest.json");
      const options: NormalizeOptions = {
        mode: "preview",
        manifestPath,
        defaultTimezone: "UTC",
        projectTimezones: {},
        overrides: {},
      };

      // First run succeeds
      await executePreview(options);

      // Second run with same path must throw EEXIST
      await expect(executePreview(options)).rejects.toThrow("already exists");
    });

    it("refuses to generate manifest when audit errors exist", async () => {
      // Milestone with ambiguous time and no timezone provided
      await insertRawMilestone({
        id: "mls_err_1",
        projectId,
        name: "Ambiguous Milestone",
        startDate: "2026-03-01 15:30:00.000000",
        targetDate: "2026-03-10 18:00:00.000000",
      });

      const manifestPath = join(testTempDir, "error-manifest.json");
      const options: NormalizeOptions = {
        mode: "preview",
        manifestPath,
        // No timezone provided!
        projectTimezones: {},
        overrides: {},
      };

      await expect(executePreview(options)).rejects.toThrow(
        "Cannot generate manifest: found 1 blocking issue(s)",
      );

      // Ensure manifest file was NOT created
      await expect(stat(manifestPath)).rejects.toThrow();
    });

    it("refuses to generate manifest when override targets nonexistent milestone", async () => {
      const manifestPath = join(testTempDir, "bad-override-manifest.json");
      const options: NormalizeOptions = {
        mode: "preview",
        manifestPath,
        defaultTimezone: "UTC",
        projectTimezones: {},
        overrides: {
          "mls_nonexistent.start": "2026-01-01",
        },
      };

      await expect(executePreview(options)).rejects.toThrow(
        "Cannot generate manifest: found 1 blocking issue(s)",
      );
    });
  });

  describe("C. Apply Migration & Concurrency Safety", () => {
    it("converts mixed records, preserves updated_at, and writes execution receipt", async () => {
      // Record 1: Legacy timestamp needing normalization
      await insertRawMilestone({
        id: "mls_apply_1",
        projectId,
        name: "Legacy Milestone",
        startDate: "2026-03-01 16:00:00.123456",
        targetDate: "2026-03-10 18:00:00.654321",
        updatedAt: "2026-01-10 12:00:00.999999",
      });

      // Record 2: Already UTC midnight
      await insertRawMilestone({
        id: "mls_apply_2",
        projectId,
        name: "Midnight Milestone",
        startDate: "2026-05-01 00:00:00.000000",
        targetDate: "2026-05-15 00:00:00.000000",
        updatedAt: "2026-01-10 12:00:00.888888",
      });

      // Record 3: Null dates
      await insertRawMilestone({
        id: "mls_apply_3",
        projectId,
        name: "Null Milestone",
        startDate: null,
        targetDate: null,
        updatedAt: "2026-01-10 12:00:00.777777",
      });

      const manifestPath = join(testTempDir, "apply-manifest.json");
      await executePreview({
        mode: "preview",
        manifestPath,
        defaultTimezone: "Asia/Shanghai",
        projectTimezones: {},
        overrides: {},
      });

      // Execute apply
      const applyResult = await executeApply({
        mode: "apply",
        manifestPath,
        projectTimezones: {},
        overrides: {},
      });

      expect(applyResult.status).toBe("committed");
      expect(applyResult.updatedCount).toBe(1);
      expect(applyResult.receiptPath).toBeDefined();
      if (!applyResult.receiptPath) {
        throw new Error("applyResult.receiptPath is undefined");
      }

      // Check receipt file permissions and contents
      const receiptStat = await stat(applyResult.receiptPath);
      expect(receiptStat.mode & 0o777).toBe(0o600);

      const receipt = JSON.parse(
        await readFile(applyResult.receiptPath, "utf-8"),
      ) as MigrationReceiptV2;
      expect(receipt.version).toBe(2);
      expect(receipt.action).toBe("apply");
      expect(receipt.affectedRows).toBe(1);
      expect(receipt.manifestSha256).toBeDefined();

      // Verify DB record 1: converted to normalized midnight, updated_at UNTOUCHED!
      const row1 = await queryRawMilestone("mls_apply_1");
      expect(row1?.start_date_raw).toBe("2026-03-02 00:00:00");
      expect(row1?.target_date_raw).toBe("2026-03-11 00:00:00");
      expect(row1?.updated_at_raw).toBe("2026-01-10 12:00:00.999999");

      // Verify DB record 2: unchanged
      const row2 = await queryRawMilestone("mls_apply_2");
      expect(row2?.start_date_raw).toBe("2026-05-01 00:00:00");
      expect(row2?.target_date_raw).toBe("2026-05-15 00:00:00");
      expect(row2?.updated_at_raw).toBe("2026-01-10 12:00:00.888888");

      // Verify DB record 3: null dates unchanged
      const row3 = await queryRawMilestone("mls_apply_3");
      expect(row3?.start_date_raw).toBeNull();
      expect(row3?.target_date_raw).toBeNull();
      expect(row3?.updated_at_raw).toBe("2026-01-10 12:00:00.777777");

      // Running apply again should be an idempotent no-op (0 writes)
      const repeatResult = await executeApply({
        mode: "apply",
        manifestPath,
        projectTimezones: {},
        overrides: {},
      });
      expect(repeatResult.status).toBe("idempotent_no_write");
      expect(repeatResult.updatedCount).toBe(0);
    });

    it("detects drift and aborts atomically when new milestone is inserted after manifest creation", async () => {
      await insertRawMilestone({
        id: "mls_drift_1",
        projectId,
        name: "Existing Milestone",
        startDate: "2026-03-01 16:00:00.000000",
        targetDate: "2026-03-10 18:00:00.000000",
      });

      const manifestPath = join(testTempDir, "insert-drift-manifest.json");
      await executePreview({
        mode: "preview",
        manifestPath,
        defaultTimezone: "UTC",
        projectTimezones: {},
        overrides: {},
      });

      // Insert new milestone out of band
      await insertRawMilestone({
        id: "mls_drift_2",
        projectId,
        name: "Interfering Milestone",
        startDate: "2026-04-01 00:00:00.000000",
        targetDate: "2026-04-10 00:00:00.000000",
      });

      // Apply must fail with new milestone detection
      await expect(
        executeApply({
          mode: "apply",
          manifestPath,
          projectTimezones: {},
          overrides: {},
        }),
      ).rejects.toThrow("new milestone(s) were added");

      // Verify original milestone was NOT updated
      const row1 = await queryRawMilestone("mls_drift_1");
      expect(row1?.start_date_raw).toBe("2026-03-01 16:00:00");
    });

    it("detects drift and aborts atomically when milestone updated_at changes after manifest creation", async () => {
      await insertRawMilestone({
        id: "mls_drift_edit",
        projectId,
        name: "Milestone to Edit",
        startDate: "2026-03-01 16:00:00.000000",
        targetDate: "2026-03-10 18:00:00.000000",
        updatedAt: "2026-01-01 10:00:00.000000",
      });

      const manifestPath = join(testTempDir, "edit-drift-manifest.json");
      await executePreview({
        mode: "preview",
        manifestPath,
        defaultTimezone: "UTC",
        projectTimezones: {},
        overrides: {},
      });

      // Simulate concurrent edit in database updating updated_at
      const pool = getDatabasePool();
      await pool.query(
        `UPDATE milestone SET updated_at = '2026-01-02 12:00:00.000000'::timestamp WHERE id = 'mls_drift_edit'`,
      );

      // Apply must fail with record drift error
      await expect(
        executeApply({
          mode: "apply",
          manifestPath,
          projectTimezones: {},
          overrides: {},
        }),
      ).rejects.toThrow("has been edited since manifest was created");

      // Verify dates were NOT modified
      const row = await queryRawMilestone("mls_drift_edit");
      expect(row?.start_date_raw).toBe("2026-03-01 16:00:00");
    });
  });

  describe("D. Table Locking & Concurrency Protection", () => {
    it("SHARE ROW EXCLUSIVE lock blocks conflicting write transactions while permitting concurrent SELECTs", async () => {
      const connStr = resolveDatabaseConnectionString();
      const lockerClient = new Client({ connectionString: connStr });
      const blockedClient = new Client({ connectionString: connStr });
      const readerClient = new Client({ connectionString: connStr });

      await lockerClient.connect();
      await blockedClient.connect();
      await readerClient.connect();

      try {
        await insertRawMilestone({
          id: "mls_lock_test",
          projectId,
          name: "Lock Test Milestone",
          startDate: "2026-03-01 00:00:00",
          targetDate: "2026-03-10 00:00:00",
        });

        // Locker acquires SHARE ROW EXCLUSIVE lock inside transaction
        await lockerClient.query("BEGIN;");
        await lockerClient.query(
          "LOCK TABLE milestone IN SHARE ROW EXCLUSIVE MODE;",
        );

        // Concurrent reader runs SELECT ACCESS SHARE -> must succeed immediately!
        const readResult = await readerClient.query(
          "SELECT count(*) as count FROM milestone WHERE id = 'mls_lock_test';",
        );
        expect(Number(readResult.rows[0].count)).toBe(1);

        // Conflicting transaction sets 1s lock_timeout and attempts SHARE ROW EXCLUSIVE lock
        await blockedClient.query("BEGIN;");
        await blockedClient.query("SET LOCAL lock_timeout = '1s';");

        // Attempting to lock table should abort with 55P03 (lock timeout)
        let lockTimeoutOccurred = false;
        try {
          await blockedClient.query(
            "LOCK TABLE milestone IN SHARE ROW EXCLUSIVE MODE;",
          );
        } catch (err: unknown) {
          const pgErr = err as { code?: string };
          if (
            pgErr?.code === "55P03" ||
            String(err).includes("canceling statement due to lock timeout")
          ) {
            lockTimeoutOccurred = true;
          }
        }
        expect(lockTimeoutOccurred).toBe(true);
        await blockedClient.query("ROLLBACK;");

        // Locker commits cleanly
        await lockerClient.query("COMMIT;");
      } finally {
        await lockerClient.end();
        await blockedClient.end();
        await readerClient.end();
      }
    });
  });

  describe("E. Rollback Mode & Microsecond Precision", () => {
    it("restores exact historical values and microsecond precision", async () => {
      const originalStart = "2026-03-01 15:30:45.123456";
      const originalTarget = "2026-03-10 18:22:11.654321";
      const originalUpdatedAt = "2026-01-10 10:00:00.789012";

      await insertRawMilestone({
        id: "mls_rollback_1",
        projectId,
        name: "Rollback Test",
        startDate: originalStart,
        targetDate: originalTarget,
        updatedAt: originalUpdatedAt,
      });

      const manifestPath = join(testTempDir, "rollback-manifest.json");
      await executePreview({
        mode: "preview",
        manifestPath,
        defaultTimezone: "Asia/Tokyo",
        projectTimezones: {},
        overrides: {},
      });

      // Apply
      const applyRes = await executeApply({
        mode: "apply",
        manifestPath,
        projectTimezones: {},
        overrides: {},
      });
      expect(applyRes.status).toBe("committed");

      // Verify post-apply values
      const appliedRow = await queryRawMilestone("mls_rollback_1");
      expect(appliedRow?.start_date_raw).toBe("2026-03-02 00:00:00");
      expect(appliedRow?.target_date_raw).toBe("2026-03-11 00:00:00");

      // Rollback
      const rollbackRes = await executeRollback({
        mode: "rollback",
        manifestPath,
        projectTimezones: {},
        overrides: {},
      });
      expect(rollbackRes.status).toBe("committed");
      expect(rollbackRes.restoredCount).toBe(1);
      expect(rollbackRes.receiptPath).toBeDefined();
      if (!rollbackRes.receiptPath) {
        throw new Error("rollbackRes.receiptPath is undefined");
      }

      // Check receipt
      const receipt = JSON.parse(
        await readFile(rollbackRes.receiptPath, "utf-8"),
      ) as MigrationReceiptV2;
      expect(receipt.action).toBe("rollback");
      expect(receipt.affectedRows).toBe(1);

      // Verify restored row has exact microsecond values restored and updated_at preserved!
      const restoredRow = await queryRawMilestone("mls_rollback_1");
      expect(restoredRow?.start_date_raw).toBe(originalStart);
      expect(restoredRow?.target_date_raw).toBe(originalTarget);
      expect(restoredRow?.updated_at_raw).toBe(originalUpdatedAt);

      // Idempotent re-rollback
      const repeatRollback = await executeRollback({
        mode: "rollback",
        manifestPath,
        projectTimezones: {},
        overrides: {},
      });
      expect(repeatRollback.status).toBe("idempotent_no_write");
      expect(repeatRollback.restoredCount).toBe(0);
    });

    it("refuses rollback if record was modified post-migration", async () => {
      await insertRawMilestone({
        id: "mls_post_edit",
        projectId,
        name: "Post Edit Milestone",
        startDate: "2026-03-01 16:00:00.000000",
        targetDate: "2026-03-10 18:00:00.000000",
        updatedAt: "2026-01-01 12:00:00.000000",
      });

      const manifestPath = join(testTempDir, "post-edit-rollback.json");
      await executePreview({
        mode: "preview",
        manifestPath,
        defaultTimezone: "UTC",
        projectTimezones: {},
        overrides: {},
      });

      await executeApply({
        mode: "apply",
        manifestPath,
        projectTimezones: {},
        overrides: {},
      });

      // Simulate post-migration user edit updating updated_at
      const pool = getDatabasePool();
      await pool.query(
        `UPDATE milestone SET updated_at = '2026-02-01 12:00:00.000000'::timestamp WHERE id = 'mls_post_edit'`,
      );

      // Rollback must fail to protect user edit
      await expect(
        executeRollback({
          mode: "rollback",
          manifestPath,
          projectTimezones: {},
          overrides: {},
        }),
      ).rejects.toThrow("has been edited since migration");

      // Verify DB row remains at normalized date, not rolled back
      const row = await queryRawMilestone("mls_post_edit");
      expect(row?.start_date_raw).toBe("2026-03-01 00:00:00");
    });
  });

  describe("F. Verify Mode", () => {
    it("correctly identifies PRE_MIGRATION, POST_MIGRATION, and CONFLICT states", async () => {
      await insertRawMilestone({
        id: "mls_ver_1",
        projectId,
        name: "Verify Milestone 1",
        startDate: "2026-03-01 16:00:00.000000",
        targetDate: "2026-03-10 18:00:00.000000",
      });

      const manifestPath = join(testTempDir, "verify-manifest.json");
      await executePreview({
        mode: "preview",
        manifestPath,
        defaultTimezone: "Asia/Shanghai",
        projectTimezones: {},
        overrides: {},
      });

      // 1. Before apply -> PRE_MIGRATION
      const verifyPre = await executeVerify({
        mode: "verify",
        manifestPath,
        projectTimezones: {},
        overrides: {},
      });
      expect(verifyPre.state).toBe("PRE_MIGRATION");

      // 2. After apply -> POST_MIGRATION
      await executeApply({
        mode: "apply",
        manifestPath,
        projectTimezones: {},
        overrides: {},
      });

      const verifyPost = await executeVerify({
        mode: "verify",
        manifestPath,
        projectTimezones: {},
        overrides: {},
      });
      expect(verifyPost.state).toBe("POST_MIGRATION");

      // 3. Modifying milestone out of band -> CONFLICT
      const pool = getDatabasePool();
      await pool.query(
        `UPDATE milestone SET start_date = '2026-03-05 00:00:00'::timestamp WHERE id = 'mls_ver_1'`,
      );

      const verifyConflict = await executeVerify({
        mode: "verify",
        manifestPath,
        projectTimezones: {},
        overrides: {},
      });
      expect(verifyConflict.state).toBe("CONFLICT");
    });
  });

  describe("G. Post-Commit Receipt Failure Simulation", () => {
    it("reports critical error if receipt write fails after DB commits", async () => {
      const receiptFailDir = join(testTempDir, "readonly-dir");
      await mkdir(receiptFailDir, { recursive: true });

      await insertRawMilestone({
        id: "mls_receipt_fail",
        projectId,
        name: "Receipt Fail Milestone",
        startDate: "2026-03-01 16:00:00.000000",
        targetDate: "2026-03-10 18:00:00.000000",
      });

      const manifestPath = join(receiptFailDir, "manifest.json");
      await executePreview({
        mode: "preview",
        manifestPath,
        defaultTimezone: "Asia/Shanghai",
        projectTimezones: {},
        overrides: {},
      });

      // Make directory read-only so writeExclusiveFile will fail with EACCES
      await chmod(receiptFailDir, 0o500);

      try {
        await expect(
          executeApply({
            mode: "apply",
            manifestPath,
            projectTimezones: {},
            overrides: {},
          }),
        ).rejects.toThrow("Database committed but receipt write failed");

        // Confirm database was indeed updated and committed
        const row = await queryRawMilestone("mls_receipt_fail");
        expect(row?.start_date_raw).toBe("2026-03-02 00:00:00");
      } finally {
        // Restore permissions for cleanup
        await chmod(receiptFailDir, 0o700);
      }

      // Verify documented recovery:
      // 1. Run --verify -> confirms state is POST_MIGRATION
      const verifyRes = await executeVerify({
        mode: "verify",
        manifestPath,
        projectTimezones: {},
        overrides: {},
      });
      expect(verifyRes.state).toBe("POST_MIGRATION");

      // 2. Re-run --apply -> idempotent no-op write, successfully creates receipt
      const retryApply = await executeApply({
        mode: "apply",
        manifestPath,
        projectTimezones: {},
        overrides: {},
      });
      expect(retryApply.status).toBe("idempotent_no_write");
      expect(retryApply.updatedCount).toBe(0);
      expect(retryApply.receiptPath).toBeDefined();
      if (retryApply.receiptPath) {
        const receiptContent = JSON.parse(
          await readFile(retryApply.receiptPath, "utf-8"),
        ) as MigrationReceiptV2;
        expect(receiptContent.action).toBe("apply");
        expect(receiptContent.affectedRows).toBe(0);
      }
    });
  });

  describe("H. Early Manifest Validation Before Database Acquisition", () => {
    it("validates manifest and fails before acquiring database connection in apply, rollback, and verify", async () => {
      const badManifestPath = join(testTempDir, "tampered-manifest.json");
      const badManifest = {
        version: 2,
        migrationId: "not-a-uuid",
        createdAt: "2026-09-07T00:00:00.000Z",
        database: { name: "kaneo_test", schema: "public" },
        rules: { projectTimezones: {}, overrides: {} },
        summary: { totalInspected: 0, totalUpdated: 0, totalUnchanged: 0 },
        records: [],
      };
      await writeExclusiveFile(
        badManifestPath,
        JSON.stringify(badManifest, null, 2),
      );

      const pool = getDatabasePool();
      const connectSpy = vi.spyOn(pool, "connect");

      try {
        // Apply fails before DB connection
        await expect(
          executeApply({
            mode: "apply",
            manifestPath: badManifestPath,
            projectTimezones: {},
            overrides: {},
          }),
        ).rejects.toThrow("migrationId must be a valid UUID");
        expect(connectSpy).not.toHaveBeenCalled();

        // Rollback fails before DB connection
        await expect(
          executeRollback({
            mode: "rollback",
            manifestPath: badManifestPath,
            projectTimezones: {},
            overrides: {},
          }),
        ).rejects.toThrow("migrationId must be a valid UUID");
        expect(connectSpy).not.toHaveBeenCalled();

        // Verify fails before DB connection
        await expect(
          executeVerify({
            mode: "verify",
            manifestPath: badManifestPath,
            projectTimezones: {},
            overrides: {},
          }),
        ).rejects.toThrow("migrationId must be a valid UUID");
        expect(connectSpy).not.toHaveBeenCalled();
      } finally {
        connectSpy.mockRestore();
      }
    });
  });
});
