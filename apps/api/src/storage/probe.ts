import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  assertSafePath,
  ensureLocalStorageReady,
  getLocalStorageRoot,
  isLocalStorageConfigured,
  resolveLocalObjectPath,
} from "./local";
import {
  applyKeyPrefix,
  getClient,
  getS3StorageConfigurationStatus,
  getStorageConfig,
} from "./s3";
import type { StorageBackend } from "./shared";

export type StorageCheckResult = {
  backend: StorageBackend;
  success: boolean;
  checkedAt: string;
  error: string | null;
};

const DEFAULT_PROBE_TIMEOUT_MS = 5000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 1000;

/** Bound the caller even when a filesystem operation or credential provider cannot abort. */
async function withDeadline<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  message: string,
  controller = new AbortController(),
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(message);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([run(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Local operations that finish after the deadline only unwind and clean their own file. */
export async function checkLocalStorage(
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<StorageCheckResult> {
  const checkedAt = new Date().toISOString();
  if (!isLocalStorageConfigured()) {
    return {
      backend: "local",
      success: false,
      checkedAt,
      error: "LOCAL_STORAGE_PATH is not configured in environment.",
    };
  }

  const controller = new AbortController();
  try {
    await withDeadline(
      async (signal) => {
        const root = getLocalStorageRoot();
        const probePath = resolveLocalObjectPath(
          root,
          `probe/probe-${randomBytes(16).toString("hex")}.bin`,
        );
        const payload = randomBytes(64);
        let owned = false;
        try {
          await ensureLocalStorageReady();
          signal.throwIfAborted();
          await assertSafePath(root, path.dirname(probePath));
          signal.throwIfAborted();
          await fs.mkdir(path.dirname(probePath), { recursive: true });
          signal.throwIfAborted();
          await assertSafePath(root, probePath);
          signal.throwIfAborted();
          const handle = await fs.open(probePath, "wx", 0o600);
          owned = true;
          try {
            signal.throwIfAborted();
            await handle.writeFile(payload);
          } finally {
            await handle.close();
          }
          signal.throwIfAborted();
          const bytes = await fs.readFile(probePath, { signal });
          signal.throwIfAborted();
          if (!bytes.equals(payload))
            throw new Error("Probe content mismatch.");
          await fs.unlink(probePath);
          owned = false;
          signal.throwIfAborted();
          try {
            await fs.stat(probePath);
            throw new Error("Probe cleanup failed.");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          signal.throwIfAborted();
        } finally {
          if (owned) {
            // This runs after an outstanding write/close settles, never before a late write.
            await withDeadline(
              async (cleanupSignal) => {
                await assertSafePath(root, probePath);
                cleanupSignal.throwIfAborted();
                await fs.unlink(probePath);
              },
              DEFAULT_CLEANUP_TIMEOUT_MS,
              "Cleanup timed out.",
            ).catch(() => {});
          }
        }
      },
      timeoutMs,
      "Local storage probe timed out.",
      controller,
    );
    return { backend: "local", success: true, checkedAt, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    let safeError = "Failed to access local storage directory.";
    if (controller.signal.aborted) safeError = "Local storage probe timed out.";
    else if (message.includes("content mismatch"))
      safeError = "Local storage probe content verification failed.";
    else if (message.includes("cleanup failed"))
      safeError = "Local storage probe cleanup failed.";
    return { backend: "local", success: false, checkedAt, error: safeError };
  }
}

/**
 * Executes a write/read/delete probe against S3 storage.
 *
 * Uses the connection configuration provided by the deployment environment.
 * Never discloses credentials or bucket paths.
 */
export async function checkS3Storage(
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<StorageCheckResult> {
  const checkedAt = new Date().toISOString();

  const configStatus = getS3StorageConfigurationStatus();
  if (!configStatus.configured) {
    return {
      backend: "s3",
      success: false,
      checkedAt,
      error: configStatus.reason ?? "S3 storage is not configured.",
    };
  }

  const probeId = `${Date.now()}-${randomBytes(8).toString("hex")}`;
  const relativeKey = `probe/probe-${probeId}.bin`;
  const payload = randomBytes(64);

  let key: string | undefined;
  let config: ReturnType<typeof getStorageConfig> | undefined;
  let activeBodyStream: { destroy?: (err?: Error) => void } | undefined;

  const probeAbortController = new AbortController();
  const abortBody = () => activeBodyStream?.destroy?.();
  probeAbortController.signal.addEventListener("abort", abortBody);

  try {
    await withDeadline(
      async (signal) => {
        config = getStorageConfig();
        const client = getClient(config);
        key = applyKeyPrefix(config.keyPrefix, relativeKey);

        // 1. Test write
        await client.send(
          new PutObjectCommand({
            Bucket: config.bucket,
            Key: key,
            Body: payload,
            ContentType: "application/octet-stream",
          }),
          { abortSignal: probeAbortController.signal },
        );

        // 2. Test read
        const getResponse = await client.send(
          new GetObjectCommand({
            Bucket: config.bucket,
            Key: key,
          }),
          { abortSignal: probeAbortController.signal },
        );

        if (!getResponse.Body) {
          throw new Error(
            "Probe verification failed: response body is missing.",
          );
        }

        const stream = getResponse.Body as AsyncIterable<Uint8Array> & {
          destroy?: (err?: Error) => void;
        };
        activeBodyStream = stream;
        if (signal.aborted) {
          stream.destroy?.();
          signal.throwIfAborted();
        }

        const chunks: Buffer[] = [];
        for await (const chunk of stream) {
          if (probeAbortController.signal.aborted) {
            throw new Error("S3 storage probe timed out.");
          }
          chunks.push(Buffer.from(chunk));
          if (
            chunks.reduce((size, item) => size + item.length, 0) >
            payload.length
          ) {
            throw new Error("Probe verification failed: content mismatch.");
          }
        }
        activeBodyStream = undefined;

        const readData = Buffer.concat(chunks);
        if (!readData.equals(payload)) {
          throw new Error("Probe verification failed: content mismatch.");
        }

        // 3. Test delete
        await client.send(
          new DeleteObjectCommand({
            Bucket: config.bucket,
            Key: key,
          }),
          { abortSignal: probeAbortController.signal },
        );

        // 4. Verify cleanup succeeded
        let objectStillExists = false;
        try {
          await client.send(
            new HeadObjectCommand({
              Bucket: config.bucket,
              Key: key,
            }),
            { abortSignal: probeAbortController.signal },
          );
          objectStillExists = true;
        } catch (headError: unknown) {
          if (probeAbortController.signal.aborted) {
            throw new Error("S3 storage probe timed out.");
          }

          const err = headError as {
            name?: string;
            $metadata?: { httpStatusCode?: number };
            message?: string;
          };

          if (
            err.name === "NotFound" ||
            err.name === "NoSuchKey" ||
            err.$metadata?.httpStatusCode === 404
          ) {
            // Confirmed: object is gone
          } else {
            // 403, 500, network errors, timeouts, etc. must fail the probe
            throw headError;
          }
        }

        if (objectStillExists) {
          throw new Error("Probe cleanup failed: object still exists in S3.");
        }

        signal.throwIfAborted();
      },
      timeoutMs,
      "S3 storage probe timed out.",
      probeAbortController,
    );
    return {
      backend: "s3",
      success: true,
      checkedAt,
      error: null,
    };
  } catch (error) {
    if (activeBodyStream) {
      try {
        activeBodyStream.destroy?.();
      } catch {
        // best effort stream release
      }
      activeBodyStream = undefined;
    }

    if (config && key) {
      const cleanupConfig = config;
      const cleanupKey = key;
      await withDeadline(
        async (signal) => {
          const client = getClient(cleanupConfig);
          await client.send(
            new DeleteObjectCommand({
              Bucket: cleanupConfig.bucket,
              Key: cleanupKey,
            }),
            { abortSignal: signal },
          );
        },
        DEFAULT_CLEANUP_TIMEOUT_MS,
        "Cleanup timed out.",
      ).catch(() => {});
    }

    const message = error instanceof Error ? error.message : "";
    const name = (error as { name?: string }).name || "";
    const statusCode = (error as { $metadata?: { httpStatusCode?: number } })
      ?.$metadata?.httpStatusCode;

    let safeError = "Failed to connect to S3 storage.";

    if (
      message.includes("timed out") ||
      message.includes("AbortError") ||
      name === "AbortError" ||
      probeAbortController.signal.aborted
    ) {
      safeError = "S3 storage probe timed out.";
    } else if (message.includes("content mismatch")) {
      safeError = "S3 storage probe content verification failed.";
    } else if (
      message.includes("cleanup failed") ||
      message.includes("still exists in S3")
    ) {
      safeError = "S3 storage probe cleanup failed.";
    } else if (name === "NoSuchBucket") {
      safeError = "S3 bucket does not exist.";
    } else if (
      name === "AccessDenied" ||
      name === "InvalidAccessKeyId" ||
      name === "SignatureDoesNotMatch" ||
      statusCode === 403
    ) {
      safeError = "S3 access denied or invalid credentials.";
    } else if (statusCode && statusCode >= 500 && statusCode < 600) {
      safeError = "S3 service returned a server error.";
    } else if (
      name === "EndpointConnectionError" ||
      message.includes("ENOTFOUND") ||
      message.includes("ECONNREFUSED") ||
      message.includes("EHOSTUNREACH")
    ) {
      safeError = "Unable to reach S3 endpoint.";
    }

    return {
      backend: "s3",
      success: false,
      checkedAt,
      error: safeError,
    };
  } finally {
    probeAbortController.signal.removeEventListener("abort", abortBody);
  }
}

/**
 * Runs the availability probe for the specified storage backend.
 */
export async function checkStorageBackend(
  backend: StorageBackend,
  timeoutMs?: number,
): Promise<StorageCheckResult> {
  if (backend === "local") {
    return checkLocalStorage(timeoutMs);
  }
  return checkS3Storage(timeoutMs);
}
