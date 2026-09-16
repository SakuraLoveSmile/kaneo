import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import instance from "../../../apps/api/src/instance";
import { requireInstanceAdminSession } from "../../../apps/api/src/instance/middleware";

const mockIsInstanceAdmin = vi.fn();
vi.mock("../../../apps/api/src/utils/is-instance-admin", () => ({
  isInstanceAdmin: () => mockIsInstanceAdmin(),
}));

const mockGetInstanceStorageStatus = vi.fn();
const mockCheckStorageBackend = vi.fn();
vi.mock("../../../apps/api/src/storage", () => ({
  getInstanceStorageStatus: () => mockGetInstanceStorageStatus(),
  checkStorageBackend: (backend: string) => mockCheckStorageBackend(backend),
}));

const mockDbInsert = vi.fn();
const mockDbUpdate = vi.fn();
vi.mock("../../../apps/api/src/database", () => {
  return {
    default: {
      insert: () => mockDbInsert(),
      update: () => mockDbUpdate(),
    },
    schema: {
      instanceStorageSettingTable: {
        id: "id",
        version: "version",
      },
    },
  };
});

describe("Instance Storage Management", () => {
  beforeEach(() => {
    mockIsInstanceAdmin.mockReset();
    mockGetInstanceStorageStatus.mockReset();
    mockCheckStorageBackend.mockReset();
    mockDbInsert.mockReset();
    mockDbUpdate.mockReset();
  });

  describe("requireInstanceAdminSession middleware", () => {
    function createTestApp(contextVars: Record<string, unknown>) {
      return new Hono()
        .use("*", async (c, next) => {
          for (const [k, v] of Object.entries(contextVars)) {
            c.set(k as any, v);
          }
          return next();
        })
        .get("/protected", requireInstanceAdminSession, (c) =>
          c.json({ ok: true }),
        );
    }

    it("rejects API keys even when belonging to an admin user", async () => {
      const app = createTestApp({
        apiKey: {
          id: "key-1",
          userId: "admin-1",
          enabled: true,
          permissions: null,
        },
        session: { id: "sess-1", userId: "admin-1" },
        user: { id: "admin-1", role: "admin" },
      });

      const res = await app.request("/protected");
      expect(res.status).toBe(403);
      const text = await res.text();
      expect(text).toContain("API keys cannot manage instance storage");
    });

    it("rejects unauthenticated requests without session or user", async () => {
      const app = createTestApp({
        session: null,
        user: null,
      });

      const res = await app.request("/protected");
      expect(res.status).toBe(401);
    });

    it("rejects authenticated non-admin users (members or workspace admins)", async () => {
      mockIsInstanceAdmin.mockResolvedValue(false);

      const app = createTestApp({
        session: { id: "sess-1", userId: "user-1" },
        user: { id: "user-1", role: "member" },
      });

      const res = await app.request("/protected");
      expect(res.status).toBe(403);
      const text = await res.text();
      expect(text).toContain("Only instance administrators");
    });

    it("allows instance administrators with an active session", async () => {
      mockIsInstanceAdmin.mockResolvedValue(true);

      const app = createTestApp({
        session: { id: "sess-1", userId: "admin-1" },
        user: { id: "admin-1", role: "admin" },
      });

      const res = await app.request("/protected");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ ok: true });
    });
  });

  describe("routes", () => {
    function createInstanceApp() {
      return new Hono()
        .use("*", async (c, next) => {
          c.set("session", { id: "sess-1", userId: "admin-1" });
          c.set("user", { id: "admin-1", role: "admin" });
          c.set("userId", "admin-1");
          return next();
        })
        .route("/instance", instance);
    }

    it("GET /instance/storage returns storage status", async () => {
      mockIsInstanceAdmin.mockResolvedValue(true);
      mockGetInstanceStorageStatus.mockResolvedValue({
        backend: "s3",
        source: "environment",
        version: 1,
        localConfigured: true,
        s3Configured: false,
        localReason: null,
        s3Reason: "S3 not configured",
      });

      const app = createInstanceApp();
      const res = await app.request("/instance/storage");
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.backend).toBe("s3");
      expect(data.source).toBe("environment");
      expect(data.version).toBe(1);
      expect(data.s3Configured).toBe(false);
    });

    it("POST /instance/storage/check runs availability probe", async () => {
      mockIsInstanceAdmin.mockResolvedValue(true);
      mockCheckStorageBackend.mockResolvedValue({
        backend: "local",
        success: true,
        checkedAt: "2026-09-16T12:00:00.000Z",
        error: null,
      });

      const app = createInstanceApp();
      const res = await app.request("/instance/storage/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backend: "local" }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.backend).toBe("local");
      expect(data.success).toBe(true);
      expect(mockCheckStorageBackend).toHaveBeenCalledWith("local");
    });

    it("PUT /instance/storage rejects update if target probe fails", async () => {
      mockIsInstanceAdmin.mockResolvedValue(true);
      mockCheckStorageBackend.mockResolvedValue({
        backend: "local",
        success: false,
        checkedAt: "2026-09-16T12:00:00.000Z",
        error: "Local storage directory is read-only.",
      });

      const app = createInstanceApp();
      const res = await app.request("/instance/storage", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backend: "local", version: 1 }),
      });

      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).toContain("Local storage directory is read-only.");
    });

    it("PUT /instance/storage rejects restore default if default backend probe fails", async () => {
      mockIsInstanceAdmin.mockResolvedValue(true);
      mockCheckStorageBackend.mockResolvedValue({
        backend: "s3",
        success: false,
        checkedAt: "2026-09-16T12:00:00.000Z",
        error: "S3 storage probe timed out.",
      });

      const app = createInstanceApp();
      const res = await app.request("/instance/storage", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backend: "default", version: 1 }),
      });

      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).toContain("S3 storage probe timed out.");
    });

    it("PUT /instance/storage updates storage when probe succeeds", async () => {
      mockIsInstanceAdmin.mockResolvedValue(true);
      mockCheckStorageBackend.mockResolvedValue({
        backend: "local",
        success: true,
        checkedAt: "2026-09-16T12:00:00.000Z",
        error: null,
      });

      mockDbUpdate.mockReturnValue({
        set: () => ({
          where: () => ({
            returning: async () => [
              { id: "default", backend: "local", version: 2 },
            ],
          }),
        }),
      });

      mockGetInstanceStorageStatus.mockResolvedValue({
        backend: "local",
        source: "database",
        version: 2,
        localConfigured: true,
        s3Configured: true,
      });

      const app = createInstanceApp();
      const res = await app.request("/instance/storage", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backend: "local", version: 1 }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.backend).toBe("local");
      expect(data.source).toBe("database");
      expect(data.version).toBe(2);
    });

    it("PUT /instance/storage returns 409 conflict when version does not match", async () => {
      mockIsInstanceAdmin.mockResolvedValue(true);
      mockCheckStorageBackend.mockResolvedValue({
        backend: "local",
        success: true,
        checkedAt: "2026-09-16T12:00:00.000Z",
        error: null,
      });

      // No row updated due to version mismatch
      mockDbUpdate.mockReturnValue({
        set: () => ({
          where: () => ({
            returning: async () => [],
          }),
        }),
      });

      const app = createInstanceApp();
      const res = await app.request("/instance/storage", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backend: "local", version: 1 }),
      });

      expect(res.status).toBe(409);
      const text = await res.text();
      expect(text).toContain("another administrator");
    });
  });
});
