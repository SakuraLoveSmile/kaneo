import { HTTPException } from "hono/http-exception";

type ResolveCompletedAtInput = {
  nextStatus: string;
  requestedCompletedAt: Date | null | undefined;
  previousStatus?: string;
  previousCompletedAt?: Date | null;
  now?: Date;
};

/**
 * Keeps completion time as a consequence of the final status while allowing
 * an explicit historical timestamp when a milestone is completed.
 */
export function resolveCompletedAt({
  nextStatus,
  requestedCompletedAt,
  previousStatus,
  previousCompletedAt,
  now = new Date(),
}: ResolveCompletedAtInput): Date | null {
  const isCompleted = nextStatus === "completed";

  if (!isCompleted) {
    if (requestedCompletedAt instanceof Date) {
      throw new HTTPException(400, {
        message: "completedAt can only be set for a completed milestone",
      });
    }
    return null;
  }

  if (requestedCompletedAt === null) {
    throw new HTTPException(400, {
      message: "completedAt cannot be null for a completed milestone",
    });
  }

  if (requestedCompletedAt instanceof Date) {
    if (requestedCompletedAt.getTime() > now.getTime()) {
      throw new HTTPException(400, {
        message: "completedAt cannot be in the future",
      });
    }
    return requestedCompletedAt;
  }

  if (previousStatus === "completed" && previousCompletedAt) {
    return previousCompletedAt;
  }

  return now;
}
