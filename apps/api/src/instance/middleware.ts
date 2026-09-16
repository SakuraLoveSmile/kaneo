import type { Context, Next } from "hono";
import { HTTPException } from "hono/http-exception";
import { isInstanceAdmin } from "../utils/is-instance-admin";

/**
 * Enforces that only an instance administrator's interactive session can access
 * instance settings.
 *
 * Explicitly rejects API keys, unauthenticated requests, and non-instance-admins
 * (including workspace admins / owners).
 */
export async function requireInstanceAdminSession(c: Context, next: Next) {
  // Reject API key requests even if they belong to an admin user
  if (c.get("apiKey")) {
    throw new HTTPException(403, {
      message: "API keys cannot manage instance storage settings.",
    });
  }

  const session = c.get("session");
  const user = c.get("user");
  if (!session || !user) {
    throw new HTTPException(401, {
      message: "Authentication required.",
    });
  }

  const admin = await isInstanceAdmin(c);
  if (!admin) {
    throw new HTTPException(403, {
      message: "Only instance administrators can manage instance storage.",
    });
  }

  await next();
}
