import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkLocalStorage,
  checkS3Storage,
} from "../../../apps/api/src/storage/probe";

describe("storage probe", () => {
  let root: string;
  const originalEnv = {
    localPath: process.env.LOCAL_STORAGE_PATH,
    s3Endpoint: process.env.S3_ENDPOINT,
    s3Bucket: process.env.S3_BUCKET,
    s3AccessKeyId: process.env.S3_ACCESS_KEY_ID,
    s3SecretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  };

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "kaneo-probe-test-"));
    process.env.LOCAL_STORAGE_PATH = root;
  });

  afterEach(async () => {
    if (originalEnv.localPath !== undefined) {
      process.env.LOCAL_STORAGE_PATH = originalEnv.localPath;
    } else {
      delete process.env.LOCAL_STORAGE_PATH;
    }

    if (originalEnv.s3Endpoint !== undefined) {
      process.env.S3_ENDPOINT = originalEnv.s3Endpoint;
    } else {
      delete process.env.S3_ENDPOINT;
    }

    if (originalEnv.s3Bucket !== undefined) {
      process.env.S3_BUCKET = originalEnv.s3Bucket;
    } else {
      delete process.env.S3_BUCKET;
    }

    if (originalEnv.s3AccessKeyId !== undefined) {
      process.env.S3_ACCESS_KEY_ID = originalEnv.s3AccessKeyId;
    } else {
      delete process.env.S3_ACCESS_KEY_ID;
    }

    if (originalEnv.s3SecretAccessKey !== undefined) {
      process.env.S3_SECRET_ACCESS_KEY = originalEnv.s3SecretAccessKey;
    } else {
      delete process.env.S3_SECRET_ACCESS_KEY;
    }

    await fs.rm(root, { recursive: true, force: true });
  });

  describe("checkLocalStorage", () => {
    it("successfully completes a write, read, and delete cycle on valid local storage", async () => {
      const result = await checkLocalStorage();
      expect(result.backend).toBe("local");
      expect(result.success).toBe(true);
      expect(result.error).toBeNull();
      expect(result.checkedAt).toBeDefined();

      // Probe file must be deleted upon completion
      const probeDir = path.join(root, "probe");
      const files = await fs.readdir(probeDir).catch(() => []);
      expect(files).toEqual([]);
    });

    it("returns by the deadline even if a directory operation cannot abort", async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const access = vi.spyOn(fs, "access").mockImplementationOnce(() => gate);
      const open = vi.spyOn(fs, "open");
      try {
        const result = await Promise.race([
          checkLocalStorage(20),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("deadline was not enforced")),
              500,
            ),
          ),
        ]);
        expect(result.success).toBe(false);
        expect(result.error).toBe("Local storage probe timed out.");
        release();
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(open).not.toHaveBeenCalled();
      } finally {
        release();
        access.mockRestore();
        open.mockRestore();
      }
    });

    it("cleans a late write only after that write settles", async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const originalOpen = fs.open.bind(fs);
      const open = vi
        .spyOn(fs, "open")
        .mockImplementationOnce(async (...args) => {
          const handle = await originalOpen(...args);
          const write = handle.writeFile.bind(handle);
          vi.spyOn(handle, "writeFile").mockImplementationOnce(
            async (...writeArgs) => {
              await gate;
              return write(...writeArgs);
            },
          );
          return handle;
        });
      try {
        const result = await checkLocalStorage(40);
        expect(result.error).toBe("Local storage probe timed out.");
        release();
        await vi.waitFor(async () => {
          expect(await fs.readdir(path.join(root, "probe"))).toEqual([]);
        });
      } finally {
        release();
        open.mockRestore();
      }
    });

    it("cleans its owned file when reading the probe fails", async () => {
      const read = vi
        .spyOn(fs, "readFile")
        .mockRejectedValueOnce(new Error("read failed"));
      try {
        expect((await checkLocalStorage()).success).toBe(false);
        expect(await fs.readdir(path.join(root, "probe"))).toEqual([]);
      } finally {
        read.mockRestore();
      }
    });

    it("fails cleanly when LOCAL_STORAGE_PATH is not configured", async () => {
      delete process.env.LOCAL_STORAGE_PATH;

      const result = await checkLocalStorage();
      expect(result.backend).toBe("local");
      expect(result.success).toBe(false);
      expect(result.error).toContain("LOCAL_STORAGE_PATH is not configured");
    });

    it("fails cleanly when local directory is read-only", async () => {
      await fs.chmod(root, 0o444);

      const result = await checkLocalStorage();
      expect(result.backend).toBe("local");
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();

      // Restore permission so cleanup can run
      await fs.chmod(root, 0o777);
    });
  });

  describe("checkS3Storage", () => {
    it("fails cleanly with actionable error when S3 is unconfigured", async () => {
      delete process.env.S3_ENDPOINT;
      delete process.env.S3_BUCKET;

      const result = await checkS3Storage();
      expect(result.backend).toBe("s3");
      expect(result.success).toBe(false);
      expect(result.error).toContain("S3_ENDPOINT and S3_BUCKET");
    });

    it("fails cleanly when S3 credentials are asymmetrical", async () => {
      process.env.S3_ENDPOINT = "http://localhost:9000";
      process.env.S3_BUCKET = "test-bucket";
      process.env.S3_ACCESS_KEY_ID = "key-without-secret";
      delete process.env.S3_SECRET_ACCESS_KEY;

      const result = await checkS3Storage();
      expect(result.backend).toBe("s3");
      expect(result.success).toBe(false);
      expect(result.error).toContain("Incomplete S3 credentials");
    });

    it("does not leak raw SDK errors or credentials", async () => {
      process.env.S3_ENDPOINT = "http://127.0.0.1:1";
      process.env.S3_BUCKET = "unreachable-bucket";
      process.env.S3_ACCESS_KEY_ID = "my-secret-key-id";
      process.env.S3_SECRET_ACCESS_KEY = "super-secret-password-1234";

      const result = await checkS3Storage(500);
      expect(result.backend).toBe("s3");
      expect(result.success).toBe(false);
      expect(result.error).not.toContain("my-secret-key-id");
      expect(result.error).not.toContain("super-secret-password-1234");
    });

    describe("controlled HTTP mock server tests", () => {
      let server: http.Server;
      let serverUrl: string;
      let behavior: {
        hang?: boolean;
        putDelay?: number;
        putStatus?: number;
        getDelay?: number;
        getStatus?: number;
        corruptGet?: boolean;
        stalledBody?: boolean;
        oversizedBody?: boolean;
        deleteDelay?: number;
        deleteStatus?: number;
        headStatus?: number;
      } = {};
      let storedBody: Buffer | null = null;

      beforeEach(async () => {
        behavior = {};
        storedBody = null;
        server = http.createServer(async (req, res) => {
          if (behavior.hang) {
            // Do not respond at all
            return;
          }

          const method = req.method;
          if (method === "PUT") {
            if (behavior.putDelay) {
              await new Promise((r) => setTimeout(r, behavior.putDelay));
            }
            if (behavior.putStatus && behavior.putStatus !== 200) {
              res.writeHead(behavior.putStatus);
              res.end();
              return;
            }
            const chunks: Buffer[] = [];
            req.on("data", (chunk) => chunks.push(chunk));
            req.on("end", () => {
              storedBody = Buffer.concat(chunks);
              res.writeHead(200, { etag: '"mock-etag"' });
              res.end();
            });
            return;
          }

          if (method === "GET") {
            if (behavior.getDelay) {
              await new Promise((r) => setTimeout(r, behavior.getDelay));
            }
            if (behavior.getStatus && behavior.getStatus !== 200) {
              res.writeHead(behavior.getStatus);
              res.end();
              return;
            }
            const body = behavior.corruptGet
              ? Buffer.from("corrupted-content-mismatch")
              : (storedBody ?? Buffer.from("fallback"));
            res.writeHead(200, { "content-type": "application/octet-stream" });
            if (behavior.stalledBody) {
              res.write(body.subarray(0, 1));
              return;
            }
            res.end(behavior.oversizedBody ? Buffer.alloc(1024) : body);
            return;
          }

          if (method === "DELETE") {
            if (behavior.deleteDelay) {
              await new Promise((r) => setTimeout(r, behavior.deleteDelay));
            }
            if (behavior.deleteStatus && behavior.deleteStatus !== 204) {
              res.writeHead(behavior.deleteStatus);
              res.end();
              return;
            }
            storedBody = null;
            res.writeHead(204);
            res.end();
            return;
          }

          if (method === "HEAD") {
            if (behavior.headStatus) {
              res.writeHead(behavior.headStatus);
              res.end();
              return;
            }
            if (storedBody === null) {
              res.writeHead(404);
              res.end();
            } else {
              res.writeHead(200);
              res.end();
            }
            return;
          }

          res.writeHead(404);
          res.end();
        });

        await new Promise<void>((resolve) => {
          server.listen(0, "127.0.0.1", () => resolve());
        });

        const address = server.address() as AddressInfo;
        serverUrl = `http://127.0.0.1:${address.port}`;

        process.env.S3_ENDPOINT = serverUrl;
        process.env.S3_BUCKET = "test-bucket";
        process.env.S3_ACCESS_KEY_ID = "mock-key";
        process.env.S3_SECRET_ACCESS_KEY = "mock-secret";
        process.env.S3_FORCE_PATH_STYLE = "true";
      });

      afterEach(async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
      });

      it("succeeds when normal write, read, delete, and 404 head occur", async () => {
        const result = await checkS3Storage(2000);
        expect(result.backend).toBe("s3");
        expect(result.success).toBe(true);
        expect(result.error).toBeNull();
      });

      it("times out cleanly when server is unresponsive", async () => {
        behavior.hang = true;
        const result = await checkS3Storage(400);
        expect(result.backend).toBe("s3");
        expect(result.success).toBe(false);
        expect(result.error).toBe("S3 storage probe timed out.");
      });

      it("times out cleanly when write is delayed past timeout", async () => {
        behavior.putDelay = 600;
        const result = await checkS3Storage(300);
        expect(result.backend).toBe("s3");
        expect(result.success).toBe(false);
        expect(result.error).toBe("S3 storage probe timed out.");
      });

      it("times out and releases a response body that never finishes", async () => {
        behavior.stalledBody = true;
        const started = Date.now();
        const result = await checkS3Storage(100);
        expect(result.success).toBe(false);
        expect(result.error).toBe("S3 storage probe timed out.");
        expect(Date.now() - started).toBeLessThan(1500);
      });

      it("rejects an oversized response without retaining arbitrary data", async () => {
        behavior.oversizedBody = true;
        expect((await checkS3Storage(1000)).error).toContain(
          "content verification failed",
        );
      });

      it("fails when delete fails", async () => {
        behavior.deleteStatus = 500;
        const result = await checkS3Storage(2000);
        expect(result.backend).toBe("s3");
        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();
      });

      it("fails when HEAD returns 403 Forbidden", async () => {
        behavior.headStatus = 403;
        const result = await checkS3Storage(2000);
        expect(result.backend).toBe("s3");
        expect(result.success).toBe(false);
        expect(result.error).toContain(
          "S3 access denied or invalid credentials.",
        );
      });

      it("fails when HEAD returns 500 Server Error", async () => {
        behavior.headStatus = 500;
        const result = await checkS3Storage(2000);
        expect(result.backend).toBe("s3");
        expect(result.success).toBe(false);
        expect(result.error).toContain("S3 service returned a server error.");
      });

      it("fails when HEAD indicates object still exists after delete", async () => {
        behavior.headStatus = 200;
        const result = await checkS3Storage(2000);
        expect(result.backend).toBe("s3");
        expect(result.success).toBe(false);
        expect(result.error).toBe("S3 storage probe cleanup failed.");
      });

      it("fails when content read does not match content written", async () => {
        behavior.corruptGet = true;
        const result = await checkS3Storage(2000);
        expect(result.backend).toBe("s3");
        expect(result.success).toBe(false);
        expect(result.error).toBe(
          "S3 storage probe content verification failed.",
        );
      });

      it("preserves client usability after a timed out request", async () => {
        behavior.hang = true;
        const timedOut = await checkS3Storage(300);
        expect(timedOut.success).toBe(false);

        behavior.hang = false;
        const nextResult = await checkS3Storage(2000);
        expect(nextResult.success).toBe(true);
      });
    });
  });
});
