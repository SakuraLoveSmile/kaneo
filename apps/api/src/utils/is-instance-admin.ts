import { eq } from "drizzle-orm";
import type { Context } from "hono";
import db, { type DatabaseInstance } from "../database";
import { userTable } from "../database/schema";

/** Minimal query surface shared by the pool and an open transaction. */
export type InstanceAdminExecutor = Pick<DatabaseInstance, "select">;

/**
 * Instance-admin check for callers that only have a user id and no request
 * context, such as re-authorizing an in-flight upload.
 *
 * Pass the caller's transaction as `executor` when one is open.
 */
export async function isUserInstanceAdmin(
  userId: string,
  executor: InstanceAdminExecutor = db,
): Promise<boolean> {
  const [row] = await executor
    .select({ role: userTable.role })
    .from(userTable)
    .where(eq(userTable.id, userId))
    .limit(1);

  return row?.role === "admin";
}

export async function isInstanceAdmin(c: Context): Promise<boolean> {
  // Session cookies cache user roles for five minutes. Authorization must use
  // the current database role so promotion/revocation takes effect immediately.
  const userId = c.get("userId");
  if (!userId) return false;

  return isUserInstanceAdmin(userId);
}
