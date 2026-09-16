import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { userHasWorkspacePermission } from "../../apps/api/src/utils/require-workspace-permission";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

const TASK_COUNT = 10;

describe("API integration: local upload concurrency and permission executor", () => {
  let storageRoot: string;

  beforeEach(async () => {
    await resetTestDatabase();
    storageRoot = await mkdtemp(join(tmpdir(), "kaneo-concurrency-"));
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

  async function seedTasks(count: number, role = "admin") {
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
          title: `Concurrent task ${index}`,
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

  async function requestUpload(
    app: ReturnType<typeof createApp>["app"],
    taskId: string,
    size: number,
  ) {
    const response = await app.request(`/api/task/image-upload/${taskId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "concurrent.png",
        contentType: "image/png",
        size,
        surface: "description",
      }),
    });
    expect(response.status).toBe(200);

    return (await response.json()) as {
      key: string;
      uploadUrl: string;
      headers: Record<string, string>;
    };
  }

  it("uploads to ten tasks at once without exhausting the connection pool", async () => {
    const { member, tasks } = await seedTasks(TASK_COUNT);

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    // Identical payloads keep the staging phase aligned, so all ten publish
    // transactions overlap. Each one holds a pooled connection while it
    // re-checks permissions; a permission lookup that reached for a second
    // connection would stall every request until the pool drained.
    const bytes = Buffer.alloc(256 * 1024, 11);

    const uploads = [];
    for (const task of tasks) {
      uploads.push(await requestUpload(app, task.id, bytes.length));
    }

    const started = Date.now();
    const responses = await Promise.all(
      uploads.map((upload) =>
        app.request(upload.uploadUrl, {
          method: "PUT",
          headers: upload.headers,
          body: bytes,
        }),
      ),
    );

    const statuses = responses.map((response) => response.status);
    expect(statuses).toEqual(Array.from({ length: TASK_COUNT }, () => 200));
    expect(Date.now() - started).toBeLessThan(60_000);

    const stored = await db
      .select({ status: schema.assetUploadTable.status })
      .from(schema.assetUploadTable);
    expect(stored).toHaveLength(TASK_COUNT);
    expect(stored.every((row) => row.status === "uploaded")).toBe(true);
  });

  it("keeps repeated concurrent uploads of the same task idempotent", async () => {
    const { member, tasks } = await seedTasks(1);
    const task = tasks[0];

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const bytes = Buffer.alloc(1024, 3);
    const upload = await requestUpload(app, task?.id ?? "", bytes.length);

    const responses = await Promise.all([
      app.request(upload.uploadUrl, {
        method: "PUT",
        headers: upload.headers,
        body: bytes,
      }),
      app.request(upload.uploadUrl, {
        method: "PUT",
        headers: upload.headers,
        body: bytes,
      }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);

    const rows = await db
      .select({ id: schema.assetUploadTable.id })
      .from(schema.assetUploadTable)
      .where(eq(schema.assetUploadTable.objectKey, upload.key));
    expect(rows).toHaveLength(1);
  });

  describe("permission lookups reuse the caller's executor", () => {
    function instrumentedExecutor() {
      let calls = 0;
      const executor = {
        select: ((...args: unknown[]) => {
          calls += 1;
          return (db.select as unknown as (...a: unknown[]) => unknown)(
            ...args,
          );
        }) as unknown as Parameters<
          typeof userHasWorkspacePermission
        >[0]["executor"],
      };

      return { executor, count: () => calls };
    }

    it("sends the instance-admin, member and custom-role lookups through it", async () => {
      const member = await createWorkspaceMember();
      const { executor, count } = instrumentedExecutor();

      const allowed = await userHasWorkspacePermission({
        userId: member.user.id,
        workspaceId: member.workspace.id,
        permissions: { task: ["update"] },
        executor,
      });

      expect(allowed).toBe(true);
      // instance admin + membership + custom role. A lookup that fell back to
      // the global pool would leave this short by one.
      expect(count()).toBe(3);
    });

    it("uses it for a denial too", async () => {
      const member = await createWorkspaceMember();
      await db
        .update(schema.workspaceUserTable)
        .set({ role: "viewer" })
        .where(eq(schema.workspaceUserTable.userId, member.user.id));

      const { executor, count } = instrumentedExecutor();

      const allowed = await userHasWorkspacePermission({
        userId: member.user.id,
        workspaceId: member.workspace.id,
        permissions: { task: ["update"] },
        executor,
      });

      expect(allowed).toBe(false);
      expect(count()).toBe(3);
    });

    it("short-circuits instance admins through it", async () => {
      const member = await createWorkspaceMember();
      await db
        .update(schema.userTable)
        .set({ role: "admin" })
        .where(eq(schema.userTable.id, member.user.id));

      const { executor, count } = instrumentedExecutor();

      const allowed = await userHasWorkspacePermission({
        userId: member.user.id,
        workspaceId: member.workspace.id,
        permissions: { project: ["delete"] },
        executor,
      });

      expect(allowed).toBe(true);
      expect(count()).toBe(1);
    });
  });
});
