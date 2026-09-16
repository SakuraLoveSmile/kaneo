import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db, { schema } from "../database";
import { projectTable, taskTable } from "../database/schema";
import {
  apiRouter,
  createRoute,
  errorResponse,
  jsonResponse,
  z,
} from "../openapi";
import { userHasWorkspacePermission } from "../utils/require-workspace-permission";
import {
  discardStagedUpload,
  ensureLocalStorageReady,
  InvalidUploadError,
  LOCAL_UPLOAD_TOKEN_HEADER,
  publishStagedUpload,
  type StagedUpload,
  StorageUnavailableError,
  stageLocalUpload,
  UnsafeStoragePathError,
  UploadTooLargeError,
  verifyUploadToken,
} from "./local";
import { getMaxUploadBytes } from "./shared";

const TASK_UPDATE_PERMISSION = { task: ["update"] };

const uploadLocalObjectRoute = createRoute({
  method: "put",
  operationId: "uploadLocalObject",
  path: "/storage/local-upload/{uploadId}",
  tags: ["Assets"],
  summary: "Upload object bytes to local storage",
  description:
    "Uploads raw bytes for an upload created by the task image upload route. Requires the short-lived upload credential returned with the upload URL; it is not authenticated by session or API key. Only available when the instance is configured with local storage.",
  security: [],
  request: {
    params: z.object({
      uploadId: z.string().min(1).openapi({
        description: "The upload id returned by the create image upload route.",
      }),
    }),
    query: z.object({
      Expires: z.string().optional().openapi({
        description: "Unix seconds at which the upload credential expires.",
      }),
    }),
  },
  responses: {
    200: jsonResponse(
      "The uploaded object was stored",
      z
        .object({
          id: z.string(),
          key: z.string(),
          size: z.number().int().nonnegative(),
        })
        .openapi("LocalUploadResult"),
    ),
    400: errorResponse("The request body or upload key is invalid"),
    403: errorResponse("The upload credential is invalid or expired"),
    409: errorResponse("A different file already exists for this upload"),
    413: errorResponse("The upload exceeds the maximum allowed size"),
    503: errorResponse("Local storage is unavailable on this instance"),
  },
});

function toStorageException(error: unknown) {
  if (error instanceof UploadTooLargeError) {
    return new HTTPException(413, {
      message: "Upload exceeds the maximum allowed size.",
    });
  }

  if (error instanceof InvalidUploadError) {
    return new HTTPException(400, { message: error.message });
  }

  if (
    error instanceof StorageUnavailableError ||
    error instanceof UnsafeStoragePathError
  ) {
    return new HTTPException(503, { message: error.message });
  }

  console.error("Local upload failed", {
    error: error instanceof Error ? error.message : error,
  });

  return new HTTPException(503, {
    message: "Local storage is unavailable on this instance.",
  });
}

const localUploadRoutes = apiRouter().openapi(
  uploadLocalObjectRoute,
  async (c) => {
    const { uploadId } = c.req.valid("param");
    const token = c.req.header(LOCAL_UPLOAD_TOKEN_HEADER)?.trim() ?? "";
    const invalidCredential = new HTTPException(403, {
      message: "Invalid or expired upload credential.",
    });
    const noPermission = new HTTPException(403, {
      message: "The uploader no longer has permission to upload here.",
    });

    const [record] = await db
      .select()
      .from(schema.assetUploadTable)
      .where(eq(schema.assetUploadTable.id, uploadId))
      .limit(1);

    if (
      record?.backend !== "local" ||
      !verifyUploadToken(token, record.tokenHash)
    ) {
      throw invalidCredential;
    }

    const expiresParam = c.req.query("Expires");
    if (
      expiresParam !== undefined &&
      Number(expiresParam) !== Math.floor(record.expiresAt.getTime() / 1000)
    ) {
      throw invalidCredential;
    }

    if (record.expiresAt.getTime() <= Date.now()) {
      throw invalidCredential;
    }

    // The credential proves who requested the upload; the requester's current
    // access is what decides whether the bytes may still be accepted. Identity
    // comes from the record, never from the request.
    if (
      !record.createdBy ||
      !(await userHasWorkspacePermission({
        userId: record.createdBy,
        workspaceId: record.workspaceId,
        permissions: TASK_UPDATE_PERMISSION,
      }))
    ) {
      throw noPermission;
    }

    const maxBytes = getMaxUploadBytes();
    const declaredLength = Number(c.req.header("content-length") ?? "");

    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new HTTPException(413, {
        message: "Upload exceeds the maximum allowed size.",
      });
    }

    const body = c.req.raw.body;
    if (!body) {
      throw new HTTPException(400, { message: "A request body is required." });
    }

    let root: string;
    let staged: StagedUpload;

    try {
      root = await ensureLocalStorageReady();
      staged = await stageLocalUpload({
        root,
        key: record.objectKey,
        body,
        maxBytes,
        expectedSize: record.declaredSize,
      });
    } catch (error) {
      throw toStorageException(error);
    }

    const outcome = await publishUnderTaskLock({
      root,
      uploadId,
      staged,
    }).catch(async (error: unknown) => {
      // The staged file is disposable; a published one is not, so only the
      // staging path is cleaned up here.
      await discardStagedUpload(staged.tempPath);
      throw toStorageException(error);
    });

    if (outcome.status !== "ok") {
      await discardStagedUpload(staged.tempPath);

      if (outcome.status === "conflict") {
        throw new HTTPException(409, {
          message: "A different file already exists for this upload.",
        });
      }

      if (outcome.status === "forbidden") throw noPermission;
      if (outcome.status === "expired") throw invalidCredential;

      throw invalidCredential;
    }

    return c.json(
      { id: uploadId, key: record.objectKey, size: outcome.size },
      200,
    );
  },
);

