import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { buildObjectKey } from "../../apps/api/src/storage";
import { runStorageMaintenance } from "../../apps/api/src/storage/cleanup-uploads";
import { mockAnonymousSession, mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
  type SeededMemberContext,
} from "./helpers/fixtures";

describe("API integration: task image upload finalize", () => {
  beforeEach(async () => {
    await resetTestDatabase();

    process.env.S3_ENDPOINT = "https://storage.example.test";
    process.env.S3_BUCKET = "test-bucket";
    process.env.S3_ACCESS_KEY_ID = "test-access-key";
    process.env.S3_SECRET_ACCESS_KEY = "test-secret-key";
    delete process.env.S3_KEY_PREFIX;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a URL using KANEO_API_URL", async () => {
    process.env.KANEO_API_URL = "http://kaneo.test:1337";

    const member = await createWorkspaceMember();
    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });

    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        userId: member.user.id,
        title: "URL test task",
        status: "to-do",
        columnId: columns.todo.id,
        priority: "medium",
        number: 1,
        position: 1,
      })
      .returning();

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const key = `workspace/${member.workspace.id}/project/${project.id}/task/${task.id}/descriptions/test-image.png`;

    const response = await app.request(
      `/api/task/image-upload/${task.id}/finalize`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          key,
          filename: "test-image.png",
          contentType: "image/png",
          size: 12345,
          surface: "description",
        }),
      },
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { id: string; url: string };
    expect(payload).toHaveProperty("id");
    expect(payload).toHaveProperty("url");
    expect(payload.url).toBe(`http://kaneo.test:1337/api/asset/${payload.id}`);
    expect(payload.url).not.toContain("localhost");
  });

  it("updates the URL when KANEO_API_URL changes", async () => {
    process.env.KANEO_API_URL = "https://proxy.kaneo.internal";

    const member = await createWorkspaceMember();
    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });

    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        userId: member.user.id,
        title: "Proxy test",
        status: "to-do",
        columnId: columns.todo.id,
        priority: "medium",
        number: 1,
        position: 1,
      })
      .returning();

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const key = `workspace/${member.workspace.id}/project/${project.id}/task/${task.id}/descriptions/proxy-image.png`;

    const response = await app.request(
      `/api/task/image-upload/${task.id}/finalize`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          key,
          filename: "proxy-image.png",
          contentType: "image/png",
          size: 99999,
          surface: "description",
        }),
      },
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { id: string; url: string };
    expect(payload.url).toBe(
      `https://proxy.kaneo.internal/api/asset/${payload.id}`,
    );
    expect(payload.url).not.toContain("localhost");
  });

  it("falls back to deriving URL from the request when KANEO_API_URL is not set", async () => {
    delete process.env.KANEO_API_URL;

    const member = await createWorkspaceMember();
    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });

    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        userId: member.user.id,
        title: "Fallback test",
        status: "to-do",
        columnId: columns.todo.id,
        priority: "medium",
        number: 1,
        position: 1,
      })
      .returning();

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const key = `workspace/${member.workspace.id}/project/${project.id}/task/${task.id}/descriptions/fallback-image.png`;

    const response = await app.request(
      `https://app.kaneo.test/api/task/image-upload/${task.id}/finalize`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          key,
          filename: "fallback-image.png",
          contentType: "image/png",
          size: 12345,
          surface: "description",
        }),
      },
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { id: string; url: string };
    expect(payload.url).toBe(`https://app.kaneo.test/api/asset/${payload.id}`);
    expect(payload.url).not.toContain("localhost");
  });

  it("persists a new asset record with correct metadata", async () => {
    process.env.KANEO_API_URL = "http://localhost:1337";

    const member = await createWorkspaceMember();
    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });

    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        userId: member.user.id,
        title: "Persist test",
        status: "to-do",
        columnId: columns.todo.id,
        priority: "medium",
        number: 1,
        position: 1,
      })
      .returning();

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const key = `workspace/${member.workspace.id}/project/${project.id}/task/${task.id}/descriptions/persist-asset.png`;

    const response = await app.request(
      `/api/task/image-upload/${task.id}/finalize`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          key,
          filename: "persist-asset.png",
          contentType: "image/png",
          size: 45678,
          surface: "description",
        }),
      },
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { id: string; url: string };

    const asset = await db.query.assetTable.findFirst({
      where: (t, { eq }) => eq(t.id, payload.id),
    });

    expect(asset).toBeDefined();
    expect(asset?.id).toBe(payload.id);
    expect(asset?.objectKey).toBe(key);
    expect(asset?.filename).toBe("persist-asset.png");
    expect(asset?.mimeType).toBe("image/png");
    expect(asset?.size).toBe(45678);
    expect(asset?.kind).toBe("image");
    expect(asset?.surface).toBe("description");
    expect(asset?.workspaceId).toBe(member.workspace.id);
    expect(asset?.projectId).toBe(project.id);
    expect(asset?.taskId).toBe(task.id);
    expect(asset?.createdBy).toBe(member.user.id);
  });

  it("creates attachment records for non-image content types", async () => {
    process.env.KANEO_API_URL = "http://localhost:1337";

    const member = await createWorkspaceMember();
    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });

    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        userId: member.user.id,
        title: "Attachment test",
        status: "to-do",
        columnId: columns.todo.id,
        priority: "medium",
        number: 1,
        position: 1,
      })
      .returning();

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const key = `workspace/${member.workspace.id}/project/${project.id}/task/${task.id}/descriptions/report.pdf`;

    const response = await app.request(
      `/api/task/image-upload/${task.id}/finalize`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          key,
          filename: "report.pdf",
          contentType: "application/pdf",
          size: 102400,
          surface: "description",
        }),
      },
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { id: string; url: string };

    const asset = await db.query.assetTable.findFirst({
      where: (t, { eq }) => eq(t.id, payload.id),
    });
    expect(asset?.kind).toBe("attachment");
  });

  it("rejects key that does not match the task context", async () => {
    process.env.KANEO_API_URL = "http://localhost:1337";

    const member = await createWorkspaceMember();
    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });

    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        userId: member.user.id,
        title: "Bad key test",
        status: "to-do",
        columnId: columns.todo.id,
        priority: "medium",
        number: 1,
        position: 1,
      })
      .returning();

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const response = await app.request(
      `/api/task/image-upload/${task.id}/finalize`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          key: "totally/wrong/path/image.png",
          filename: "test.png",
          contentType: "image/png",
          size: 100,
          surface: "description",
        }),
      },
    );

    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toBe("Image upload key does not match the task context.");
  });

  it("rejects unauthenticated requests", async () => {
    process.env.KANEO_API_URL = "http://localhost:1337";

    const member = await createWorkspaceMember();
    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });

    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        userId: member.user.id,
        title: "Auth test",
        status: "to-do",
        columnId: columns.todo.id,
        priority: "medium",
        number: 1,
        position: 1,
      })
      .returning();

    mockAnonymousSession();
    const { app } = createApp();

    const response = await app.request(
      `/api/task/image-upload/${task.id}/finalize`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          key: "some/key.png",
          filename: "test.png",
          contentType: "image/png",
          size: 100,
          surface: "description",
        }),
      },
    );

    expect(response.status).toBe(401);
  });

  it("rejects requests from users outside the workspace", async () => {
    process.env.KANEO_API_URL = "http://localhost:1337";

    const member = await createWorkspaceMember();
    const outsiderId = `user-${randomUUID()}`;

    const [outsider] = await db
      .insert(schema.userTable)
      .values({
        id: outsiderId,
        email: `${outsiderId}@example.com`,
        emailVerified: true,
        name: "Outsider",
      })
      .returning();

    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });

    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        userId: member.user.id,
        title: "RBAC test",
        status: "to-do",
        columnId: columns.todo.id,
        priority: "medium",
        number: 1,
        position: 1,
      })
      .returning();

    mockAuthenticatedSession(outsider);
    const { app } = createApp();

    const response = await app.request(
      `/api/task/image-upload/${task.id}/finalize`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          key: `workspace/${member.workspace.id}/project/${project.id}/task/${task.id}/descriptions/rbac-test.png`,
          filename: "rbac-test.png",
          contentType: "image/png",
          size: 100,
          surface: "description",
        }),
      },
    );

    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toBe(
      "You don't have access to this workspace",
    );
  });
});

