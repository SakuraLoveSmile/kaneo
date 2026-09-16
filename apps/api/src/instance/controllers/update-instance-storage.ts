import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db, { schema } from "../../database";
import {
  checkStorageBackend,
  getInstanceStorageStatus,
  type InstanceStorageStatus,
  type StorageBackend,
} from "../../storage";
import { getStorageBackend } from "../../storage/shared";
import type { UpdateInstanceStorageInput } from "../schema";

export default async function updateInstanceStorage({
  input,
  userId,
}: {
  input: UpdateInstanceStorageInput;
  userId: string;
}): Promise<InstanceStorageStatus> {
  const isDefault = input.backend === "default" || input.backend === null;

  // 1. Resolve which backend needs to be probed
  let targetBackend: StorageBackend;
  if (isDefault) {
    try {
      targetBackend = getStorageBackend();
    } catch {
      throw new HTTPException(400, {
        message:
          "STORAGE_BACKEND must be local or s3. Settings were not changed.",
      });
    }
  } else {
    targetBackend = input.backend as StorageBackend;
  }

  // 2. Test target storage backend before updating database
  const checkResult = await checkStorageBackend(targetBackend);
  if (!checkResult.success) {
    throw new HTTPException(400, {
      message:
        checkResult.error ?? "Storage probe failed. Settings were not changed.",
    });
  }

  // 3. Atomically update settings with optimistic locking
  const persistedBackend = isDefault ? null : input.backend;

  if (input.version === 0) {
    const [inserted] = await db
      .insert(schema.instanceStorageSettingTable)
      .values({
        id: "default",
        backend: persistedBackend,
        version: 1,
        updatedBy: userId,
        updatedAt: new Date(),
      })
      .onConflictDoNothing()
      .returning();

    if (!inserted) {
      throw new HTTPException(409, {
        message:
          "Storage settings have been modified by another administrator. Please refresh.",
      });
    }
  } else {
    const [updated] = await db
      .update(schema.instanceStorageSettingTable)
      .set({
        backend: persistedBackend,
        version: input.version + 1,
        updatedBy: userId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.instanceStorageSettingTable.id, "default"),
          eq(schema.instanceStorageSettingTable.version, input.version),
        ),
      )
      .returning();

    if (!updated) {
      throw new HTTPException(409, {
        message:
          "Storage settings have been modified by another administrator. Please refresh.",
      });
    }
  }

  return getInstanceStorageStatus();
}
