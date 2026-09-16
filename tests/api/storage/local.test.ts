import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupStaleLocalTempFiles } from "../../../apps/api/src/storage/cleanup-uploads";
import {
  createLocalUploadToken,
  deleteLocalObject,
  ensureLocalStorageReady,
  getLocalTempDir,
  InvalidUploadError,
  readLocalObject,
  resolveLocalObjectPath,
  StorageUnavailableError,
  statLocalObject,
  storeLocalUpload,
  UploadTooLargeError,
  verifyStoredLocalObject,
  verifyUploadToken,
} from "../../../apps/api/src/storage/local";
import {
  getMaxUploadBytes,
  getStorageBackend,
  getUploadTtlSeconds,
} from "../../../apps/api/src/storage/shared";

function toWebStream(chunks: Uint8Array[]) {
  return Readable.toWeb(
    Readable.from(chunks),
  ) as unknown as ReadableStream<Uint8Array>;
}

async function readStream(body: unknown) {
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Buffer>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

const KEY = "workspace/ws/project/pr/task/tk/descriptions/image.png";

describe("local storage", () => {
  let root: string;
  const originalEnv = {
    backend: process.env.STORAGE_BACKEND,
    localPath: process.env.LOCAL_STORAGE_PATH,
    maxBytes: process.env.STORAGE_MAX_UPLOAD_BYTES,
    legacyMaxBytes: process.env.S3_MAX_IMAGE_UPLOAD_BYTES,
    ttl: process.env.STORAGE_UPLOAD_URL_TTL_SECONDS,
    legacyTtl: process.env.S3_PRESIGN_TTL_SECONDS,
  };

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "kaneo-local-"));
    process.env.LOCAL_STORAGE_PATH = root;
    delete process.env.STORAGE_BACKEND;
    delete process.env.STORAGE_MAX_UPLOAD_BYTES;
    delete process.env.S3_MAX_IMAGE_UPLOAD_BYTES;
    delete process.env.STORAGE_UPLOAD_URL_TTL_SECONDS;
    delete process.env.S3_PRESIGN_TTL_SECONDS;
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });

    for (const [key, value] of Object.entries({
      STORAGE_BACKEND: originalEnv.backend,
      LOCAL_STORAGE_PATH: originalEnv.localPath,
      STORAGE_MAX_UPLOAD_BYTES: originalEnv.maxBytes,
      S3_MAX_IMAGE_UPLOAD_BYTES: originalEnv.legacyMaxBytes,
      STORAGE_UPLOAD_URL_TTL_SECONDS: originalEnv.ttl,
      S3_PRESIGN_TTL_SECONDS: originalEnv.legacyTtl,
    })) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  describe("backend configuration", () => {
    it("defaults to s3 so upgrades do not switch storage silently", () => {
      expect(getStorageBackend()).toBe("s3");
    });

    it("accepts an explicit local backend", () => {
      process.env.STORAGE_BACKEND = "LOCAL";
      expect(getStorageBackend()).toBe("local");
    });

    it("rejects an unknown backend", () => {
      process.env.STORAGE_BACKEND = "gcs";
      expect(() => getStorageBackend()).toThrow(/Unsupported STORAGE_BACKEND/);
    });

    it("prefers STORAGE_MAX_UPLOAD_BYTES over the legacy S3 variable", () => {
      process.env.S3_MAX_IMAGE_UPLOAD_BYTES = "100";
      expect(getMaxUploadBytes()).toBe(100);

      process.env.STORAGE_MAX_UPLOAD_BYTES = "200";
      expect(getMaxUploadBytes()).toBe(200);
    });

    it("prefers STORAGE_UPLOAD_URL_TTL_SECONDS over the legacy S3 variable", () => {
      process.env.S3_PRESIGN_TTL_SECONDS = "60";
      expect(getUploadTtlSeconds()).toBe(60);

      process.env.STORAGE_UPLOAD_URL_TTL_SECONDS = "90";
      expect(getUploadTtlSeconds()).toBe(90);
    });

    it("requires an absolute LOCAL_STORAGE_PATH", async () => {
      process.env.LOCAL_STORAGE_PATH = "relative/uploads";
      await expect(ensureLocalStorageReady()).rejects.toBeInstanceOf(
        StorageUnavailableError,
      );
    });

    it("requires LOCAL_STORAGE_PATH to be set", async () => {
      delete process.env.LOCAL_STORAGE_PATH;
      await expect(ensureLocalStorageReady()).rejects.toBeInstanceOf(
        StorageUnavailableError,
      );
    });

    it("creates the root and temp directories", async () => {
      const nested = path.join(root, "nested", "uploads");
      process.env.LOCAL_STORAGE_PATH = nested;

      await expect(ensureLocalStorageReady()).resolves.toBe(nested);
      await expect(fs.stat(getLocalTempDir(nested))).resolves.toBeDefined();
    });
  });

  describe("path safety", () => {
    it("rejects parent traversal", () => {
      expect(() => resolveLocalObjectPath(root, "../escape.png")).toThrow(
        InvalidUploadError,
      );
      expect(() =>
        resolveLocalObjectPath(root, "workspace/../../escape.png"),
      ).toThrow(InvalidUploadError);
    });

    it("rejects absolute paths and empty segments", () => {
      expect(() => resolveLocalObjectPath(root, "/etc/passwd")).toThrow(
        InvalidUploadError,
      );
      expect(() =>
        resolveLocalObjectPath(root, "workspace//image.png"),
      ).toThrow(InvalidUploadError);
      expect(() =>
        resolveLocalObjectPath(root, "workspace/./image.png"),
      ).toThrow(InvalidUploadError);
      expect(() => resolveLocalObjectPath(root, "")).toThrow(
        InvalidUploadError,
      );
    });

    it("rejects NUL bytes", () => {
      expect(() => resolveLocalObjectPath(root, "workspace/a\0b.png")).toThrow(
        InvalidUploadError,
      );
    });

    it("resolves a valid key inside the root", () => {
      expect(resolveLocalObjectPath(root, KEY)).toBe(
        path.join(root, ...KEY.split("/")),
      );
    });
  });

  describe("upload tokens", () => {
    it("verifies the matching token only", () => {
      const { token, tokenHash } = createLocalUploadToken();

      expect(token.length).toBeGreaterThan(20);
      expect(verifyUploadToken(token, tokenHash)).toBe(true);
      expect(verifyUploadToken("nope", tokenHash)).toBe(false);
      expect(verifyUploadToken("", tokenHash)).toBe(false);
      expect(verifyUploadToken(token, "")).toBe(false);
    });

    it("does not store the token verbatim", () => {
      const { token, tokenHash } = createLocalUploadToken();
      expect(tokenHash).not.toContain(token);
      expect(tokenHash).toHaveLength(64);
    });
  });

  describe("storing uploads", () => {
    it("stores bytes and reports the real size and checksum", async () => {
      const bytes = Buffer.from("hello kaneo");
      const result = await storeLocalUpload({
        root,
        key: KEY,
        body: toWebStream([bytes]),
        maxBytes: 1024,
      });

      expect(result).toMatchObject({
        status: "stored",
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });

      const stored = await fs.readFile(path.join(root, ...KEY.split("/")));
      expect(stored.equals(bytes)).toBe(true);
    });

    it("rejects an oversized upload and leaves nothing readable behind", async () => {
      const bytes = Buffer.alloc(64, 1);

      await expect(
        storeLocalUpload({
          root,
          key: KEY,
          body: toWebStream([bytes]),
          maxBytes: 16,
        }),
      ).rejects.toBeInstanceOf(UploadTooLargeError);

      await expect(
        fs.stat(path.join(root, ...KEY.split("/"))),
      ).rejects.toThrow();
      await expect(fs.readdir(getLocalTempDir(root))).resolves.toEqual([]);
    });

    it("enforces the cap while streaming rather than trusting the declared size", async () => {
      const chunks = [
        Buffer.alloc(8, 1),
        Buffer.alloc(8, 1),
        Buffer.alloc(8, 1),
      ];

      await expect(
        storeLocalUpload({
          root,
          key: KEY,
          body: toWebStream(chunks),
          maxBytes: 20,
        }),
      ).rejects.toBeInstanceOf(UploadTooLargeError);
    });

    it("rejects a body shorter than the declared size without publishing", async () => {
      await expect(
        storeLocalUpload({
          root,
          key: KEY,
          body: toWebStream([Buffer.alloc(4, 1)]),
          maxBytes: 1024,
          expectedSize: 8,
        }),
      ).rejects.toBeInstanceOf(InvalidUploadError);

      await expect(
        fs.stat(path.join(root, ...KEY.split("/"))),
      ).rejects.toThrow();
      await expect(fs.readdir(getLocalTempDir(root))).resolves.toEqual([]);
    });

    it("rejects a body longer than the declared size without publishing", async () => {
      await expect(
        storeLocalUpload({
          root,
          key: KEY,
          body: toWebStream([Buffer.alloc(12, 1)]),
          maxBytes: 1024,
          expectedSize: 8,
        }),
      ).rejects.toBeInstanceOf(InvalidUploadError);

      await expect(
        fs.stat(path.join(root, ...KEY.split("/"))),
      ).rejects.toThrow();
      await expect(fs.readdir(getLocalTempDir(root))).resolves.toEqual([]);
    });

    it("keeps a published file when a repeat PUT declares the wrong size", async () => {
      const bytes = Buffer.from("original-bytes");
      await storeLocalUpload({
        root,
        key: KEY,
        body: toWebStream([bytes]),
        maxBytes: 1024,
      });

      await expect(
        storeLocalUpload({
          root,
          key: KEY,
          body: toWebStream([bytes]),
          maxBytes: 1024,
          expectedSize: bytes.length + 5,
        }),
      ).rejects.toBeInstanceOf(InvalidUploadError);

      const stored = await fs.readFile(path.join(root, ...KEY.split("/")));
      expect(stored.equals(bytes)).toBe(true);
    });

    it("treats identical repeated uploads as a duplicate", async () => {
      const bytes = Buffer.from("same bytes");

      const first = await storeLocalUpload({
        root,
        key: KEY,
        body: toWebStream([bytes]),
        maxBytes: 1024,
      });
      const second = await storeLocalUpload({
        root,
        key: KEY,
        body: toWebStream([bytes]),
        maxBytes: 1024,
      });

      expect(first.status).toBe("stored");
      expect(second.status).toBe("duplicate");
    });

    it("conflicts on different bytes for the same key without overwriting", async () => {
      const original = Buffer.from("original");
      await storeLocalUpload({
        root,
        key: KEY,
        body: toWebStream([original]),
        maxBytes: 1024,
      });

      const conflicting = await storeLocalUpload({
        root,
        key: KEY,
        body: toWebStream([Buffer.from("different")]),
        maxBytes: 1024,
      });

      expect(conflicting.status).toBe("conflict");
      const stored = await fs.readFile(path.join(root, ...KEY.split("/")));
      expect(stored.equals(original)).toBe(true);
    });

    it("keeps one intact file under concurrent identical uploads", async () => {
      const bytes = Buffer.alloc(2048, 7);

      const results = await Promise.all([
        storeLocalUpload({
          root,
          key: KEY,
          body: toWebStream([bytes]),
          maxBytes: 4096,
        }),
        storeLocalUpload({
          root,
          key: KEY,
          body: toWebStream([bytes]),
          maxBytes: 4096,
        }),
      ]);

      expect(results.map((result) => result.status).sort()).toEqual([
        "duplicate",
        "stored",
      ]);

      const stored = await fs.readFile(path.join(root, ...KEY.split("/")));
      expect(stored.equals(bytes)).toBe(true);
      await expect(fs.readdir(getLocalTempDir(root))).resolves.toEqual([]);
    });

    it("publishes nothing when the body fails mid-stream", async () => {
      const failing = Readable.from(
        (async function* () {
          yield Buffer.from("partial");
          throw new Error("connection reset");
        })(),
      );

      await expect(
        storeLocalUpload({
          root,
          key: KEY,
          body: Readable.toWeb(
            failing,
          ) as unknown as ReadableStream<Uint8Array>,
          maxBytes: 1024,
        }),
      ).rejects.toBeInstanceOf(InvalidUploadError);

      await expect(
        fs.stat(path.join(root, ...KEY.split("/"))),
      ).rejects.toThrow();
      await expect(fs.readdir(getLocalTempDir(root))).resolves.toEqual([]);
    });
  });

  describe("reading and verifying", () => {
    it("reads a stored object back with its size", async () => {
      const bytes = Buffer.from("readable");
      await storeLocalUpload({
        root,
        key: KEY,
        body: toWebStream([bytes]),
        maxBytes: 1024,
      });

      const object = await readLocalObject(root, KEY);
      expect(object.contentLength).toBe(bytes.length);
      expect((await readStream(object.body)).equals(bytes)).toBe(true);
    });

    it("reports a missing object", async () => {
      await expect(readLocalObject(root, KEY)).rejects.toThrow();
    });

    it("refuses to read a symlink", async () => {
      const target = path.join(root, "outside.png");
      await fs.writeFile(target, "secret");
      const linkPath = path.join(root, ...KEY.split("/"));
      await fs.mkdir(path.dirname(linkPath), { recursive: true });
      await fs.symlink(target, linkPath);

      await expect(readLocalObject(root, KEY)).rejects.toThrow();
    });

    it("verifies size and checksum", async () => {
      const bytes = Buffer.from("verify me");
      await storeLocalUpload({
        root,
        key: KEY,
        body: toWebStream([bytes]),
        maxBytes: 1024,
      });

      await expect(
        verifyStoredLocalObject({
          root,
          key: KEY,
          expectedSize: bytes.length,
          expectedSha256: createHash("sha256").update(bytes).digest("hex"),
        }),
      ).resolves.toEqual({
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });

      await expect(
        verifyStoredLocalObject({
          root,
          key: KEY,
          expectedSize: bytes.length + 1,
          expectedSha256: null,
        }),
      ).rejects.toBeInstanceOf(InvalidUploadError);

      await expect(
        verifyStoredLocalObject({
          root,
          key: KEY,
          expectedSize: null,
          expectedSha256: "0".repeat(64),
        }),
      ).rejects.toBeInstanceOf(InvalidUploadError);
    });

    it("computes the checksum for a recovery finalize", async () => {
      const bytes = Buffer.from("recovered");
      await storeLocalUpload({
        root,
        key: KEY,
        body: toWebStream([bytes]),
        maxBytes: 1024,
      });

      await expect(
        verifyStoredLocalObject({
          root,
          key: KEY,
          expectedSize: bytes.length,
          expectedSha256: null,
        }),
      ).resolves.toEqual({
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    });
  });

  describe("deletion", () => {
    it("removes a stored object", async () => {
      await storeLocalUpload({
        root,
        key: KEY,
        body: toWebStream([Buffer.from("bye")]),
        maxBytes: 1024,
      });

      await deleteLocalObject(root, KEY);
      await expect(
        fs.stat(path.join(root, ...KEY.split("/"))),
      ).rejects.toThrow();
    });

    it("ignores a missing object", async () => {
      await expect(deleteLocalObject(root, KEY)).resolves.toBeUndefined();
    });
  });

  describe("symlinked parent directories", () => {
    let outside: string;
    // The link replaces the object path's first segment, so the target tree
    // holds the remaining segments.
    const outsideFile = () => path.join(outside, ...KEY.split("/").slice(1));

    beforeEach(async () => {
      outside = await fs.mkdtemp(path.join(os.tmpdir(), "kaneo-outside-"));
      await fs.mkdir(path.dirname(outsideFile()), { recursive: true });
      await fs.writeFile(outsideFile(), "secret");
      await fs.symlink(
        outside,
        path.join(root, KEY.split("/")[0] ?? ""),
        "dir",
      );
    });

    afterEach(async () => {
      await fs.rm(outside, { recursive: true, force: true });
    });

    it("refuses to stat, read, verify or delete through a symlinked parent", async () => {
      await expect(statLocalObject(root, KEY)).rejects.toThrow();
      await expect(readLocalObject(root, KEY)).rejects.toThrow();
      await expect(
        verifyStoredLocalObject({
          root,
          key: KEY,
          expectedSize: null,
          expectedSha256: null,
        }),
      ).rejects.toThrow();
      await expect(deleteLocalObject(root, KEY)).rejects.toThrow();
    });

    it("refuses to publish through a symlinked parent", async () => {
      await expect(
        storeLocalUpload({
          root,
          key: KEY,
          body: toWebStream([Buffer.from("replacement")]),
          maxBytes: 1024,
        }),
      ).rejects.toThrow();
    });

    it("leaves the target file untouched after refused operations", async () => {
      await deleteLocalObject(root, KEY).catch(() => {});
      await storeLocalUpload({
        root,
        key: KEY,
        body: toWebStream([Buffer.from("replacement")]),
        maxBytes: 1024,
      }).catch(() => {});

      await expect(fs.readFile(outsideFile(), "utf8")).resolves.toBe("secret");
    });
  });

  describe("storage root availability for deletion", () => {
    async function storeOne() {
      await storeLocalUpload({
        root,
        key: KEY,
        body: toWebStream([Buffer.from("queued-bytes")]),
        maxBytes: 1024,
      });
      return path.join(root, ...KEY.split("/"));
    }

    it("treats a missing root as a failure, not as an already-deleted file", async () => {
      const filePath = await storeOne();
      const moved = `${root}-moved`;

      await fs.rename(root, moved);

      try {
        await expect(deleteLocalObject(root, KEY)).rejects.toBeInstanceOf(
          StorageUnavailableError,
        );
        // The file must survive: the volume may come back.
        await expect(
          fs.stat(path.join(moved, ...KEY.split("/"))),
        ).resolves.toBeDefined();
      } finally {
        await fs.rename(moved, root);
      }

      expect(filePath).toBe(path.join(root, ...KEY.split("/")));
    });

    it("treats a root replaced by a regular file as unavailable", async () => {
      await storeOne();
      const moved = `${root}-moved-file`;

      await fs.rename(root, moved);
      await fs.writeFile(root, "not a directory");

      try {
        await expect(deleteLocalObject(root, KEY)).rejects.toBeInstanceOf(
          StorageUnavailableError,
        );
      } finally {
        await fs.rm(root, { force: true });
        await fs.rename(moved, root);
      }
    });

    it("still treats a missing file under a healthy root as deleted", async () => {
      await expect(deleteLocalObject(root, KEY)).resolves.toBeUndefined();
    });

    it("deletes normally once the root is restored", async () => {
      await storeOne();
      const moved = `${root}-moved-retry`;

      await fs.rename(root, moved);
      await expect(deleteLocalObject(root, KEY)).rejects.toBeInstanceOf(
        StorageUnavailableError,
      );
      await fs.rename(moved, root);

      await expect(deleteLocalObject(root, KEY)).resolves.toBeUndefined();
      await expect(
        fs.stat(path.join(root, ...KEY.split("/"))),
      ).rejects.toThrow();
    });
  });

  describe("stale temp cleanup", () => {
    it("removes expired part files and keeps fresh ones", async () => {
      const tempDir = getLocalTempDir(root);
      await fs.mkdir(tempDir, { recursive: true });

      const stale = path.join(tempDir, "stale.part");
      const fresh = path.join(tempDir, "fresh.part");
      await fs.writeFile(stale, "partial");
      await fs.writeFile(fresh, "partial");

      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      await fs.utimes(stale, twoHoursAgo, twoHoursAgo);

      const result = await cleanupStaleLocalTempFiles(
        root,
        new Date(Date.now() - 60 * 60 * 1000),
      );

      expect(result).toEqual({ count: 1, failed: false });
      await expect(fs.stat(stale)).rejects.toThrow();
      await expect(fs.stat(fresh)).resolves.toBeDefined();
    });

    it("tolerates a missing temp directory", async () => {
      const result = await cleanupStaleLocalTempFiles(root, new Date());
      expect(result).toEqual({ count: 0, failed: false });
    });
  });
});
