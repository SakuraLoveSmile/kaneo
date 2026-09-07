import { beforeEach, describe, expect, it } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

function extractTasks(json: any): any[] {
  const data = json.data;
  const columnTasks = (data.columns || []).flatMap((c: any) => c.tasks || []);
  const plannedTasks = data.plannedTasks || [];
  const archivedTasks = data.archivedTasks || [];
  return [...columnTasks, ...plannedTasks, ...archivedTasks];
}

describe("API integration: task search and pagination", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("performs case-insensitive title search (ilike)", async () => {
    const member = await createWorkspaceMember({ role: "admin" });
    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });

    await db.insert(schema.taskTable).values([
      {
        projectId: project.id,
        userId: member.user.id,
        columnId: columns.todo.id,
        title: "Fix Memory Leak in Production",
        description: "High priority memory issue",
        status: "to-do",
        priority: "urgent",
        number: 1,
        position: 1,
      },
      {
        projectId: project.id,
        userId: member.user.id,
        columnId: columns.todo.id,
        title: "Update Documentation",
        description: "API docs update",
        status: "to-do",
        priority: "low",
        number: 2,
        position: 2,
      },
    ]);

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    // Search lowercase
    const resLower = await app.request(
      `/api/task/tasks/${project.id}?search=memory%20leak`,
    );
    expect(resLower.status).toBe(200);
    const tasksLower = extractTasks(await resLower.json());
    expect(tasksLower.length).toBe(1);
    expect(tasksLower[0].title).toBe("Fix Memory Leak in Production");

    // Search uppercase
    const resUpper = await app.request(
      `/api/task/tasks/${project.id}?search=FIX`,
    );
    expect(resUpper.status).toBe(200);
    const tasksUpper = extractTasks(await resUpper.json());
    expect(tasksUpper.length).toBe(1);
    expect(tasksUpper[0].title).toBe("Fix Memory Leak in Production");
  });

  it("properly escapes LIKE wildcard characters % and _", async () => {
    const member = await createWorkspaceMember({ role: "admin" });
    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });

    await db.insert(schema.taskTable).values([
      {
        projectId: project.id,
        userId: member.user.id,
        columnId: columns.todo.id,
        title: "Target 100% complete",
        description: "",
        status: "to-do",
        priority: "low",
        number: 1,
        position: 1,
      },
      {
        projectId: project.id,
        userId: member.user.id,
        columnId: columns.todo.id,
        title: "Target 1000 complete",
        description: "",
        status: "to-do",
        priority: "low",
        number: 2,
        position: 2,
      },
      {
        projectId: project.id,
        userId: member.user.id,
        columnId: columns.todo.id,
        title: "check_item_status",
        description: "",
        status: "to-do",
        priority: "low",
        number: 3,
        position: 3,
      },
      {
        projectId: project.id,
        userId: member.user.id,
        columnId: columns.todo.id,
        title: "check-item-status",
        description: "",
        status: "to-do",
        priority: "low",
        number: 4,
        position: 4,
      },
    ]);

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    // Query 100% should match only "Target 100% complete" and NOT "Target 1000 complete"
    const resPercent = await app.request(
      `/api/task/tasks/${project.id}?search=100%25`,
    );
    expect(resPercent.status).toBe(200);
    const tasksPercent = extractTasks(await resPercent.json());
    expect(tasksPercent.map((t) => t.title)).toEqual(["Target 100% complete"]);

    // Query check_item should match only "check_item_status" and NOT "check-item-status"
    const resUnderscore = await app.request(
      `/api/task/tasks/${project.id}?search=check_item`,
    );
    expect(resUnderscore.status).toBe(200);
    const tasksUnderscore = extractTasks(await resUnderscore.json());
    expect(tasksUnderscore.map((t) => t.title)).toEqual(["check_item_status"]);
  });

  it("handles pagination with search and calculates total / totalPages correctly", async () => {
    const member = await createWorkspaceMember({ role: "admin" });
    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });

    const tasksToInsert = Array.from({ length: 60 }, (_, i) => ({
      projectId: project.id,
      userId: member.user.id,
      columnId: columns.todo.id,
      title: `Batch Item ${String(i + 1).padStart(3, "0")}`,
      description: "",
      status: "to-do",
      priority: "low" as const,
      number: i + 1,
      position: i + 1,
    }));

    await db.insert(schema.taskTable).values(tasksToInsert);

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    // Page 1 with limit 50
    const resPage1 = await app.request(
      `/api/task/tasks/${project.id}?search=Batch&page=1&limit=50`,
    );
    expect(resPage1.status).toBe(200);
    const jsonPage1 = (await resPage1.json()) as any;
    const tasksPage1 = extractTasks(jsonPage1);

    expect(tasksPage1.length).toBe(50);
    expect(jsonPage1.pagination.total).toBe(60);
    expect(jsonPage1.pagination.totalPages).toBe(2);
    expect(jsonPage1.pagination.page).toBe(1);

    // Page 2 with limit 50
    const resPage2 = await app.request(
      `/api/task/tasks/${project.id}?search=Batch&page=2&limit=50`,
    );
    expect(resPage2.status).toBe(200);
    const jsonPage2 = (await resPage2.json()) as any;
    const tasksPage2 = extractTasks(jsonPage2);

    expect(tasksPage2.length).toBe(10);
    expect(jsonPage2.pagination.page).toBe(2);
  });
});
