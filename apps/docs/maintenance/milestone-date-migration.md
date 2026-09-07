# Milestone Historical Date Migration Runbook

This guide covers the end-to-end operational procedure for normalizing historical milestone date values (`start_date`, `target_date`) in Kaneo.

## 1. Overview & Operational Principles

Historical Kaneo installations stored `milestone.start_date` and `milestone.target_date` as non-standard timestamps with arbitrary time components or timezone offsets. The normalized standard requires these fields to be pure UTC calendar dates formatted at midnight: `YYYY-MM-DD 00:00:00`.

The migration tool (`apps/api/scripts/normalize-milestone-dates.ts` via `pnpm --filter @kaneo/api db:normalize-milestones`) operates under strict safety and concurrency controls:
- **Two-Phase Migration (Preview & Review -> Apply)**: Conversion rules (`--timezone`, `--project-tz`, `--override`) can **only** be executed in `--preview` mode. Applying or rolling back changes requires an immutable, pre-generated manifest file.
- **Microsecond Precision & Zero-Drift**: Database timestamps are handled via raw database text representations (`YYYY-MM-DD HH:mm:ss.uuuuuu`), preventing microsecond precision loss and ensuring round-trip parity on rollback.
- **Audit-State Lock & Idempotency**: During `--apply` and `--rollback`, the table is locked using `LOCK TABLE milestone IN SHARE ROW EXCLUSIVE MODE` with a 5-second lock timeout. Record states (`updated_at`, `start_date`, `target_date`) are validated inside the transaction against the manifest before updating.
- **Preserves Metadata**: The tool updates rows directly with raw SQL, completely bypassing Drizzle's `$onUpdate` hook (leaving `updated_at` untouched) and omitting WebSocket/event broadcasts.
- **Durable Persistence & Audit Receipts**: Every manifest and execution receipt is written with exclusive creation (`wx`, `0600`), flushed to disk with file `fsync()`, and persisted in the parent directory via directory `fsync()`. Database commit and receipt logging are sequential operations, not a two-phase commit (2PC) distributed transaction.

---

## 2. Prerequisites & Pre-Migration Checklist

Before executing any migration against production or staging databases:

1. **Take a Full Database Snapshot / Backup**:
   ```bash
   pg_dump -Fc --no-acl --no-owner -h <host> -U <user> -d <database> -f kaneo_pre_milestone_migration_$(date +%Y%m%d_%H%M%S).dump
   ```
2. **Maintenance Window & Quiesce Write Traffic**:
   - Suspend or set API and MCP services into maintenance mode to eliminate concurrent writes to the `milestone` table.
   - Active user sessions editing milestones during `--apply` will cause transaction rollback if `updated_at` drifts.
3. **Rehearse in an Isolated Staging/Test Environment**:
   - Always rehearse the full preview, apply, verify, and rollback workflow on an isolated staging clone or test database before touching production.
4. **Secure Destination Directory & Filesystem Requirements**:
   - Ensure the manifest destination directory exists and is strictly permissioned (`chmod 0700 <manifest_dir>`).
   - The tool requires a POSIX filesystem supporting directory syncing (e.g. Linux local `ext4`/`xfs`). If the directory sync fails with `EINVAL`, `ENOTSUP`, or `EPERM`, the tool fails closed.
   - Manifest and receipt files are written exclusively (`wx`) with `0600` (`rw-------`) permissions.
   - **Never commit manifest or receipt files to version control.**

---

## 3. Command Reference

### A. Preview & Manifest Generation (`--preview`)

Preview performs a read-only audit of all milestones in the target database.

```bash
# Terminal dry-run preview (no files or DB changes)
pnpm --filter @kaneo/api db:normalize-milestones --preview --timezone=Asia/Shanghai

# Preview and generate immutable manifest v2
pnpm --filter @kaneo/api db:normalize-milestones --preview \
  --manifest=/var/kaneo/migrations/manifest-20260907.json \
  --timezone=Asia/Shanghai \
  --project-tz=prj_abc123=America/New_York \
  --override=mls_xyz789=2026-03-01:2026-03-15
```

**Manifest generation rules:**
- If any milestone has an unresolved ambiguous timestamp (e.g., missing timezone, invalid date range `start_date > target_date`, or override targeting a nonexistent milestone), the command outputs the errors and **refuses to write the manifest**.
- Once generated, the manifest file cannot be overwritten. Passing an existing file path fails immediately with `EEXIST`.

### B. Human Review of Manifest

Inspect the generated manifest file before proceeding:
```bash
cat /var/kaneo/migrations/manifest-20260907.json | jq .summary
```

Check:
1. `version` must be `2`.
2. `database.name` and `database.schema` match your target environment.
3. `summary.actions.convert` corresponds to the expected number of records to be normalized.
4. Review individual overrides and conversions in `records`.

