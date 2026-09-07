import {
  apiRouter,
  createRoute,
  errorResponse,
  jsonResponse,
} from "../openapi";
import { requireWorkspacePermission } from "../utils/require-workspace-permission";
import {
  validateAndParseDate,
  validateAndParseMilestoneCalendarDate,
  validateDateRange,
} from "../utils/validate-dates";
import { workspaceAccess } from "../utils/workspace-access-middleware";
import createMilestone from "./controllers/create-milestone";
import deleteMilestone from "./controllers/delete-milestone";
import getMilestone from "./controllers/get-milestone";
import getMilestones from "./controllers/get-milestones";
import updateMilestone from "./controllers/update-milestone";
import {
  milestoneListSchema,
  milestoneSchema,
  milestoneSummarySchema,
} from "./response";
import {
  createMilestoneBody,
  milestoneParam,
  projectIdParam,
  updateMilestoneBody,
} from "./schema";

function parseOptionalCalendarDate(
  value: string | null | undefined,
  field: string,
) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return validateAndParseMilestoneCalendarDate(value, field);
}

function parseOptionalTimestamp(
  value: string | null | undefined,
  field: string,
) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return validateAndParseDate(value, field, { requireTimezone: true });
}

const listMilestonesRoute = createRoute({
  method: "get",
  operationId: "listMilestones",
  path: "/project/{projectId}",
  tags: ["Milestones"],
  summary: "List milestones",
  description: "Get a project's milestones, ordered by creation date.",
  middleware: [
    workspaceAccess.fromProject("projectId"),
    requireWorkspacePermission({ task: ["read"] }),
  ] as const,
  request: { params: projectIdParam },
  responses: {
    200: jsonResponse("List of milestones", milestoneListSchema),
    400: errorResponse(
      "Unknown project, or its workspace could not be determined",
    ),
    403: errorResponse("No access to the project's workspace"),
  },
});

const createMilestoneRoute = createRoute({
  method: "post",
  operationId: "createMilestone",
  path: "/project/{projectId}",
  tags: ["Milestones"],
  summary: "Create milestone",
  description: "Create a milestone in a project.",
  middleware: [
    workspaceAccess.fromProject("projectId"),
    requireWorkspacePermission({ task: ["create"] }),
  ] as const,
  request: {
    params: projectIdParam,
    body: {
      required: true,
      content: { "application/json": { schema: createMilestoneBody } },
    },
  },
  responses: {
    200: jsonResponse("The created milestone", milestoneSchema),
    400: errorResponse("Invalid body, or unknown project"),
    403: errorResponse(
      "No workspace access, or missing task:create permission",
    ),
  },
});

const getMilestoneRoute = createRoute({
  method: "get",
  operationId: "getMilestone",
  path: "/{id}",
  tags: ["Milestones"],
  summary: "Get milestone",
  description: "Get a single milestone by ID.",
  middleware: [
    workspaceAccess.fromMilestone("id"),
    requireWorkspacePermission({ task: ["read"] }),
  ] as const,
  request: { params: milestoneParam },
  responses: {
    200: jsonResponse("Milestone details and progress", milestoneSummarySchema),
    400: errorResponse(
      "Unknown milestone, or its workspace could not be determined",
    ),
    403: errorResponse("No access to the milestone's workspace"),
  },
});

const updateMilestoneRoute = createRoute({
  method: "put",
  operationId: "updateMilestone",
  path: "/{id}",
  tags: ["Milestones"],
  summary: "Update milestone",
  description:
    "Update a milestone. Omitted fields are left unchanged; nullable date fields accept null to clear them.",
  middleware: [
    workspaceAccess.fromMilestone("id"),
    requireWorkspacePermission({ task: ["update"] }),
  ] as const,
  request: {
    params: milestoneParam,
    body: {
      required: true,
      content: { "application/json": { schema: updateMilestoneBody } },
    },
  },
  responses: {
    200: jsonResponse("The updated milestone", milestoneSchema),
    400: errorResponse("Invalid body, or unknown milestone"),
    403: errorResponse(
      "No workspace access, or missing task:update permission",
    ),
    404: errorResponse("The milestone was deleted before the update completed"),
    409: errorResponse(
      "The milestone's project changed before the update completed",
    ),
  },
});

const deleteMilestoneRoute = createRoute({
  method: "delete",
  operationId: "deleteMilestone",
  path: "/{id}",
  tags: ["Milestones"],
  summary: "Delete milestone",
  description: "Delete a milestone. Tasks linked to it are kept and unlinked.",
  middleware: [
    workspaceAccess.fromMilestone("id"),
    requireWorkspacePermission({ task: ["delete"] }),
  ] as const,
  request: { params: milestoneParam },
  responses: {
    200: jsonResponse("The deleted milestone", milestoneSchema),
    400: errorResponse(
      "Unknown milestone, or its workspace could not be determined",
    ),
    403: errorResponse(
      "No workspace access, or missing task:delete permission",
    ),
    404: errorResponse("The milestone was deleted before the delete completed"),
  },
});

const milestone = apiRouter()
  .openapi(listMilestonesRoute, async (c) =>
    c.json(await getMilestones(c.req.valid("param").projectId), 200),
  )
  .openapi(createMilestoneRoute, async (c) => {
    const { projectId } = c.req.valid("param");
    const { name, description, status, startDate, targetDate, completedAt } =
      c.req.valid("json");

    const parsedStartDate = parseOptionalCalendarDate(startDate, "startDate");
    const parsedTargetDate = parseOptionalCalendarDate(
      targetDate,
      "targetDate",
    );
    const parsedCompletedAt = parseOptionalTimestamp(
      completedAt,
      "completedAt",
    );

    validateDateRange(parsedStartDate, parsedTargetDate);

    return c.json(
      await createMilestone({
        projectId,
        name,
        description,
        status,
        startDate: parsedStartDate,
        targetDate: parsedTargetDate,
        completedAt: parsedCompletedAt,
      }),
      200,
    );
  })
  .openapi(getMilestoneRoute, async (c) =>
    c.json(await getMilestone(c.req.valid("param").id), 200),
  )
  .openapi(updateMilestoneRoute, async (c) => {
    const { id } = c.req.valid("param");
    const { name, description, status, startDate, targetDate, completedAt } =
      c.req.valid("json");

    const parsedStartDate = parseOptionalCalendarDate(startDate, "startDate");
    const parsedTargetDate = parseOptionalCalendarDate(
      targetDate,
      "targetDate",
    );
    const parsedCompletedAt = parseOptionalTimestamp(
      completedAt,
      "completedAt",
    );

    validateDateRange(parsedStartDate, parsedTargetDate);

    return c.json(
      await updateMilestone(id, {
        ...(name !== undefined && { name }),
        ...(description !== undefined && { description }),
        ...(status !== undefined && { status }),
        ...(parsedStartDate !== undefined && { startDate: parsedStartDate }),
        ...(parsedTargetDate !== undefined && { targetDate: parsedTargetDate }),
        ...(parsedCompletedAt !== undefined && {
          completedAt: parsedCompletedAt,
        }),
      }),
      200,
    );
  })
  .openapi(deleteMilestoneRoute, async (c) =>
    c.json(await deleteMilestone(c.req.valid("param").id), 200),
  );

export default milestone;
