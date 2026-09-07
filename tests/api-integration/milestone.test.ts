import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Client } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

function hashApiKeyForTest(value: string) {
  return createHash("sha256").update(value).digest("base64url");
}

async function createMilestoneRequest(
  app: ReturnType<typeof createApp>["app"],
  projectId: string,
  body: Record<string, unknown> = {},
) {
  return app.request(`/api/milestone/project/${projectId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Milestone", ...body }),
  });
}

async function createTaskRequest(
  app: ReturnType<typeof createApp>["app"],
  projectId: string,
  body: Record<string, unknown> = {},
) {
  return app.request(`/api/task/${projectId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "Task",
      description: "",
      priority: "low",
      status: "to-do",
      ...body,
    }),
  });
}

describe("API integration: milestones", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("runs the CRUD happy path", async () => {
    const member = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const createResponse = await createMilestoneRequest(app, project.id, {
      name: "v1.0",
      description: "First release",
      status: "active",
      startDate: "2025-01-01",
      targetDate: "2025-02-01",
    });
    expect(createResponse.status).toBe(200);
    const created = (await createResponse.json()) as {
      id: string;
      projectId: string;
      name: string;
      status: string;
    };
    expect(created).toMatchObject({
      projectId: project.id,
      name: "v1.0",
      status: "active",
    });

    const listResponse = await app.request(
      `/api/milestone/project/${project.id}`,
    );
    expect(listResponse.status).toBe(200);
    const listed = (await listResponse.json()) as { id: string }[];
    expect(listed.map((m) => m.id)).toContain(created.id);

    const getResponse = await app.request(`/api/milestone/${created.id}`);
    expect(getResponse.status).toBe(200);
    expect(await getResponse.json()).toMatchObject({ id: created.id });

    const updateResponse = await app.request(`/api/milestone/${created.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "v1.1", status: "completed" }),
    });
    expect(updateResponse.status).toBe(200);
    expect(await updateResponse.json()).toMatchObject({
      id: created.id,
      name: "v1.1",
      status: "completed",
    });

    const deleteResponse = await app.request(`/api/milestone/${created.id}`, {
      method: "DELETE",
    });
    expect(deleteResponse.status).toBe(200);

    const afterDelete = await app.request(`/api/milestone/${created.id}`);
    // The workspace lookup runs before the handler, so a missing milestone
    // surfaces as 400 (same as tasks/columns), not 404.
    expect(afterDelete.status).toBe(400);
  });

  it("enforces task-scoped permissions on milestone writes", async () => {
    const viewer = await createWorkspaceMember({ role: "viewer" });
    const { project } = await createProjectFixture({
      workspaceId: viewer.workspace.id,
    });

    // Seed one milestone directly so update/delete paths can be probed.
    const [seeded] = await db
      .insert(schema.milestoneTable)
      .values({ projectId: project.id, name: "Seeded" })
      .returning();

    mockAuthenticatedSession(viewer.user);
    const { app } = createApp();

    // Reading only needs workspace access.
    expect(
      (await app.request(`/api/milestone/project/${project.id}`)).status,
    ).toBe(200);

    expect((await createMilestoneRequest(app, project.id)).status).toBe(403);
    expect(
      (
        await app.request(`/api/milestone/${seeded.id}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Nope" }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request(`/api/milestone/${seeded.id}`, {
          method: "DELETE",
        })
      ).status,
    ).toBe(403);
  });

  it("lets members create and update but not delete milestones", async () => {
    const member = await createWorkspaceMember({ role: "member" });
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const createResponse = await createMilestoneRequest(app, project.id);
    expect(createResponse.status).toBe(200);
    const created = (await createResponse.json()) as { id: string };

    const updateResponse = await app.request(`/api/milestone/${created.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Renamed" }),
    });
    expect(updateResponse.status).toBe(200);

    const deleteResponse = await app.request(`/api/milestone/${created.id}`, {
      method: "DELETE",
    });
    expect(deleteResponse.status).toBe(403);
  });

  it("applies custom role permissions to milestone reads and writes", async () => {
    const member = await createWorkspaceMember({ role: "milestone-reader" });
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const [milestone] = await db
      .insert(schema.milestoneTable)
      .values({ projectId: project.id, name: "Custom role milestone" })
      .returning();
    await db.insert(schema.workspaceRoleTable).values({
      workspaceId: member.workspace.id,
      role: "milestone-reader",
      permission: JSON.stringify({
        task: ["read"],
        project: ["read"],
      }),
    });

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    expect((await app.request(`/api/milestone/${milestone.id}`)).status).toBe(
      200,
    );
    expect(
      (
        await app.request(`/api/milestone/${milestone.id}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Should be rejected" }),
        })
      ).status,
    ).toBe(403);
  });

  it("applies API key permission scopes to milestone operations", async () => {
    const member = await createWorkspaceMember({ role: "member" });
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const rawKey = `kaneo_test_${randomUUID()}`;
    const now = new Date();
    await db.insert(schema.apikeyTable).values({
      referenceId: member.user.id,
      userId: member.user.id,
      key: hashApiKeyForTest(rawKey),
      name: "milestone read key",
      start: rawKey.slice(0, 12),
      prefix: "kaneo",
      createdAt: now,
      updatedAt: now,
      permissions: JSON.stringify({
        task: ["read"],
        project: ["read"],
      }),
    });

    const { app } = createApp();
    const headers = { Authorization: `Bearer ${rawKey}` };

    expect(
      (await app.request(`/api/milestone/project/${project.id}`, { headers }))
        .status,
    ).toBe(200);
    expect(
      (
        await app.request(`/api/milestone/project/${project.id}`, {
          method: "POST",
          headers: {
            ...headers,
            "content-type": "application/json",
          },
          body: JSON.stringify({ name: "Should be rejected" }),
        })
      ).status,
    ).toBe(403);
  });

  it("nulls task.milestone_id when the milestone is deleted", async () => {
    const member = await createWorkspaceMember({ role: "admin" });
    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });

    const [milestone] = await db
      .insert(schema.milestoneTable)
      .values({ projectId: project.id, name: "Doomed" })
      .returning();
    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        title: "Linked",
        description: "",
        status: "to-do",
        columnId: columns.todo.id,
        priority: "low",
        number: 1,
        position: 1,
        milestoneId: milestone.id,
      })
      .returning();

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const deleteResponse = await app.request(`/api/milestone/${milestone.id}`, {
      method: "DELETE",
    });
    expect(deleteResponse.status).toBe(200);

    const persisted = await db.query.taskTable.findFirst({
      where: eq(schema.taskTable.id, task.id),
    });
    expect(persisted).toMatchObject({ id: task.id, milestoneId: null });
  });

  it("assigns and clears milestoneId through task create/update", async () => {
    const member = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const [milestone] = await db
      .insert(schema.milestoneTable)
      .values({ projectId: project.id, name: "M1" })
      .returning();

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const createResponse = await createTaskRequest(app, project.id, {
      milestoneId: milestone.id,
    });
    expect(createResponse.status).toBe(200);
    const created = (await createResponse.json()) as {
      id: string;
      milestoneId: string | null;
    };
    expect(created.milestoneId).toBe(milestone.id);

    const fullUpdate = {
      title: "Task",
      description: "",
      priority: "low",
      status: "to-do",
      projectId: project.id,
      position: 1,
    };
    const clearResponse = await app.request(`/api/task/${created.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...fullUpdate, milestoneId: null }),
    });
    expect(clearResponse.status).toBe(200);
    expect(await clearResponse.json()).toMatchObject({ milestoneId: null });
  });

  it("rejects tasks linked to another project's milestone", async () => {
    const member = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const { project: otherProject } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const [foreign] = await db
      .insert(schema.milestoneTable)
      .values({ projectId: otherProject.id, name: "Foreign" })
      .returning();

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const response = await createTaskRequest(app, project.id, {
      milestoneId: foreign.id,
    });
    expect(response.status).toBe(400);
  });

  it("filters the task list by milestoneId", async () => {
    const member = await createWorkspaceMember({ role: "admin" });
    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const [milestone] = await db
      .insert(schema.milestoneTable)
      .values({ projectId: project.id, name: "Filtered" })
      .returning();
    await db.insert(schema.taskTable).values([
      {
        projectId: project.id,
        title: "In milestone",
        description: "",
        status: "to-do",
        columnId: columns.todo.id,
        priority: "low",
        number: 1,
        position: 1,
        milestoneId: milestone.id,
      },
      {
        projectId: project.id,
        title: "Outside",
        description: "",
        status: "to-do",
        columnId: columns.todo.id,
        priority: "low",
        number: 2,
        position: 2,
      },
    ]);

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const response = await app.request(
      `/api/task/tasks/${project.id}?milestoneId=${milestone.id}`,
    );
    expect(response.status).toBe(200);
    const board = (await response.json()) as {
      data: { columns: { tasks: { title: string }[] }[] };
    };
    const titles = board.data.columns.flatMap((c) =>
      c.tasks.map((t) => t.title),
    );
    expect(titles).toEqual(["In milestone"]);
  });

  it("clears milestoneId when a task moves to another project", async () => {
    const member = await createWorkspaceMember({ role: "admin" });
    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const { project: destination } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const [milestone] = await db
      .insert(schema.milestoneTable)
      .values({ projectId: project.id, name: "Source-only" })
      .returning();
    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        title: "Moving",
        description: "",
        status: "to-do",
        columnId: columns.todo.id,
        priority: "low",
        number: 1,
        position: 1,
        milestoneId: milestone.id,
      })
      .returning();

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const response = await app.request(`/api/task/move/${task.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ destinationProjectId: destination.id }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      task: { milestoneId: null },
    });
  });

  it("returns progress from direct task associations and final workflow columns", async () => {
    const member = await createWorkspaceMember({ role: "admin" });
    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const [shipped] = await db
      .insert(schema.columnTable)
      .values({
        projectId: project.id,
        name: "Shipped",
        slug: "shipped",
        position: 4,
        isFinal: true,
      })
      .returning();

    await db
      .update(schema.columnTable)
      .set({ isFinal: false })
      .where(eq(schema.columnTable.id, columns.done.id));

    const [milestone] = await db
      .insert(schema.milestoneTable)
      .values({ projectId: project.id, name: "M1", status: "active" })
      .returning();

    await db.insert(schema.taskTable).values([
      {
        projectId: project.id,
        title: "T1",
        description: "",
        status: "to-do",
        columnId: columns.todo.id,
        priority: "low",
        number: 1,
        position: 1,
        milestoneId: milestone.id,
      },
      {
        projectId: project.id,
        title: "T2",
        description: "",
        status: "in-progress",
        columnId: columns.inProgress.id,
        priority: "low",
        number: 2,
        position: 1,
        milestoneId: milestone.id,
      },
      {
        projectId: project.id,
        title: "T3",
        description: "",
        status: "shipped",
        columnId: shipped.id,
        priority: "low",
        number: 3,
        position: 1,
        milestoneId: milestone.id,
      },
      {
        projectId: project.id,
        title: "T4",
        description: "",
        status: "archived",
        columnId: null,
        priority: "low",
        number: 4,
        position: 1,
        milestoneId: milestone.id,
      },
      {
        projectId: project.id,
        title: "T5",
        description: "",
        status: "planned",
        columnId: null,
        priority: "low",
        number: 5,
        position: 1,
        milestoneId: milestone.id,
      },
    ]);

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const listResponse = await app.request(
      `/api/milestone/project/${project.id}`,
    );
    expect(listResponse.status).toBe(200);
    const [listed] = (await listResponse.json()) as Array<{
      id: string;
      totalTasks: number;
      completedTasks: number;
      progress: number;
    }>;
    expect(listed).toMatchObject({
      id: milestone.id,
      totalTasks: 5,
      completedTasks: 2,
      progress: 40,
    });

    const detailResponse = await app.request(`/api/milestone/${milestone.id}`);
    expect(detailResponse.status).toBe(200);
    expect(await detailResponse.json()).toMatchObject({
      totalTasks: 5,
      completedTasks: 2,
      progress: 40,
    });
  });

  it("deduplicates labeled tasks and uses isFinal instead of the done slug", async () => {
    const member = await createWorkspaceMember({ role: "admin" });
    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });

    const [shipped] = await db
      .insert(schema.columnTable)
      .values({
        projectId: project.id,
        name: "Shipped",
        slug: "shipped",
        position: 4,
        isFinal: true,
      })
      .returning();
    await db
      .update(schema.columnTable)
      .set({ isFinal: false })
      .where(eq(schema.columnTable.id, columns.done.id));

    const [milestone] = await db
      .insert(schema.milestoneTable)
      .values({ projectId: project.id, name: "M1", status: "active" })
      .returning();

    const [shippedTask] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        title: "Shipped task",
        description: "",
        status: "shipped",
        columnId: shipped.id,
        priority: "low",
        number: 1,
        position: 1,
        milestoneId: milestone.id,
      })
      .returning({ id: schema.taskTable.id });

    await db.insert(schema.labelTable).values([
      {
        name: "release",
        color: "#22C55E",
        taskId: shippedTask.id,
        workspaceId: member.workspace.id,
      },
      {
        name: "verified",
        color: "#3B82F6",
        taskId: shippedTask.id,
        workspaceId: member.workspace.id,
      },
    ]);

    await db.insert(schema.taskTable).values({
      projectId: project.id,
      title: "Done slug but not final",
      description: "",
      status: "done",
      columnId: columns.done.id,
      priority: "low",
      number: 2,
      position: 1,
      milestoneId: milestone.id,
    });

    mockAuthenticatedSession(member.user);
    const { app } = createApp();
    const response = await app.request(`/api/milestone/${milestone.id}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      totalTasks: 2,
      completedTasks: 1,
      progress: 50,
    });
  });

  it("applies completedAt rules independently from task progress", async () => {
    const fixedNow = new Date("2026-09-06T08:00:00.000Z");
    vi.useFakeTimers({ now: fixedNow });

    try {
      const member = await createWorkspaceMember({ role: "admin" });
      const { project } = await createProjectFixture({
        workspaceId: member.workspace.id,
      });

      mockAuthenticatedSession(member.user);
      const { app } = createApp();

      const createResponse = await createMilestoneRequest(app, project.id, {
        status: "completed",
      });
      expect(createResponse.status).toBe(200);
      const created = (await createResponse.json()) as {
        id: string;
        completedAt: string | null;
      };
      expect(created.completedAt).toBe(fixedNow.toISOString());

      const reopenResponse = await app.request(`/api/milestone/${created.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "active" }),
      });
      expect(reopenResponse.status).toBe(200);
      expect((await reopenResponse.json()).completedAt).toBeNull();

      const historical = "2026-08-31T08:00:00.000Z";
      const completeResponse = await app.request(
        `/api/milestone/${created.id}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            status: "completed",
            completedAt: historical,
          }),
        },
      );
      expect(completeResponse.status).toBe(200);
      expect((await completeResponse.json()).completedAt).toBe(historical);

      const nullResponse = await app.request(`/api/milestone/${created.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ completedAt: null }),
      });
      expect(nullResponse.status).toBe(400);

      const nonCompletedTimeResponse = await app.request(
        `/api/milestone/${created.id}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "canceled", completedAt: historical }),
        },
      );
      expect(nonCompletedTimeResponse.status).toBe(400);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves an omitted full-update association and supports the dedicated endpoint", async () => {
    const member = await createWorkspaceMember({ role: "admin" });
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const [milestone] = await db
      .insert(schema.milestoneTable)
      .values({ projectId: project.id, name: "M1" })
      .returning();

    mockAuthenticatedSession(member.user);
    const { app } = createApp();
    const createResponse = await createTaskRequest(app, project.id, {
      title: "T1",
      milestoneId: milestone.id,
    });
    expect(createResponse.status).toBe(200);
    const created = (await createResponse.json()) as {
      id: string;
      milestoneId: string | null;
      position: number;
    };

    const updateResponse = await app.request(`/api/task/${created.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Renamed",
        description: "",
        priority: "low",
        status: "to-do",
        projectId: project.id,
        position: created.position,
      }),
    });
    expect(updateResponse.status).toBe(200);
    expect((await updateResponse.json()).milestoneId).toBe(milestone.id);

    const clearResponse = await app.request(
      `/api/task/milestone/${created.id}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ milestoneId: null }),
      },
    );
    expect(clearResponse.status).toBe(200);
    expect((await clearResponse.json()).milestoneId).toBeNull();

    const emptyAssociationResponse = await app.request(
      `/api/task/milestone/${created.id}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ milestoneId: "" }),
      },
    );
    expect(emptyAssociationResponse.status).toBe(400);
  });

  it("does not expose milestone associations through the public project response", async () => {
    const member = await createWorkspaceMember({ role: "admin" });
    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    await db
      .update(schema.projectTable)
      .set({ isPublic: true })
      .where(eq(schema.projectTable.id, project.id));
    const [milestone] = await db
      .insert(schema.milestoneTable)
      .values({ projectId: project.id, name: "Private roadmap" })
      .returning();
    await db.insert(schema.taskTable).values({
      projectId: project.id,
      title: "Public task",
      description: "",
      status: "to-do",
      columnId: columns.todo.id,
      priority: "low",
      number: 1,
      position: 1,
      milestoneId: milestone.id,
    });

    const { app } = createApp();
    const response = await app.request(`/api/public-project/${project.id}`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(JSON.stringify(body)).not.toContain(milestone.id);
    expect(body.columns[0].tasks[0]).not.toHaveProperty("milestoneId");
  });

  it("serializes association with deletion using the parent-then-task lock order", async () => {
    const member = await createWorkspaceMember({ role: "admin" });
    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const [milestone] = await db
      .insert(schema.milestoneTable)
      .values({ projectId: project.id, name: "Concurrent" })
      .returning();
    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        title: "Concurrent task",
        description: "",
        status: "to-do",
        columnId: columns.todo.id,
        priority: "low",
        number: 1,
        position: 1,
      })
      .returning();

    mockAuthenticatedSession(member.user);
    const { app } = createApp();
    const lockClient = new Client({
      connectionString: process.env.DATABASE_URL ?? "",
    });
    await lockClient.connect();
    let transactionOpen = false;
    let associationPromise: Promise<Response> | undefined;

    try {
      await lockClient.query("BEGIN");
      transactionOpen = true;
      await lockClient.query(
        'SELECT id FROM "milestone" WHERE id = $1 FOR UPDATE',
        [milestone.id],
      );

      associationPromise = app.request(`/api/task/milestone/${task.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ milestoneId: milestone.id }),
      });

      await lockClient.query('DELETE FROM "milestone" WHERE id = $1', [
        milestone.id,
      ]);
      await lockClient.query("COMMIT");
      transactionOpen = false;

      const associationResponse = await associationPromise;
      expect(associationResponse.status).toBe(400);
      const persistedTask = await db.query.taskTable.findFirst({
        where: eq(schema.taskTable.id, task.id),
      });
      expect(persistedTask?.milestoneId).toBeNull();
    } finally {
      if (transactionOpen) await lockClient.query("ROLLBACK");
      await associationPromise?.catch(() => undefined);
      await lockClient.end();
    }
  });

  it("re-reads a task after a concurrent move before applying the move", async () => {
    const member = await createWorkspaceMember({ role: "admin" });
    const source = await createProjectFixture({
      workspaceId: member.workspace.id,
      name: "Source",
    });
    const destination = await createProjectFixture({
      workspaceId: member.workspace.id,
      name: "Destination",
    });
    const [milestone] = await db
      .insert(schema.milestoneTable)
      .values({ projectId: source.project.id, name: "Source milestone" })
      .returning();
    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: source.project.id,
        title: "Move me",
        description: "",
        status: "to-do",
        columnId: source.columns.todo.id,
        priority: "low",
        number: 1,
        position: 1,
        milestoneId: milestone.id,
      })
      .returning();

    mockAuthenticatedSession(member.user);
    const { app } = createApp();
    const lockClient = new Client({
      connectionString: process.env.DATABASE_URL ?? "",
    });
    await lockClient.connect();
    let transactionOpen = false;
    let movePromise: Promise<Response> | undefined;

    try {
      await lockClient.query("BEGIN");
      transactionOpen = true;
      await lockClient.query('SELECT id FROM "task" WHERE id = $1 FOR UPDATE', [
        task.id,
      ]);

      movePromise = app.request(`/api/task/move/${task.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          destinationProjectId: destination.project.id,
        }),
      });

      await lockClient.query(
        `
          UPDATE "task"
          SET project_id = $1, status = 'to-do', column_id = $2, milestone_id = NULL
          WHERE id = $3
        `,
        [destination.project.id, destination.columns.todo.id, task.id],
      );
      await lockClient.query("COMMIT");
      transactionOpen = false;

      const moveResponse = await movePromise;
      expect(moveResponse.status).toBe(400);
      const persistedTask = await db.query.taskTable.findFirst({
        where: eq(schema.taskTable.id, task.id),
      });
      expect(persistedTask).toMatchObject({
        projectId: destination.project.id,
        milestoneId: null,
      });
    } finally {
      if (transactionOpen) await lockClient.query("ROLLBACK");
      await movePromise?.catch(() => undefined);
      await lockClient.end();
    }
  });
});