type PublishOutcome =
  | { status: "ok"; size: number }
  | { status: "conflict" }
  | { status: "forbidden" }
  | { status: "expired" }
  | { status: "gone" };

/**
 * Publishes the staged bytes while holding the task row lock.
 *
 * The same lock is taken by task deletion, so the two operations are ordered:
 * either the upload lands first and the delete collects it, or the delete lands
 * first and the upload is refused without publishing anything.
 */
async function publishUnderTaskLock({
  root,
  uploadId,
  staged,
}: {
  root: string;
  uploadId: string;
  staged: StagedUpload;
}): Promise<PublishOutcome> {
  return db.transaction(async (tx) => {
    // Locks the owning task row. A missing row means the task was deleted, which
    // also cascaded the upload record away.
    const [lockedTask] = await tx
      .select({ id: taskTable.id, projectId: taskTable.projectId })
      .from(taskTable)
      .innerJoin(
        schema.assetUploadTable,
        eq(schema.assetUploadTable.taskId, taskTable.id),
      )
      .where(eq(schema.assetUploadTable.id, uploadId))
      .limit(1)
      .for("update", { of: taskTable });

    if (!lockedTask) return { status: "gone" };

    // Re-read under the lock: the record cannot change while the task row is held.
    const [record] = await tx
      .select()
      .from(schema.assetUploadTable)
      .where(eq(schema.assetUploadTable.id, uploadId))
      .limit(1);

    if (!record) return { status: "gone" };

    const [project] = await tx
      .select({ workspaceId: projectTable.workspaceId })
      .from(projectTable)
      .where(eq(projectTable.id, lockedTask.projectId))
      .limit(1);

    if (
      !project ||
      project.workspaceId !== record.workspaceId ||
      !record.createdBy ||
      !(await userHasWorkspacePermission({
        userId: record.createdBy,
        workspaceId: record.workspaceId,
        permissions: TASK_UPDATE_PERMISSION,
        // Reuse this transaction's connection: taking a second one from the
        // pool while holding the task row lock makes concurrent uploads fail
        // with 503 once the pool is drained.
        executor: tx,
      }))
    ) {
      return { status: "forbidden" };
    }

    if (record.expiresAt.getTime() <= Date.now()) {
      return { status: "expired" };
    }

    const published = await publishStagedUpload({
      root,
      key: record.objectKey,
      tempPath: staged.tempPath,
      size: staged.size,
      sha256: staged.sha256,
    });

    if (published.status === "conflict") return { status: "conflict" };

    // A retried PUT must not rewrite the metadata recorded by the first
    // successful upload.
    if (record.status !== "uploaded") {
      await tx
        .update(schema.assetUploadTable)
        .set({
          status: "uploaded",
          actualSize: published.size,
          sha256: published.sha256,
          uploadedAt: new Date(),
        })
        .where(eq(schema.assetUploadTable.id, uploadId));
    }

    return { status: "ok", size: published.size };
  });
}

export default localUploadRoutes;
