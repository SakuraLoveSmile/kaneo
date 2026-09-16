import {
  apiRouter,
  createRoute,
  errorResponse,
  jsonResponse,
} from "../openapi";
import checkInstanceStorage from "./controllers/check-instance-storage";
import getInstanceStorage from "./controllers/get-instance-storage";
import updateInstanceStorage from "./controllers/update-instance-storage";
import { requireInstanceAdminSession } from "./middleware";
import {
  instanceStorageCheckResponseSchema,
  instanceStorageStatusResponseSchema,
} from "./response";
import {
  checkInstanceStorageSchema,
  updateInstanceStorageSchema,
} from "./schema";

const getInstanceStorageRoute = createRoute({
  method: "get",
  operationId: "getInstanceStorage",
  path: "/storage",
  tags: ["Instance"],
  summary: "Get instance storage configuration",
  description:
    "Returns effective storage backend, configuration source, settings version, and backend availability. Restricted to instance administrator sessions.",
  middleware: [requireInstanceAdminSession],
  responses: {
    200: jsonResponse(
      "Instance storage configuration",
      instanceStorageStatusResponseSchema,
    ),
    401: errorResponse("Unauthorized"),
    403: errorResponse("Forbidden"),
  },
});

const checkInstanceStorageRoute = createRoute({
  method: "post",
  operationId: "checkInstanceStorage",
  path: "/storage/check",
  tags: ["Instance"],
  summary: "Check instance storage backend availability",
  description:
    "Runs a write/read/delete probe against the specified storage backend. Restricted to instance administrator sessions.",
  middleware: [requireInstanceAdminSession],
  request: {
    body: {
      required: true,
      content: {
        "application/json": { schema: checkInstanceStorageSchema },
      },
    },
  },
  responses: {
    200: jsonResponse(
      "Storage check result",
      instanceStorageCheckResponseSchema,
    ),
    401: errorResponse("Unauthorized"),
    403: errorResponse("Forbidden"),
  },
});

const updateInstanceStorageRoute = createRoute({
  method: "put",
  operationId: "updateInstanceStorage",
  path: "/storage",
  tags: ["Instance"],
  summary: "Update instance storage configuration",
  description:
    "Persists the storage backend choice or restores deployment default. Probes target backend before updating. Restricted to instance administrator sessions.",
  middleware: [requireInstanceAdminSession],
  request: {
    body: {
      required: true,
      content: {
        "application/json": { schema: updateInstanceStorageSchema },
      },
    },
  },
  responses: {
    200: jsonResponse(
      "Updated instance storage configuration",
      instanceStorageStatusResponseSchema,
    ),
    400: errorResponse("Probe failed or invalid parameters"),
    401: errorResponse("Unauthorized"),
    403: errorResponse("Forbidden"),
    409: errorResponse("Concurrent modification conflict"),
  },
});

const instance = apiRouter()
  .openapi(getInstanceStorageRoute, async (c) => {
    const status = await getInstanceStorage();
    return c.json(status, 200);
  })
  .openapi(checkInstanceStorageRoute, async (c) => {
    const { backend } = c.req.valid("json");
    const result = await checkInstanceStorage(backend);
    return c.json(result, 200);
  })
  .openapi(updateInstanceStorageRoute, async (c) => {
    const input = c.req.valid("json");
    const userId = c.get("userId");
    const status = await updateInstanceStorage({ input, userId });
    return c.json(status, 200);
  });

export default instance;
