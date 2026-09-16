import { afterEach, describe, expect, it } from "vitest";
import {
  getEffectiveStorageBackend,
  getInstanceStorageStatus,
  type StorageSettingsExecutor,
} from "../../../apps/api/src/storage/settings";

describe("storage settings resolution", () => {
  const originalEnv = {
    backend: process.env.STORAGE_BACKEND,
    localPath: process.env.LOCAL_STORAGE_PATH,
  };

  afterEach(() => {
    if (originalEnv.backend !== undefined) {
      process.env.STORAGE_BACKEND = originalEnv.backend;
    } else {
      delete process.env.STORAGE_BACKEND;
    }

    if (originalEnv.localPath !== undefined) {
      process.env.LOCAL_STORAGE_PATH = originalEnv.localPath;
    } else {
      delete process.env.LOCAL_STORAGE_PATH;
    }
  });

  it("prioritizes database setting over environment variable and default", async () => {
    process.env.STORAGE_BACKEND = "s3";

    const mockExecutor = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [{ backend: "local", version: 2 }],
          }),
        }),
      }),
    };

    const effective = await getEffectiveStorageBackend(
      mockExecutor as unknown as StorageSettingsExecutor,
    );
    expect(effective).toBe("local");

    const status = await getInstanceStorageStatus(
      mockExecutor as unknown as StorageSettingsExecutor,
    );
    expect(status.backend).toBe("local");
    expect(status.source).toBe("database");
    expect(status.version).toBe(2);
  });

  it("falls back to STORAGE_BACKEND when database setting is not set", async () => {
    process.env.STORAGE_BACKEND = "local";

    const mockExecutor = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [{ backend: null, version: 1 }],
          }),
        }),
      }),
    };

    const effective = await getEffectiveStorageBackend(
      mockExecutor as unknown as StorageSettingsExecutor,
    );
    expect(effective).toBe("local");

    const status = await getInstanceStorageStatus(
      mockExecutor as unknown as StorageSettingsExecutor,
    );
    expect(status.backend).toBe("local");
    expect(status.source).toBe("environment");
  });

  it("falls back to default s3 when both database and STORAGE_BACKEND are unset", async () => {
    delete process.env.STORAGE_BACKEND;

    const mockExecutor = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [],
          }),
        }),
      }),
    };

    const effective = await getEffectiveStorageBackend(
      mockExecutor as unknown as StorageSettingsExecutor,
    );
    expect(effective).toBe("s3");

    const status = await getInstanceStorageStatus(
      mockExecutor as unknown as StorageSettingsExecutor,
    );
    expect(status.backend).toBe("s3");
    expect(status.source).toBe("default");
  });

  it("rejects an invalid deployment default consistently", async () => {
    process.env.STORAGE_BACKEND = "invalid";
    const executor = {
      select: () => ({
        from: () => ({ where: () => ({ limit: async () => [] }) }),
      }),
    } as unknown as StorageSettingsExecutor;
    await expect(getEffectiveStorageBackend(executor)).rejects.toThrow(
      "Unsupported STORAGE_BACKEND",
    );
    await expect(getInstanceStorageStatus(executor)).rejects.toThrow(
      "Unsupported STORAGE_BACKEND",
    );
  });

  it("propagates database errors without silently falling back", async () => {
    const mockExecutor = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              throw new Error("PostgreSQL connection lost");
            },
          }),
        }),
      }),
    };

    await expect(
      getEffectiveStorageBackend(
        mockExecutor as unknown as StorageSettingsExecutor,
      ),
    ).rejects.toThrow("PostgreSQL connection lost");
  });
});
