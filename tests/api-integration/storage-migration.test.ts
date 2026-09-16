import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DRIZZLE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../apps/api/drizzle",
);

// Fixed name: identifiers cannot be parameterised, and a literal keeps the
// statement static instead of assembled from variables.
const SCRATCH_DB = "kaneo_migration_upgrade_test";

type Journal = {
  version: string;
  dialect: string;
  entries: { idx: number; version: string; when: number; tag: string }[];
};

async function readJournal(): Promise<Journal> {
  return JSON.parse(
    await readFile(join(DRIZZLE_DIR, "meta/_journal.json"), "utf8"),
  ) as Journal;
}

/**
 * Builds a migrations folder containing only the migrations before `upTo`, so
 * the migrator stops there. The repository's own history is never rewritten.
 */
async function buildMigrationsFolder(root: string, upTo: string | null) {
  const journal = await readJournal();
  const entries = upTo
    ? journal.entries.filter((entry) => entry.tag < upTo)
    : journal.entries;

  await mkdir(join(root, "meta"), { recursive: true });
  await writeFile(
    join(root, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries }, null, "\t"),
  );

  for (const entry of entries) {
    await writeFile(
      join(root, `${entry.tag}.sql`),
      await readFile(join(DRIZZLE_DIR, `${entry.tag}.sql`)),
    );
  }

  return entries.length;
}

function connectionStringFor(database: string) {
  const url = new URL(process.env.DATABASE_URL ?? "");
  url.pathname = `/${database}`;
  return url.toString();
}

async function withAdminClient<T>(fn: (client: Client) => Promise<T>) {
  const admin = new Client({
    connectionString: connectionStringFor("postgres"),
  });
  await admin.connect();
  try {
    return await fn(admin);
  } finally {
    await admin.end();
  }
}

