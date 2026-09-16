import { mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import {
  enqueueStorageCleanup,
  processStorageCleanupQueue,
} from "../../apps/api/src/storage/cleanup-queue";
import { runStorageMaintenance } from "../../apps/api/src/storage/cleanup-uploads";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

async function pathExists(target: string) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

describe("API integration: storage cleanup queue", () => {
  let storageRoot: string;

  beforeEach(async () => {
    await resetTestDatabase();
    storageRoot = await mkdtemp(join(tmpdir(), "kaneo-cleanup-"));
    process.env.STORAGE_BACKEND = "local";
    process.env.LOCAL_STORAGE_PATH = storageRoot;
    process.env.KANEO_API_URL = "http://localhost:1337";
  });

  afterEach(async () => {
    delete process.env.STORAGE_BACKEND;
    delete process.env.LOCAL_STORAGE_PATH;
    vi.restoreAllMocks();
    await rm(storageRoot, { recursive: true, force: true });
  });

  function objectPath(key: string) {
    return join(storageRoot, ...key.split("/"));
  }

  async function queueRows() {
    return db.select().from(schema.storageCleanupQueueTable);
  }

  async function seedQueuedFile(key: string) {
    const filePath = objectPath(key);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, "queued-bytes");
    await enqueueStorageCleanup(db, [
      { objectKey: key, storageBackend: "local" },
    ]);
    return filePath;
  }

  async function seedWorkspaceWithTasks(count: number, role = "admin") {
    const member = await createWorkspaceMember({ role });
    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });

    const tasks = [];
    for (let index = 1; index <= count; index += 1) {
      const [task] = await db
        .insert(schema.taskTable)
        .values({
          projectId: project.id,
          userId: member.user.id,
          title: `Task ${index}`,
          status: "to-do",
          columnId: columns.todo.id,
          priority: "medium",
          number: index,
          position: index,
        })
        .returning();
      tasks.push(task);
    }

    return { member, project, tasks };
  }

  async function uploadBytes(
    app: ReturnType<typeof createApp>["app"],
    taskId: string,
    bytes: Buffer,
  ) {
    const createResponse = await app.request(
      `/api/task/image-upload/${taskId}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          filename: "queued.png",
          contentType: "image/png",
          size: bytes.length,
          surface: "description",
        }),
      },
    );
    expect(createResponse.status).toBe(200);

    const upload = (await createResponse.json()) as {
      key: string;
      uploadUrl: string;
      headers: Record<string, string>;
    };

    const putResponse = await app.request(upload.uploadUrl, {
      method: "PUT",
      headers: upload.headers,
      body: bytes,
    });
    expect(putResponse.status).toBe(200);

    return upload;
  }

  async function finalizeUpload(
    app: ReturnType<typeof createApp>["app"],
    taskId: string,
    key: string,
    bytes: Buffer,
  ) {
    const finalizeResponse = await app.request(
      `/api/task/image-upload/${taskId}/finalize`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          key,
          filename: "queued.png",
          contentType: "image/png",
          size: bytes.length,
          surface: "description",
        }),
      },
    );
    expect(finalizeResponse.status).toBe(200);
    return (await finalizeResponse.json()) as { id: string };
  }

  it("deletes a queued object and clears its entry", async () => {
    const key = "workspace/w/project/p/task/t/descriptions/queued.png";
    const filePath = await seedQueuedFile(key);

    const result = await processStorageCleanupQueue();

    expect(result).toEqual({ deleted: 1, failed: 0, degraded: false });
    expect(await pathExists(filePath)).toBe(false);
    await expect(queueRows()).resolves.toHaveLength(0);
  });

  it("keeps the entry and records a reason when storage is unavailable", async () => {
    const key = "workspace/w/project/p/task/t/descriptions/unreachable.png";
    const filePath = await seedQueuedFile(key);

    const configuredRoot = process.env.LOCAL_STORAGE_PATH;
    delete process.env.LOCAL_STORAGE_PATH;

    const firstRun = await processStorageCleanupQueue();
    expect(firstRun).toEqual({ deleted: 0, failed: 1, degraded: true });
    expect(await pathExists(filePath)).toBe(true);

    const [pending] = await queueRows();
    expect(pending?.objectKey).toBe(key);
    expect(pending?.lastErrorCode).toBe("StorageUnavailableError");
    expect(pending?.lastAttemptAt).toBeInstanceOf(Date);

    // The entry survives a restart and succeeds once storage is reachable again.
    process.env.LOCAL_STORAGE_PATH = configuredRoot;

    const secondRun = await processStorageCleanupQueue();
    expect(secondRun).toEqual({ deleted: 1, failed: 0, degraded: false });
    expect(await pathExists(filePath)).toBe(false);
    await expect(queueRows()).resolves.toHaveLength(0);
  });

  it("records the same key only once", async () => {
    const ref = {
      objectKey: "workspace/w/project/p/task/t/descriptions/duplicate.png",
      storageBackend: "local",
    };

    await enqueueStorageCleanup(db, [ref, ref]);
    await enqueueStorageCleanup(db, [ref]);

    expect(await queueRows()).toHaveLength(1);
  });

  it("deletes an unfinalized upload queued by a task delete", async () => {
    const { member, tasks } = await seedWorkspaceWithTasks(1);
    const task = tasks[0];

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const upload = await uploadBytes(app, task?.id ?? "", Buffer.alloc(12, 3));
    const filePath = objectPath(upload.key);
    expect(await pathExists(filePath)).toBe(true);

    const deleteResponse = await app.request(`/api/task/${task?.id}`, {
      method: "DELETE",
    });
    expect(deleteResponse.status).toBe(200);

    // A later maintenance pass confirms the queued work is completed.
    const outcome = await runStorageMaintenance();
    expect(outcome.degraded).toBe(false);
    expect(await pathExists(filePath)).toBe(false);
    await expect(queueRows()).resolves.toHaveLength(0);
  });

  it("removes local files for every task in a bulk delete", async () => {
    const { member, tasks } = await seedWorkspaceWithTasks(2);

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const storedPaths: string[] = [];
    for (const task of tasks) {
      const upload = await uploadBytes(app, task?.id ?? "", Buffer.alloc(9, 5));
      storedPaths.push(objectPath(upload.key));
    }

    expect(await Promise.all(storedPaths.map(pathExists))).toEqual([
      true,
      true,
    ]);

    const bulkResponse = await app.request("/api/task/bulk", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        taskIds: tasks.map((task) => task?.id),
        operation: "delete",
      }),
    });
    expect(bulkResponse.status).toBe(200);

    const outcome = await runStorageMaintenance();
    expect(outcome.degraded).toBe(false);
    expect(await Promise.all(storedPaths.map(pathExists))).toEqual([
      false,
      false,
    ]);
    await expect(queueRows()).resolves.toHaveLength(0);
  });

  it("does not queue anything when the bulk delete matches no tasks", async () => {
    const { member } = await seedWorkspaceWithTasks(1);

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const bulkResponse = await app.request("/api/task/bulk", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        taskIds: ["missing-task-id"],
        operation: "delete",
      }),
    });

    expect(bulkResponse.status).toBe(404);
    await expect(queueRows()).resolves.toHaveLength(0);
  });

  it("clears a queued row whose file is already gone", async () => {
    await enqueueStorageCleanup(db, [
      {
        objectKey: "workspace/w/project/p/task/t/descriptions/absent.png",
        storageBackend: "local",
      },
    ]);

    const result = await processStorageCleanupQueue();

    expect(result).toEqual({ deleted: 1, failed: 0, degraded: false });
    await expect(queueRows()).resolves.toHaveLength(0);
  });

  it("keeps the queued record while the storage root is unreachable, then deletes after it returns", async () => {
    const key = "workspace/w/project/p/task/t/descriptions/offline.png";
    const filePath = await seedQueuedFile(key);
    const moved = `${storageRoot}-offline`;

    await rename(storageRoot, moved);

    try {
      const firstRun = await processStorageCleanupQueue();

      expect(firstRun).toEqual({ deleted: 0, failed: 1, degraded: true });

      const [pending] = await queueRows();
      expect(pending?.objectKey).toBe(key);
      expect(pending?.lastErrorCode).toBe("StorageUnavailableError");
      expect(pending?.lastAttemptAt).toBeInstanceOf(Date);

      // The file is not deleted, and it is not reported as already gone.
      expect(await pathExists(join(moved, ...key.split("/")))).toBe(true);
    } finally {
      await rename(moved, storageRoot);
    }

    const secondRun = await processStorageCleanupQueue();

    expect(secondRun).toEqual({ deleted: 1, failed: 0, degraded: false });
    expect(await pathExists(filePath)).toBe(false);
    await expect(queueRows()).resolves.toHaveLength(0);
  });

  it("keeps the queued record when the storage root is not a directory", async () => {
    const key = "workspace/w/project/p/task/t/descriptions/replaced-root.png";
    const filePath = await seedQueuedFile(key);
    const moved = `${storageRoot}-replaced`;

    await rename(storageRoot, moved);
    await writeFile(storageRoot, "not a directory");

    try {
      const result = await processStorageCleanupQueue();

      expect(result.failed).toBe(1);
      expect(await queueRows()).toHaveLength(1);
      expect(await pathExists(join(moved, ...key.split("/")))).toBe(true);
    } finally {
      await rm(storageRoot, { force: true });
      await rename(moved, storageRoot);
    }

    expect(await pathExists(filePath)).toBe(true);
  });

  it("reports maintenance as degraded while a queued delete keeps failing", async () => {
    await enqueueStorageCleanup(db, [
      {
        objectKey: "workspace/w/project/p/task/t/descriptions/gone.png",
        storageBackend: "local",
      },
    ]);

    const configuredRoot = process.env.LOCAL_STORAGE_PATH;
    delete process.env.LOCAL_STORAGE_PATH;

    const outcome = await runStorageMaintenance();
    process.env.LOCAL_STORAGE_PATH = configuredRoot;

    expect(outcome.degraded).toBe(true);
    expect(await queueRows()).toHaveLength(1);
  });

  it("deletes local files when a project is deleted (cascade)", async () => {
    const { member, project, tasks } = await seedWorkspaceWithTasks(1);
    const task = tasks[0];

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const bytes = Buffer.from("project-cascade-delete-test");
    const upload = await uploadBytes(app, task?.id ?? "", bytes);
    await finalizeUpload(app, task?.id ?? "", upload.key, bytes);

    const filePath = objectPath(upload.key);
    expect(await pathExists(filePath)).toBe(true);

    const deleteResponse = await app.request(`/api/project/${project.id}`, {
      method: "DELETE",
    });
    expect(deleteResponse.status).toBe(200);

    const outcome = await runStorageMaintenance();
    expect(outcome.degraded).toBe(false);
    expect(await pathExists(filePath)).toBe(false);
    await expect(queueRows()).resolves.toHaveLength(0);
  });

  it("deletes unfinalized uploads when a project is deleted", async () => {
    const { member, project, tasks } = await seedWorkspaceWithTasks(1);
    const task = tasks[0];

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const bytes = Buffer.from("unfinalized-project-delete");
    const upload = await uploadBytes(app, task?.id ?? "", bytes);
    const filePath = objectPath(upload.key);
    expect(await pathExists(filePath)).toBe(true);

    const deleteResponse = await app.request(`/api/project/${project.id}`, {
      method: "DELETE",
    });
    expect(deleteResponse.status).toBe(200);

    const outcome = await runStorageMaintenance();
    expect(outcome.degraded).toBe(false);
    expect(await pathExists(filePath)).toBe(false);
    await expect(queueRows()).resolves.toHaveLength(0);
  });

  it("deletes local files when a workspace is deleted (cascade)", async () => {
    const { member, tasks } = await seedWorkspaceWithTasks(1);
    const task = tasks[0];

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const bytes = Buffer.from("workspace-cascade-delete-test");
    const upload = await uploadBytes(app, task?.id ?? "", bytes);
    await finalizeUpload(app, task?.id ?? "", upload.key, bytes);

    const filePath = objectPath(upload.key);
    expect(await pathExists(filePath)).toBe(true);

    await db
      .delete(schema.workspaceTable)
      .where(eq(schema.workspaceTable.id, member.workspace.id));

    const outcome = await runStorageMaintenance();
    expect(outcome.degraded).toBe(false);
    expect(await pathExists(filePath)).toBe(false);
    await expect(queueRows()).resolves.toHaveLength(0);
  });

  it("does not delete file when asset_upload is removed if asset still exists, but deletes file when asset is removed", async () => {
    const { member, tasks } = await seedWorkspaceWithTasks(1);
    const task = tasks[0];

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const bytes = Buffer.from("shared-ref-upload-asset-test");
    const upload = await uploadBytes(app, task?.id ?? "", bytes);
    await finalizeUpload(app, task?.id ?? "", upload.key, bytes);

    const filePath = objectPath(upload.key);
    expect(await pathExists(filePath)).toBe(true);

    // Deleting asset_upload record alone while asset exists must NOT queue deletion
    await db
      .delete(schema.assetUploadTable)
      .where(eq(schema.assetUploadTable.objectKey, upload.key));

    expect(await queueRows()).toHaveLength(0);
    expect(await pathExists(filePath)).toBe(true);

    // Deleting formal asset triggers cleanup
    await db
      .delete(schema.assetTable)
      .where(eq(schema.assetTable.objectKey, upload.key));

    expect(await queueRows()).toHaveLength(1);

    const outcome = await runStorageMaintenance();
    expect(outcome.degraded).toBe(false);
    expect(await pathExists(filePath)).toBe(false);
    await expect(queueRows()).resolves.toHaveLength(0);
  });

  it("does not enqueue cleanup or delete files when a transaction is rolled back", async () => {
    const { member, tasks } = await seedWorkspaceWithTasks(1);
    const task = tasks[0];

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const bytes = Buffer.from("rollback-safety-test");
    const upload = await uploadBytes(app, task?.id ?? "", bytes);
    await finalizeUpload(app, task?.id ?? "", upload.key, bytes);

    const filePath = objectPath(upload.key);
    expect(await pathExists(filePath)).toBe(true);

    // Execute deletion inside a transaction that rolls back
    await expect(
      db.transaction(async (tx) => {
        await tx
          .delete(schema.taskTable)
          .where(eq(schema.taskTable.id, task?.id ?? ""));
        throw new Error("Simulated transaction failure");
      }),
    ).rejects.toThrow("Simulated transaction failure");

    // Queue must be empty, and file must still exist
    expect(await queueRows()).toHaveLength(0);
    expect(await pathExists(filePath)).toBe(true);

    const [assetInDb] = await db
      .select()
      .from(schema.assetTable)
      .where(eq(schema.assetTable.objectKey, upload.key));
    expect(assetInDb).toBeDefined();
  });

  it("keeps queued rows when project is deleted during disk failure and succeeds when disk recovers", async () => {
    const { member, project, tasks } = await seedWorkspaceWithTasks(1);
    const task = tasks[0];

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const bytes = Buffer.from("project-delete-disk-failure-test");
    const upload = await uploadBytes(app, task?.id ?? "", bytes);
    await finalizeUpload(app, task?.id ?? "", upload.key, bytes);

    const filePath = objectPath(upload.key);
    expect(await pathExists(filePath)).toBe(true);

    const configuredRoot = process.env.LOCAL_STORAGE_PATH;
    delete process.env.LOCAL_STORAGE_PATH;

    const deleteResponse = await app.request(`/api/project/${project.id}`, {
      method: "DELETE",
    });
    expect(deleteResponse.status).toBe(200);

    const firstRun = await processStorageCleanupQueue();
    expect(firstRun.failed).toBe(1);
    expect(firstRun.degraded).toBe(true);
    expect(await pathExists(filePath)).toBe(true);

    const [pending] = await queueRows();
    expect(pending?.objectKey).toBe(upload.key);
    expect(pending?.lastErrorCode).toBe("StorageUnavailableError");

    process.env.LOCAL_STORAGE_PATH = configuredRoot;
    const secondRun = await processStorageCleanupQueue();
    expect(secondRun.deleted).toBe(1);
    expect(secondRun.degraded).toBe(false);
    expect(await pathExists(filePath)).toBe(false);
    await expect(queueRows()).resolves.toHaveLength(0);
  });
});
