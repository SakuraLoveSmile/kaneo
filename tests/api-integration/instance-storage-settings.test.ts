import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import { createWorkspaceMember } from "./helpers/fixtures";

describe("instance storage settings with PostgreSQL", () => {
  let root: string;
  beforeEach(async () => {
    await resetTestDatabase();
    root = await mkdtemp(join(tmpdir(), "kaneo-settings-"));
    vi.stubEnv("LOCAL_STORAGE_PATH", root);
    vi.stubEnv("STORAGE_BACKEND", "local");
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  async function setupAdmin() {
    const { user } = await createWorkspaceMember();
    await db
      .update(schema.userTable)
      .set({ role: "admin" })
      .where(eq(schema.userTable.id, user.id));
    // Signup's cookie may still carry the pre-promotion role.
    mockAuthenticatedSession({ ...user, role: "user" });
    return { app: createApp().app, user };
  }

  it("persists settings, rejects concurrent stale updates, and restores defaults", async () => {
    const { app } = await setupAdmin();
    const put = (backend: string, version: number) =>
      app.request("/api/instance/storage", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ backend, version }),
      });
    expect((await app.request("/api/instance/storage")).status).toBe(200);
    const responses = await Promise.all([put("local", 0), put("local", 0)]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    const state = await (
      await createApp().app.request("/api/instance/storage")
    ).json();
    expect(state).toMatchObject({
      backend: "local",
      source: "database",
      version: 1,
    });
    expect((await put("default", 1)).status).toBe(200);
    expect(
      await (await app.request("/api/instance/storage")).json(),
    ).toMatchObject({ source: "environment", version: 2 });
  });

  it("rejects a revoked administrator even when the cookie still says admin", async () => {
    const { app, user } = await setupAdmin();
    mockAuthenticatedSession({ ...user, role: "admin" });
    await db
      .update(schema.userTable)
      .set({ role: "user" })
      .where(eq(schema.userTable.id, user.id));
    expect((await app.request("/api/instance/storage")).status).toBe(403);
    expect(
      (
        await app.request("/api/instance/storage", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ backend: "local", version: 0 }),
        })
      ).status,
    ).toBe(403);
    expect(
      await db.select().from(schema.instanceStorageSettingTable),
    ).toHaveLength(0);
  });

  it("does not clear an override when the deployment default is invalid", async () => {
    const { app } = await setupAdmin();
    const put = (backend: string, version: number) =>
      app.request("/api/instance/storage", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ backend, version }),
      });
    expect((await put("local", 0)).status).toBe(200);
    vi.stubEnv("STORAGE_BACKEND", "invalid");
    expect((await put("default", 1)).status).toBe(400);
    expect(
      await (await app.request("/api/instance/storage")).json(),
    ).toMatchObject({ backend: "local", source: "database", version: 1 });
  });
});