### C. Pre-Apply Verification (`--verify`)

Verify reads the target database under the manifest's rules without mutating any data:

```bash
pnpm --filter @kaneo/api db:normalize-milestones --verify \
  --manifest=/var/kaneo/migrations/manifest-20260907.json
```

Output status for each record:
- `PRE_MIGRATION`: Current database state matches the pre-migration baseline in the manifest. Ready for `--apply`.
- `POST_MIGRATION`: Record is already at the target normalized state.
- `IDEMPOTENT_NOOP`: Record requires no changes.
- `CONFLICT`: Database state differs from manifest baseline (e.g., updated after manifest was generated).

### D. Apply Migration (`--apply`)

Apply applies the transformations strictly recorded in the manifest inside a single atomic transaction:

```bash
pnpm --filter @kaneo/api db:normalize-milestones --apply \
  --manifest=/var/kaneo/migrations/manifest-20260907.json
```

**Execution Behavior:**
1. Verifies manifest integrity and hash.
2. Acquires `LOCK TABLE milestone IN SHARE ROW EXCLUSIVE MODE`.
3. Confirms database schema, milestone count, and record timestamps (`updated_at`, `start_date`, `target_date`) match manifest expectations.
4. Executes atomic updates for records marked `convert`.
5. Verifies constraints (`start_date <= target_date` and pure midnight format `00:00:00`) before committing.
6. Commits transaction.
7. Writes an execution receipt: `/var/kaneo/migrations/manifest-20260907.json.receipt.apply.<timestamp>.<receiptId>.json`.

### E. Post-Apply Verification (`--verify`)

Run verify again to ensure 100% convergence:
```bash
pnpm --filter @kaneo/api db:normalize-milestones --verify \
  --manifest=/var/kaneo/migrations/manifest-20260907.json
```
Expected output: All records show `POST_MIGRATION` or `IDEMPOTENT_NOOP`, with `0 conflicts`.

### F. Rollback (`--rollback`)

If unexpected discrepancies are detected, rollback restores the original historical values from the manifest:

```bash
pnpm --filter @kaneo/api db:normalize-milestones --rollback \
  --manifest=/var/kaneo/migrations/manifest-20260907.json
```

> [!WARNING]
> **Rollback Safety & Drift Protection:**
> - Rollback only succeeds if milestones have not been modified since migration (`updated_at` must remain identical). If any milestone was updated post-migration, rollback will abort and roll back the transaction.
> - Rolling back restores non-standard timestamps. Ensure client applications and APIs are prepared for legacy timestamp formats or remain in maintenance mode until re-migrated.

---

## 4. Failure Modes & Troubleshooting

### Lock Timeout (`5000ms exceeded`)
- **Cause**: Another transaction held a lock on `milestone` (e.g. concurrent user writes or long-running query).
- **Remedy**: Terminate blocking sessions (`SELECT pid, query FROM pg_stat_activity WHERE wait_event_type = 'Lock';`) and retry.

### Row Drift / Audit Invalidation (`Row count mismatch` or `Record ... drifted`)
- **Cause**: A milestone was created, deleted, or updated between manifest generation (`--preview`) and execution (`--apply`).
- **Remedy**: Re-generate the manifest using `--preview --manifest=<new_file>`, review the diff, and re-run.

### Receipt Persistence Failure Post-Commit
- **Cause**: Filesystem permissions, disk full, missing directory sync support, or write collision after database transaction committed.
- **Symptom**: CLI logs `CRITICAL: Database transaction COMMITTED, but failed to write receipt` and exits with code 1.
- **Remedy**: Do **NOT** assume database changes were rolled back. Database commit happened before receipt writing. Run `pnpm --filter @kaneo/api db:normalize-milestones --verify --manifest=<path>` to confirm that milestones were successfully normalized. Re-running `--apply` is idempotent and will not alter dates further. Investigate filesystem disk space, permissions, and directory syncing capabilities.

### Manifest File Collision (`EEXIST: file already exists`)
- **Cause**: Manifest files cannot overwrite existing files.
- **Remedy**: Specify a unique file path containing a timestamp or UUID.

---

## 5. Post-Migration Verification & Service Restoration

1. **Verify Database Consistency**:
   Run verify to confirm zero unnormalized records remain:
   ```bash
   pnpm --filter @kaneo/api db:normalize-milestones --verify --manifest=/var/kaneo/migrations/manifest-20260907.json
   ```
2. **Clear Client Caches & Restore Traffic**:
   - Re-enable API and Web traffic.
   - Instruct active client sessions to reload to populate fresh normalized date objects.
3. **Archive Manifest and Receipt Files**:
   - Move manifest and receipt files to secure long-term backup storage. Do not check into Git repositories.
