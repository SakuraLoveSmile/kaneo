import { type BuiltInRoleName, builtInRoles } from "@kaneo/permissions";
import { and, eq } from "drizzle-orm";
import type { Context, Next } from "hono";
import { HTTPException } from "hono/http-exception";
import db, { type DatabaseInstance, schema } from "../database";
import { isInstanceAdmin, isUserInstanceAdmin } from "./is-instance-admin";

type PermissionMap = Record<string, string[]>;

/**
 * Minimal query surface shared by the pool and an open transaction, so a
 * permission re-check inside a transaction reuses that transaction's
 * connection instead of taking another one from the pool.
 */
export type PermissionExecutor = Pick<DatabaseInstance, "select">;

function builtInRoleStatements(
  role: string,
): Record<string, readonly string[]> | null {
  if (role in builtInRoles) {
    return builtInRoles[role as BuiltInRoleName].statements as Record<
      string,
      readonly string[]
    >;
  }
  return null;
}

function parsePermissionStatements(
  raw: string,
): Record<string, readonly string[]> | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  // Only keep entries shaped like { [resource: string]: string[] }.
  // Anything malformed is dropped so `satisfies()` never calls
  // `.includes()` on a non-array.
  const result: Record<string, string[]> = {};
  for (const [resource, actions] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (!Array.isArray(actions)) continue;
    const filtered = actions.filter(
      (action): action is string => typeof action === "string",
    );
    if (filtered.length > 0) {
      result[resource] = filtered;
    }
  }
  return result;
}

async function customRoleStatements(
  workspaceId: string,
  role: string,
  executor: PermissionExecutor,
): Promise<Record<string, readonly string[]> | null> {
  const [row] = await executor
    .select({ permission: schema.workspaceRoleTable.permission })
    .from(schema.workspaceRoleTable)
    .where(
      and(
        eq(schema.workspaceRoleTable.workspaceId, workspaceId),
        eq(schema.workspaceRoleTable.role, role),
      ),
    )
    .limit(1);

  if (!row?.permission) return null;

  return parsePermissionStatements(row.permission);
}

function satisfies(
  statements: Record<string, readonly string[]>,
  required: PermissionMap,
): boolean {
  for (const [resource, actions] of Object.entries(required)) {
    const granted = statements[resource];
    if (!granted) return false;
    for (const action of actions) {
      if (!granted.includes(action)) return false;
    }
  }
  return true;
}

/**
 * Workspace permission check for a user id, without a request context.
 *
 * Shares the custom-role, built-in-role and instance-admin rules with the
 * middleware so an already-authorized long-running request (an upload PUT) can
 * re-check the requester instead of trusting the identity captured earlier.
 * API key scope is a separate concern and stays with the middleware.
 *
 * `executor` must be the caller's transaction when one is open. Falling back to
 * the pool from inside a transaction would need a second connection while the
 * first is still held, which deadlocks once as many transactions as pool slots
 * are in flight.
 */
export async function userHasWorkspacePermission({
  userId,
  workspaceId,
  permissions,
  isAdmin,
  executor = db,
}: {
  userId: string;
  workspaceId: string;
  permissions: PermissionMap;
  isAdmin?: boolean;
  executor?: PermissionExecutor;
}): Promise<boolean> {
  if (!userId || !workspaceId) return false;

  if (isAdmin ?? (await isUserInstanceAdmin(userId, executor))) return true;

  const [member] = await executor
    .select({ role: schema.workspaceUserTable.role })
    .from(schema.workspaceUserTable)
    .where(
      and(
        eq(schema.workspaceUserTable.workspaceId, workspaceId),
        eq(schema.workspaceUserTable.userId, userId),
      ),
    )
    .limit(1);

  if (!member?.role) return false;

  // Prefer the DB row when present so admin-edited defaults
  // (viewer/member/admin) take effect immediately. Falls back to the
  // compiled-in static definitions only when no row exists, which protects
  // viewer/member/admin users from a 403 if their workspace somehow
  // missed the seed (e.g., seed failed during workspace creation and
  // the boot-time backfill hasn't run yet).
  const statements =
    (await customRoleStatements(workspaceId, member.role, executor)) ??
    builtInRoleStatements(member.role);

  return Boolean(statements && satisfies(statements, permissions));
}

export async function hasWorkspacePermission(
  c: Context,
  permissions: PermissionMap,
) {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId) return false;

  const apiKey = c.get("apiKey") as
    | { permissions?: Record<string, string[]> | null }
    | undefined;
  if (apiKey?.permissions && !satisfies(apiKey.permissions, permissions)) {
    return false;
  }

  if (await isInstanceAdmin(c)) {
    return true;
  }

  const userId = c.get("userId");
  if (!userId) return false;

  return userHasWorkspacePermission({
    userId,
    workspaceId,
    permissions,
    // Already resolved above; skip the duplicate lookup.
    isAdmin: false,
  });
}

export function requireWorkspacePermission(permissions: PermissionMap) {
  return async (c: Context, next: Next) => {
    if (!c.get("workspaceId")) {
      throw new HTTPException(500, {
        message: "workspaceId not set in context",
      });
    }

    const apiKey = c.get("apiKey") as
      | { permissions?: Record<string, string[]> | null }
      | undefined;
    if (apiKey?.permissions && !satisfies(apiKey.permissions, permissions)) {
      throw new HTTPException(403, { message: "Insufficient API key scope" });
    }

    if (!(await hasWorkspacePermission(c, permissions))) {
      if (!c.get("userId")) {
        throw new HTTPException(401, { message: "Unauthorized" });
      }
      throw new HTTPException(403, { message: "Insufficient permissions" });
    }

    return next();
  };
}