describe("storage migrations: real upgrade on an isolated database", () => {
  let scratchRoot: string;
  let pool: Pool;
  let migrationsFolder: string;

  beforeAll(async () => {
    scratchRoot = await mkdtemp(join(tmpdir(), "kaneo-migrations-"));
    migrationsFolder = join(scratchRoot, "drizzle");

    await withAdminClient(async (admin) => {
      await admin.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [SCRATCH_DB],
      );
      await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
      await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);
    });

    pool = new Pool({ connectionString: connectionStringFor(SCRATCH_DB) });
  }, 60_000);

  afterAll(async () => {
    await pool?.end().catch(() => {});

    await withAdminClient(async (admin) => {
      await admin.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [SCRATCH_DB],
      );
      await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
    }).catch(() => {});

    await rm(scratchRoot, { recursive: true, force: true });
  });

  it("carries pre-existing S3 and local rows through 0046, 0047, 0048 and 0049 unchanged", async () => {
    const database = drizzle(pool);

    // ---- Stage 1: an installation sitting on the previous schema (up to 0045).
    const applied = await buildMigrationsFolder(migrationsFolder, "0046");
    expect(applied).toBe(46);
    await migrate(database, { migrationsFolder });

    const beforeRecords = await pool.query(
      "SELECT to_regclass('public.asset_upload') AS upload_table",
    );
    expect(beforeRecords.rows[0]?.upload_table).toBeNull();

    await pool.query(
      "INSERT INTO workspace (id, name, slug, created_at) VALUES ($1, $2, $3, now())",
      ["ws-upgrade", "Upgrade", "ws-upgrade"],
    );
    await pool.query(
      "INSERT INTO project (id, workspace_id, slug, name) VALUES ($1, $2, $3, $4)",
      ["pr-upgrade", "ws-upgrade", "pr-upgrade", "Upgrade project"],
    );
    await pool.query(
      "INSERT INTO task (id, project_id, title) VALUES ($1, $2, $3)",
      ["tk-upgrade", "pr-upgrade", "Legacy task"],
    );

    // An old S3 asset, written when the schema had no storage_backend column.
    await pool.query(
      `INSERT INTO asset (id, workspace_id, project_id, task_id, object_key, filename, mime_type, size)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        "as-legacy-s3",
        "ws-upgrade",
        "pr-upgrade",
        "tk-upgrade",
        "legacy/s3.png",
        "s3.png",
        "image/png",
        111,
      ],
    );

    // ---- Stage 2: apply 0046 and confirm the old row was adopted, not lost.
    await buildMigrationsFolder(migrationsFolder, "0047");
    await migrate(database, { migrationsFolder });

    const afterAdoption = await pool.query(
      "SELECT id, storage_backend, filename, size FROM asset ORDER BY id",
    );
    expect(afterAdoption.rows).toEqual([
      {
        id: "as-legacy-s3",
        storage_backend: "s3",
        filename: "s3.png",
        size: 111,
      },
    ]);

    const uploadTableAt0046 = await pool.query(
      "SELECT to_regclass('public.asset_upload') AS upload_table",
    );
    expect(uploadTableAt0046.rows[0]?.upload_table).toBe("asset_upload");

    // ---- Stage 3: local rows exist before 0047 is applied.
    await pool.query(
      `INSERT INTO asset (id, workspace_id, project_id, task_id, object_key, filename, mime_type, size, storage_backend)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        "as-local",
        "ws-upgrade",
        "pr-upgrade",
        "tk-upgrade",
        "legacy/local.png",
        "local.png",
        "image/png",
        222,
        "local",
      ],
    );
    await pool.query(
      `INSERT INTO asset_upload
         (id, token_hash, backend, object_key, filename, mime_type, declared_size, actual_size, sha256, surface, status, workspace_id, project_id, task_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, now() + interval '5 minutes')`,
      [
        "au-unfinished",
        "a".repeat(64),
        "local",
        "legacy/pending.png",
        "pending.png",
        "image/png",
        333,
        333,
        "b".repeat(64),
        "comment",
        "uploaded",
        "ws-upgrade",
        "pr-upgrade",
        "tk-upgrade",
      ],
    );

    const assetsBefore = await pool.query(
      "SELECT id, object_key, filename, mime_type, size, kind, surface, storage_backend FROM asset ORDER BY id",
    );
    const uploadsBefore = await pool.query(
      "SELECT id, backend, object_key, filename, mime_type, declared_size, actual_size, sha256, surface, status FROM asset_upload ORDER BY id",
    );

    const queueBefore = await pool.query(
      "SELECT to_regclass('public.storage_cleanup_queue') AS queue_table",
    );
    expect(queueBefore.rows[0]?.queue_table).toBeNull();

    // ---- Stage 4: apply up to 0048, verify 0048 schema and insert storage setting.
    await buildMigrationsFolder(migrationsFolder, "0049");
    await migrate(database, { migrationsFolder });

    await pool.query(
      "INSERT INTO instance_storage_setting (id, backend, version) VALUES ($1, $2, $3)",
      ["default", "local", 2],
    );

    const settingBefore0049 = await pool.query(
      "SELECT id, backend, version FROM instance_storage_setting WHERE id = 'default'",
    );
    expect(settingBefore0049.rows[0]).toEqual({
      id: "default",
      backend: "local",
      version: 2,
    });

    // ---- Stage 5: apply 0049 and verify existing data, settings, and triggers.
    await buildMigrationsFolder(migrationsFolder, null);
    await migrate(database, { migrationsFolder });

    const assetsAfter = await pool.query(
      "SELECT id, object_key, filename, mime_type, size, kind, surface, storage_backend FROM asset ORDER BY id",
    );
    const uploadsAfter = await pool.query(
      "SELECT id, backend, object_key, filename, mime_type, declared_size, actual_size, sha256, surface, status FROM asset_upload ORDER BY id",
    );
    const settingAfter = await pool.query(
      "SELECT id, backend, version FROM instance_storage_setting WHERE id = 'default'",
    );

    expect(assetsAfter.rows).toEqual(assetsBefore.rows);
    expect(uploadsAfter.rows).toEqual(uploadsBefore.rows);
    expect(settingAfter.rows).toEqual(settingBefore0049.rows);
    expect(assetsAfter.rows).toHaveLength(2);
    expect(
      assetsAfter.rows.find((row) => row.id === "as-legacy-s3")
        ?.storage_backend,
    ).toBe("s3");
    expect(
      assetsAfter.rows.find((row) => row.id === "as-local")?.storage_backend,
    ).toBe("local");

    const queueAfter = await pool.query(
      "SELECT count(*)::int AS queued FROM storage_cleanup_queue",
    );
    // Upgrading must not queue cleanup work by itself.
    expect(queueAfter.rows[0]?.queued).toBe(0);

    // Verify 0049 trigger activates on asset deletion
    await pool.query("DELETE FROM asset WHERE id = 'as-local'");
    const queueAfterDelete = await pool.query(
      "SELECT object_key, backend FROM storage_cleanup_queue WHERE object_key = 'legacy/local.png'",
    );
    expect(queueAfterDelete.rows).toEqual([
      { object_key: "legacy/local.png", backend: "local" },
    ]);
  }, 120_000);

  it("successfully installs all migrations on a completely empty database", async () => {
    const freshDbName = "kaneo_fresh_install_test";
    await withAdminClient(async (admin) => {
      await admin.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [freshDbName],
      );
      await admin.query(`DROP DATABASE IF EXISTS ${freshDbName}`);
      await admin.query(`CREATE DATABASE ${freshDbName}`);
    });

    const freshPool = new Pool({
      connectionString: connectionStringFor(freshDbName),
    });
    try {
      const freshDatabase = drizzle(freshPool);
      await buildMigrationsFolder(migrationsFolder, null);
      await migrate(freshDatabase, { migrationsFolder });

      // Verify essential tables exist
      const tablesResult = await freshPool.query(`
        SELECT table_name FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name IN ('asset', 'asset_upload', 'storage_cleanup_queue', 'instance_storage_setting')
        ORDER BY table_name
      `);
      const tableNames = tablesResult.rows.map((r) => r.table_name);
      expect(tableNames).toEqual([
        "asset",
        "asset_upload",
        "instance_storage_setting",
        "storage_cleanup_queue",
      ]);

      // Verify triggers exist
      const triggersResult = await freshPool.query(`
        SELECT trigger_name FROM information_schema.triggers
        WHERE trigger_name IN ('asset_enqueue_cleanup_trigger', 'asset_upload_enqueue_cleanup_trigger')
        ORDER BY trigger_name
      `);
      expect(triggersResult.rows).toHaveLength(2);
    } finally {
      await freshPool.end().catch(() => {});
      await withAdminClient(async (admin) => {
        await admin.query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
          [freshDbName],
        );
        await admin.query(`DROP DATABASE IF EXISTS ${freshDbName}`);
      }).catch(() => {});
    }
  }, 120_000);
});