type UploadDescriptor = {
  key: string;
  uploadUrl: string;
  headers: Record<string, string>;
};

describe("API integration: local storage image uploads", () => {
  const storageRoots: string[] = [];

  beforeEach(async () => {
    await resetTestDatabase();

    process.env.STORAGE_BACKEND = "local";
    process.env.KANEO_API_URL = "http://localhost:1337";
    delete process.env.STORAGE_MAX_UPLOAD_BYTES;
    delete process.env.S3_KEY_PREFIX;

    // Legacy S3 configuration stays present on a local-storage instance, so the
    // S3 finalize fallback must keep resolving against it.
    process.env.S3_ENDPOINT = "https://storage.example.test";
    process.env.S3_BUCKET = "test-bucket";
    process.env.S3_ACCESS_KEY_ID = "test-access-key";
    process.env.S3_SECRET_ACCESS_KEY = "test-secret-key";

    const root = await mkdtemp(join(tmpdir(), "kaneo-local-integration-"));
    storageRoots.push(root);
    process.env.LOCAL_STORAGE_PATH = root;
  });

  afterEach(async () => {
    delete process.env.STORAGE_BACKEND;
    delete process.env.LOCAL_STORAGE_PATH;
    delete process.env.STORAGE_MAX_UPLOAD_BYTES;
    vi.restoreAllMocks();

    await Promise.all(
      storageRoots
        .splice(0)
        .map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  async function seedTask(member: SeededMemberContext) {
    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });

    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        userId: member.user.id,
        title: "Local storage task",
        status: "to-do",
        columnId: columns.todo.id,
        priority: "medium",
        number: 1,
        position: 1,
      })
      .returning();

    if (!task) throw new Error("Failed to seed task");

    return { project, task };
  }

  async function requestUpload(
    app: ReturnType<typeof createApp>["app"],
    taskId: string,
    {
      filename,
      contentType,
      size,
      surface = "description",
    }: {
      filename: string;
      contentType: string;
      size: number;
      surface?: "description" | "comment";
    },
  ) {
    const response = await app.request(`/api/task/image-upload/${taskId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename, contentType, size, surface }),
    });

    return {
      response,
      upload: response.ok
        ? ((await response.json()) as UploadDescriptor)
        : ({} as UploadDescriptor),
    };
  }

  async function putBytes(
    app: ReturnType<typeof createApp>["app"],
    upload: UploadDescriptor,
    bytes: Buffer,
    headers: Record<string, string> = upload.headers,
  ) {
    return app.request(upload.uploadUrl, {
      method: "PUT",
      headers,
      body: bytes,
    });
  }

  async function finalize(
    app: ReturnType<typeof createApp>["app"],
    taskId: string,
    upload: UploadDescriptor,
    overrides: Partial<{
      filename: string;
      contentType: string;
      size: number;
      surface: "description" | "comment";
    }> = {},
  ) {
    const response = await app.request(
      `/api/task/image-upload/${taskId}/finalize`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          key: upload.key,
          filename: "local.png",
          contentType: "image/png",
          size: 32,
          surface: "description",
          ...overrides,
        }),
      },
    );

    return response;
  }

  function storedPath(key: string) {
    const root = process.env.LOCAL_STORAGE_PATH;
    if (!root) throw new Error("LOCAL_STORAGE_PATH is not set");
    return join(root, ...key.split("/"));
  }

  async function fileExists(path: string) {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }

  async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 4000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return predicate();
  }

  it("round-trips bytes through create, PUT, finalize and download", async () => {
    const member = await createWorkspaceMember();
    const { task } = await seedTask(member);
    const bytes = Buffer.from(
      "local-storage-round-trip-bytes-\u0000\u0001\u00ff",
      "binary",
    );

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const { response: createResponse, upload } = await requestUpload(
      app,
      task.id,
      { filename: "local.png", contentType: "image/png", size: bytes.length },
    );

    expect(createResponse.status).toBe(200);
    expect(upload.key).toContain(`/task/${task.id}/descriptions/`);
    expect(upload.uploadUrl).toMatch(
      /^http:\/\/localhost:1337\/api\/storage\/local-upload\/[a-z0-9]+\?Expires=\d+$/,
    );
    expect(upload.headers["Content-Type"]).toBe("image/png");
    expect(upload.headers["x-kaneo-upload-token"]).toBeTruthy();

    const putResponse = await putBytes(app, upload, bytes);
    expect(putResponse.status).toBe(200);
    const putPayload = (await putResponse.json()) as {
      key: string;
      size: number;
    };
    expect(putPayload.key).toBe(upload.key);
    expect(putPayload.size).toBe(bytes.length);
    expect(await fileExists(storedPath(upload.key))).toBe(true);

    const finalizeResponse = await finalize(app, task.id, upload, {
      filename: "local.png",
      contentType: "image/png",
      size: bytes.length,
    });
    expect(finalizeResponse.status).toBe(200);
    const asset = (await finalizeResponse.json()) as {
      id: string;
      url: string;
    };
    expect(asset.url).toBe(`http://localhost:1337/api/asset/${asset.id}`);

    const assetRow = await db.query.assetTable.findFirst({
      where: (t, { eq: equals }) => equals(t.id, asset.id),
    });
    expect(assetRow?.storageBackend).toBe("local");
    expect(assetRow?.size).toBe(bytes.length);
    expect(assetRow?.mimeType).toBe("image/png");

    const downloadResponse = await app.request(`/api/asset/${asset.id}`);
    expect(downloadResponse.status).toBe(200);
    expect(downloadResponse.headers.get("content-type")).toBe("image/png");
    const downloaded = Buffer.from(await downloadResponse.arrayBuffer());
    expect(downloaded.equals(bytes)).toBe(true);
  });

  it("stores non-image attachments and downloads them as attachments", async () => {
    const member = await createWorkspaceMember();
    const { task } = await seedTask(member);
    const bytes = Buffer.from("%PDF-1.4 local attachment");

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const { upload } = await requestUpload(app, task.id, {
      filename: "report.pdf",
      contentType: "application/pdf",
      size: bytes.length,
    });

    expect((await putBytes(app, upload, bytes)).status).toBe(200);

    const finalizeResponse = await finalize(app, task.id, upload, {
      filename: "report.pdf",
      contentType: "application/pdf",
      size: bytes.length,
    });
    expect(finalizeResponse.status).toBe(200);
    const asset = (await finalizeResponse.json()) as { id: string };

    const assetRow = await db.query.assetTable.findFirst({
      where: (t, { eq: equals }) => equals(t.id, asset.id),
    });
    expect(assetRow?.kind).toBe("attachment");

    const downloadResponse = await app.request(`/api/asset/${asset.id}`);
    expect(downloadResponse.status).toBe(200);
    expect(downloadResponse.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(downloadResponse.headers.get("content-disposition")).toContain(
      "attachment",
    );
  });

  it("rejects an invalid or missing upload credential", async () => {
    const member = await createWorkspaceMember();
    const { task } = await seedTask(member);

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const { upload } = await requestUpload(app, task.id, {
      filename: "local.png",
      contentType: "image/png",
      size: 8,
    });

    const wrongToken = await putBytes(app, upload, Buffer.from("12345678"), {
      ...upload.headers,
      "x-kaneo-upload-token": "not-the-token",
    });
    expect(wrongToken.status).toBe(403);

    const noToken = await app.request(upload.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "image/png" },
      body: Buffer.from("12345678"),
    });
    expect(noToken.status).toBe(403);

    const unknownId = await app.request(
      "/api/storage/local-upload/does-not-exist?Expires=1",
      {
        method: "PUT",
        headers: upload.headers,
        body: Buffer.from("12345678"),
      },
    );
    expect(unknownId.status).toBe(403);

    expect(await fileExists(storedPath(upload.key))).toBe(false);
  });

  it("refuses a PUT after the credential expires but still finalizes the stored file", async () => {
    const member = await createWorkspaceMember();
    const { task } = await seedTask(member);
    const bytes = Buffer.from("expiry-bytes");

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const { upload } = await requestUpload(app, task.id, {
      filename: "local.png",
      contentType: "image/png",
      size: bytes.length,
    });

    expect((await putBytes(app, upload, bytes)).status).toBe(200);

    await db
      .update(schema.assetUploadTable)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.assetUploadTable.objectKey, upload.key));

    const latePut = await putBytes(app, upload, bytes);
    expect(latePut.status).toBe(403);

    const finalizeResponse = await finalize(app, task.id, upload, {
      size: bytes.length,
    });
    expect(finalizeResponse.status).toBe(200);
  });

  it("enforces the size cap while streaming instead of trusting the declared size", async () => {
    process.env.STORAGE_MAX_UPLOAD_BYTES = "32";

    const member = await createWorkspaceMember();
    const { task } = await seedTask(member);

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const { response: createResponse, upload } = await requestUpload(
      app,
      task.id,
      { filename: "local.png", contentType: "image/png", size: 16 },
    );
    expect(createResponse.status).toBe(200);

    const oversized = await putBytes(app, upload, Buffer.alloc(64, 1));
    expect(oversized.status).toBe(413);
    expect(await fileExists(storedPath(upload.key))).toBe(false);
  });

  it("treats a repeated identical PUT as success and a different body as a conflict", async () => {
    const member = await createWorkspaceMember();
    const { task } = await seedTask(member);
    const bytes = Buffer.from("idempotent-bytes");

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const { upload } = await requestUpload(app, task.id, {
      filename: "local.png",
      contentType: "image/png",
      size: bytes.length,
    });

    expect((await putBytes(app, upload, bytes)).status).toBe(200);
    expect((await putBytes(app, upload, bytes)).status).toBe(200);

    // Different bytes, same declared length, so this reaches the content check
    // rather than being rejected for its size.
    const conflict = await putBytes(app, upload, Buffer.alloc(bytes.length, 7));
    expect(conflict.status).toBe(409);
  });

  it("returns the same asset for a repeated finalize", async () => {
    const member = await createWorkspaceMember();
    const { task } = await seedTask(member);
    const bytes = Buffer.from("repeat-finalize");

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const { upload } = await requestUpload(app, task.id, {
      filename: "local.png",
      contentType: "image/png",
      size: bytes.length,
    });
    expect((await putBytes(app, upload, bytes)).status).toBe(200);

    const first = await finalize(app, task.id, upload, { size: bytes.length });
    const second = await finalize(app, task.id, upload, { size: bytes.length });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const firstAsset = (await first.json()) as { id: string };
    const secondAsset = (await second.json()) as { id: string };
    expect(secondAsset.id).toBe(firstAsset.id);

    const assets = await db
      .select({ id: schema.assetTable.id })
      .from(schema.assetTable)
      .where(eq(schema.assetTable.objectKey, upload.key));
    expect(assets).toHaveLength(1);
  });

  it("refuses a finalize whose size disagrees with the declared size", async () => {
    const member = await createWorkspaceMember();
    const { task } = await seedTask(member);
    const bytes = Buffer.alloc(8, 1);

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const { upload } = await requestUpload(app, task.id, {
      filename: "local.png",
      contentType: "image/png",
      size: 8,
    });
    expect((await putBytes(app, upload, bytes)).status).toBe(200);

    // Declared 8, claimed 16: refused without registering anything.
    const wrong = await finalize(app, task.id, upload, { size: 16 });
    expect(wrong.status).toBe(400);

    const assets = await db
      .select({ id: schema.assetTable.id })
      .from(schema.assetTable)
      .where(eq(schema.assetTable.objectKey, upload.key));
    expect(assets).toHaveLength(0);
    expect(await fileExists(storedPath(upload.key))).toBe(true);

    // The matching size registers, and stays idempotent afterwards.
    const right = await finalize(app, task.id, upload, { size: 8 });
    expect(right.status).toBe(200);
    const asset = (await right.json()) as { id: string };

    const again = await finalize(app, task.id, upload, { size: 8 });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { id: string }).id).toBe(asset.id);

    // Changing the size after registration is still refused, and the
    // registered asset is not rewritten.
    const changed = await finalize(app, task.id, upload, { size: 16 });
    expect(changed.status).toBe(400);

    const [stored] = await db
      .select({ id: schema.assetTable.id, size: schema.assetTable.size })
      .from(schema.assetTable)
      .where(eq(schema.assetTable.objectKey, upload.key));
    expect(stored).toMatchObject({ id: asset.id, size: 8 });
  });

  it("refuses a legacy record whose stored size disagrees with its declaration", async () => {
    const member = await createWorkspaceMember();
    const { project, task } = await seedTask(member);

    // State left behind by the earlier, weaker implementation: the file is 8
    // bytes with a matching digest, but the upload was declared as 16.
    const key = buildObjectKey({
      workspaceId: member.workspace.id,
      projectId: project.id,
      taskId: task.id,
      surface: "description",
      filename: "legacy.png",
      contentType: "image/png",
    });
    const bytes = Buffer.alloc(8, 7);
    const filePath = storedPath(key);

    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, bytes);

    await db.insert(schema.assetUploadTable).values({
      tokenHash: "d".repeat(64),
      backend: "local",
      objectKey: key,
      filename: "legacy.png",
      mimeType: "image/png",
      declaredSize: 16,
      actualSize: 8,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      status: "uploaded",
      surface: "description",
      workspaceId: member.workspace.id,
      projectId: project.id,
      taskId: task.id,
      createdBy: member.user.id,
      expiresAt: new Date(Date.now() + 60_000),
    });

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const response = await finalize(
      app,
      task.id,
      { key, uploadUrl: "", headers: {} },
      { filename: "legacy.png", contentType: "image/png", size: 16 },
    );
    expect(response.status).toBe(400);

    // Neither the file nor the record is corrected or removed.
    expect(await fileExists(filePath)).toBe(true);
    const [record] = await db
      .select({
        declaredSize: schema.assetUploadTable.declaredSize,
        actualSize: schema.assetUploadTable.actualSize,
        status: schema.assetUploadTable.status,
      })
      .from(schema.assetUploadTable)
      .where(eq(schema.assetUploadTable.objectKey, key));
    expect(record).toMatchObject({
      declaredSize: 16,
      actualSize: 8,
      status: "uploaded",
    });

    const assets = await db
      .select({ id: schema.assetTable.id })
      .from(schema.assetTable)
      .where(eq(schema.assetTable.objectKey, key));
    expect(assets).toHaveLength(0);
  });

  it("recovers a published file whose upload record was never completed", async () => {
    const member = await createWorkspaceMember();
    const { task } = await seedTask(member);
    const bytes = Buffer.from("recovered-after-crash");

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const { upload } = await requestUpload(app, task.id, {
      filename: "local.png",
      contentType: "image/png",
      size: bytes.length,
    });
    expect((await putBytes(app, upload, bytes)).status).toBe(200);

    // Simulates a crash between publishing the file and writing the upload status.
    await db
      .update(schema.assetUploadTable)
      .set({ status: "pending", sha256: null, actualSize: null })
      .where(eq(schema.assetUploadTable.objectKey, upload.key));

    const finalizeResponse = await finalize(app, task.id, upload, {
      size: bytes.length,
    });
    expect(finalizeResponse.status).toBe(200);

    const [record] = await db
      .select({
        status: schema.assetUploadTable.status,
        sha256: schema.assetUploadTable.sha256,
        actualSize: schema.assetUploadTable.actualSize,
      })
      .from(schema.assetUploadTable)
      .where(eq(schema.assetUploadTable.objectKey, upload.key));

    expect(record?.status).toBe("uploaded");
    expect(record?.sha256).toHaveLength(64);
    expect(record?.actualSize).toBe(bytes.length);
  });

  it("rejects finalizing an upload key that belongs to another workspace", async () => {
    const owner = await createWorkspaceMember();
    const other = await createWorkspaceMember();
    const { task: ownerTask } = await seedTask(owner);
    const { task: otherTask } = await seedTask(other);

    mockAuthenticatedSession(owner.user);
    const { app } = createApp();
    const { upload } = await requestUpload(app, ownerTask.id, {
      filename: "local.png",
      contentType: "image/png",
      size: 32,
    });

    mockAuthenticatedSession(other.user);
    const foreign = await finalize(app, otherTask.id, upload);
    expect(foreign.status).toBe(400);
    await expect(foreign.text()).resolves.toBe(
      "Image upload key does not match the task context.",
    );
  });

  it("rejects cross-workspace access to a stored asset", async () => {
    const owner = await createWorkspaceMember();
    const other = await createWorkspaceMember();
    const { task } = await seedTask(owner);
    const bytes = Buffer.from("private-local-asset");

    mockAuthenticatedSession(owner.user);
    const { app } = createApp();

    const { upload } = await requestUpload(app, task.id, {
      filename: "local.png",
      contentType: "image/png",
      size: bytes.length,
    });
    expect((await putBytes(app, upload, bytes)).status).toBe(200);
    const finalizeResponse = await finalize(app, task.id, upload, {
      size: bytes.length,
    });
    const asset = (await finalizeResponse.json()) as { id: string };

    mockAnonymousSession();
    const anonymous = await app.request(`/api/asset/${asset.id}`);
    expect(anonymous.status).toBe(401);

    mockAuthenticatedSession(other.user);
    const outsider = await app.request(`/api/asset/${asset.id}`);
    expect(outsider.status).toBe(403);
  });

  it("serves a local asset from a public project without signing in", async () => {
    const member = await createWorkspaceMember();
    const { project, task } = await seedTask(member);
    const bytes = Buffer.from("public-local-asset");

    await db
      .update(schema.projectTable)
      .set({ isPublic: true })
      .where(eq(schema.projectTable.id, project.id));

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const { upload } = await requestUpload(app, task.id, {
      filename: "local.png",
      contentType: "image/png",
      size: bytes.length,
    });
    expect((await putBytes(app, upload, bytes)).status).toBe(200);
    const finalizeResponse = await finalize(app, task.id, upload, {
      size: bytes.length,
    });
    const asset = (await finalizeResponse.json()) as { id: string };

    mockAnonymousSession();
    const anonymous = await app.request(`/api/asset/${asset.id}`);
    expect(anonymous.status).toBe(200);
    const downloaded = Buffer.from(await anonymous.arrayBuffer());
    expect(downloaded.equals(bytes)).toBe(true);
  });

  it("keeps the legacy S3 finalize path working when local storage is configured", async () => {
    process.env.S3_ENDPOINT = "https://storage.example.test";
    process.env.S3_BUCKET = "test-bucket";
    process.env.S3_ACCESS_KEY_ID = "test-access-key";
    process.env.S3_SECRET_ACCESS_KEY = "test-secret-key";

    const member = await createWorkspaceMember();
    const { project, task } = await seedTask(member);

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const key = `workspace/${member.workspace.id}/project/${project.id}/task/${task.id}/descriptions/legacy-s3.png`;

    const response = await app.request(
      `/api/task/image-upload/${task.id}/finalize`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          key,
          filename: "legacy-s3.png",
          contentType: "image/png",
          size: 4096,
          surface: "description",
        }),
      },
    );

    expect(response.status).toBe(200);
    const asset = (await response.json()) as { id: string };

    const assetRow = await db.query.assetTable.findFirst({
      where: (t, { eq: equals }) => equals(t.id, asset.id),
    });
    expect(assetRow?.storageBackend).toBe("s3");
  });

  it("defaults assets inserted without a backend to s3 for existing databases", async () => {
    const member = await createWorkspaceMember();
    const { project } = await seedTask(member);
    const assetId = `asset-${randomUUID()}`;

    // `storageBackend` is intentionally omitted: the migration adds the column
    // as `text DEFAULT 's3' NOT NULL`, so rows written before it existed keep
    // resolving to S3 without a separate data migration.
    const [inserted] = await db
      .insert(schema.assetTable)
      .values({
        id: assetId,
        workspaceId: member.workspace.id,
        projectId: project.id,
        objectKey: `legacy/${assetId}.png`,
        filename: "legacy.png",
        mimeType: "image/png",
        size: 128,
      })
      .returning({ storageBackend: schema.assetTable.storageBackend });

    expect(inserted?.storageBackend).toBe("s3");

    const [row] = await db
      .select({ storageBackend: schema.assetTable.storageBackend })
      .from(schema.assetTable)
      .where(eq(schema.assetTable.id, assetId));

    expect(row?.storageBackend).toBe("s3");
  });

  it("deletes the stored file when the owning task is removed", async () => {
    const member = await createWorkspaceMember({ role: "admin" });
    const { task } = await seedTask(member);
    const bytes = Buffer.from("delete-me");

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const { upload } = await requestUpload(app, task.id, {
      filename: "local.png",
      contentType: "image/png",
      size: bytes.length,
    });
    expect((await putBytes(app, upload, bytes)).status).toBe(200);
    const finalizeResponse = await finalize(app, task.id, upload, {
      size: bytes.length,
    });
    const asset = (await finalizeResponse.json()) as { id: string };

    const path = storedPath(upload.key);
    expect(await fileExists(path)).toBe(true);

    const deleteResponse = await app.request(`/api/task/${task.id}`, {
      method: "DELETE",
    });
    expect(deleteResponse.status).toBe(200);

    expect(await waitFor(async () => !(await fileExists(path)))).toBe(true);

    const remaining = await db
      .select({ id: schema.assetTable.id })
      .from(schema.assetTable)
      .where(eq(schema.assetTable.id, asset.id));
    expect(remaining).toHaveLength(0);
  });

  it("rejects a body whose size does not match the declared size", async () => {
    const member = await createWorkspaceMember();
    const { task } = await seedTask(member);

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const short = await requestUpload(app, task.id, {
      filename: "local.png",
      contentType: "image/png",
      size: 8,
    });
    const shortPut = await putBytes(app, short.upload, Buffer.from("1234"));
    expect(shortPut.status).toBe(400);
    expect(await fileExists(storedPath(short.upload.key))).toBe(false);

    const long = await requestUpload(app, task.id, {
      filename: "local.png",
      contentType: "image/png",
      size: 8,
    });
    const longPut = await putBytes(
      app,
      long.upload,
      Buffer.from("123456789012"),
    );
    expect(longPut.status).toBe(400);
    expect(await fileExists(storedPath(long.upload.key))).toBe(false);
  });

  it("refuses to upload once the requester is no longer in the workspace", async () => {
    const member = await createWorkspaceMember();
    const { task } = await seedTask(member);

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const { upload } = await requestUpload(app, task.id, {
      filename: "local.png",
      contentType: "image/png",
      size: 8,
    });

    await db
      .delete(schema.workspaceUserTable)
      .where(
        and(
          eq(schema.workspaceUserTable.workspaceId, member.workspace.id),
          eq(schema.workspaceUserTable.userId, member.user.id),
        ),
      );

    const put = await putBytes(app, upload, Buffer.from("12345678"));
    expect(put.status).toBe(403);
    expect(await fileExists(storedPath(upload.key))).toBe(false);
  });

  it("refuses to upload once the requester loses task update permission", async () => {
    const member = await createWorkspaceMember();
    const { task } = await seedTask(member);

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const { upload } = await requestUpload(app, task.id, {
      filename: "local.png",
      contentType: "image/png",
      size: 8,
    });

    await db
      .update(schema.workspaceUserTable)
      .set({ role: "viewer" })
      .where(
        and(
          eq(schema.workspaceUserTable.workspaceId, member.workspace.id),
          eq(schema.workspaceUserTable.userId, member.user.id),
        ),
      );

    const put = await putBytes(app, upload, Buffer.from("12345678"));
    expect(put.status).toBe(403);
    expect(await fileExists(storedPath(upload.key))).toBe(false);
  });

  it("refuses to upload when the upload record has no requester", async () => {
    const member = await createWorkspaceMember();
    const { task } = await seedTask(member);

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const { upload } = await requestUpload(app, task.id, {
      filename: "local.png",
      contentType: "image/png",
      size: 8,
    });

    await db
      .update(schema.assetUploadTable)
      .set({ createdBy: null })
      .where(eq(schema.assetUploadTable.objectKey, upload.key));

    const put = await putBytes(app, upload, Buffer.from("12345678"));
    expect(put.status).toBe(403);
    expect(await fileExists(storedPath(upload.key))).toBe(false);
  });

  it("deletes an uploaded but unfinalized file when the task is removed", async () => {
    const member = await createWorkspaceMember({ role: "admin" });
    const { task } = await seedTask(member);
    const bytes = Buffer.from("unfinalized");

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const { upload } = await requestUpload(app, task.id, {
      filename: "local.png",
      contentType: "image/png",
      size: bytes.length,
    });
    expect((await putBytes(app, upload, bytes)).status).toBe(200);

    const path = storedPath(upload.key);
    expect(await fileExists(path)).toBe(true);

    const deleteResponse = await app.request(`/api/task/${task.id}`, {
      method: "DELETE",
    });
    expect(deleteResponse.status).toBe(200);

    expect(await waitFor(async () => !(await fileExists(path)))).toBe(true);
  });

  it("refuses to publish when the task is deleted before the upload completes", async () => {
    const member = await createWorkspaceMember({ role: "admin" });
    const { task } = await seedTask(member);

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const { upload } = await requestUpload(app, task.id, {
      filename: "local.png",
      contentType: "image/png",
      size: 8,
    });

    const deleteResponse = await app.request(`/api/task/${task.id}`, {
      method: "DELETE",
    });
    expect(deleteResponse.status).toBe(200);

    const put = await putBytes(app, upload, Buffer.from("12345678"));
    expect(put.status).toBe(403);
    expect(await fileExists(storedPath(upload.key))).toBe(false);
  });

  it("invalidates an upload credential once its task is deleted", async () => {
    const member = await createWorkspaceMember({ role: "admin" });
    const { task } = await seedTask(member);

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const { upload } = await requestUpload(app, task.id, {
      filename: "local.png",
      contentType: "image/png",
      size: 8,
    });

    const deleteResponse = await app.request(`/api/task/${task.id}`, {
      method: "DELETE",
    });
    expect(deleteResponse.status).toBe(200);

    const put = await putBytes(app, upload, Buffer.from("12345678"));
    expect(put.status).toBe(403);
  });

  it("keeps uploads and deletes consistent when they overlap", async () => {
    const member = await createWorkspaceMember({ role: "admin" });
    const { task } = await seedTask(member);
    const bytes = Buffer.alloc(16, 4);

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const { upload } = await requestUpload(app, task.id, {
      filename: "local.png",
      contentType: "image/png",
      size: bytes.length,
    });

    const path = storedPath(upload.key);

    const [putResponse, deleteResponse] = await Promise.all([
      putBytes(app, upload, bytes),
      app.request(`/api/task/${task.id}`, { method: "DELETE" }),
    ]);

    expect(deleteResponse.status).toBe(200);
    expect([200, 403, 404]).toContain(putResponse.status);

    const outcome = await runStorageMaintenance();
    expect(outcome.degraded).toBe(false);

    // Whichever order won, no file may outlive the task that owned it and no
    // asset row may be left pointing at it.
    expect(await fileExists(path)).toBe(false);
    const remaining = await db
      .select({ id: schema.assetTable.id })
      .from(schema.assetTable)
      .where(eq(schema.assetTable.objectKey, upload.key));
    expect(remaining).toHaveLength(0);
  });

  it("keeps finalize and delete consistent when they overlap", async () => {
    const member = await createWorkspaceMember({ role: "admin" });
    const { task } = await seedTask(member);
    const bytes = Buffer.alloc(16, 6);

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const { upload } = await requestUpload(app, task.id, {
      filename: "local.png",
      contentType: "image/png",
      size: bytes.length,
    });
    expect((await putBytes(app, upload, bytes)).status).toBe(200);

    const path = storedPath(upload.key);

    const [finalizeResponse, deleteResponse] = await Promise.all([
      finalize(app, task.id, upload, { size: bytes.length }),
      app.request(`/api/task/${task.id}`, { method: "DELETE" }),
    ]);

    expect(deleteResponse.status).toBe(200);
    expect([200, 400, 404]).toContain(finalizeResponse.status);

    const outcome = await runStorageMaintenance();
    expect(outcome.degraded).toBe(false);
    expect(await fileExists(path)).toBe(false);

    const remaining = await db
      .select({ id: schema.assetTable.id })
      .from(schema.assetTable)
      .where(eq(schema.assetTable.objectKey, upload.key));
    expect(remaining).toHaveLength(0);
  });

  it("fails clearly instead of falling back to a temporary directory when local storage is not configured", async () => {
    const member = await createWorkspaceMember();
    const { task } = await seedTask(member);

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const configuredRoot = process.env.LOCAL_STORAGE_PATH;
    delete process.env.LOCAL_STORAGE_PATH;

    const { response } = await requestUpload(app, task.id, {
      filename: "local.png",
      contentType: "image/png",
      size: 16,
    });

    process.env.LOCAL_STORAGE_PATH = configuredRoot;

    expect(response.status).toBe(503);
  });
});
