import { randomUUID } from "node:crypto";
import { OpenAPIHono } from "@hono/zod-openapi";
import { McpServer as LegacyMcpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  isJsonContentType,
  isLegacyRequest,
} from "@modelcontextprotocol/server";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { auth } from "../auth";
import { createRoute, jsonResponse } from "../openapi";
import {
  beginMcpAuthorization,
  decideMcpAuthorizationRequest,
  getMcpAuthorizationRequest,
  registerMcpClient,
} from "./controllers/oauth-consent";
import { createModernMcpHandler } from "./modern";
import {
  exchangeCode,
  getCanonicalMcpResource,
  getMcpToken,
  isValidCodeVerifier,
  normalizeResourceUrl,
} from "./oauth";
import {
  authorizationDecisionResponseSchema,
  authorizationDecisionSchema,
  authorizationQuerySchema,
  authorizationRequestParamSchema,
  authorizationRequestResponseSchema,
  clientRegistrationResponseSchema,
  clientRegistrationSchema,
  oauthErrorSchema,
} from "./schemas";
import { registerMcpTools, toMcpToolRegistrar } from "./tools";

export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/api\/?$/, "").replace(/\/+$/, "");
}

const publicApiUrl = normalizeBaseUrl(
  process.env.KANEO_API_URL || "http://localhost:1337",
);
const internalApiUrl = normalizeBaseUrl(
  process.env.KANEO_INTERNAL_API_URL || "http://127.0.0.1:1337",
);

export function getProtectedResourceMetadata(baseUrl: string) {
  const normalized = normalizeBaseUrl(baseUrl);
  return {
    resource: `${normalized}/api/mcp`,
    authorization_servers: [`${normalized}/api`],
  };
}

export function getAuthorizationServerMetadata(baseUrl: string) {
  const normalized = normalizeBaseUrl(baseUrl);
  return {
    issuer: `${normalized}/api`,
    authorization_endpoint: `${normalized}/api/mcp/authorize`,
    token_endpoint: `${normalized}/api/mcp/token`,
    registration_endpoint: `${normalized}/api/mcp/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    authorization_response_iss_parameter_supported: true,
  };
}

type McpSession = {
  transport: WebStandardStreamableHTTPServerTransport;
  userId: string;
};

const sessions = new Map<string, McpSession>();

function createMcpServerForUser(token: string): LegacyMcpServer {
  const server = new LegacyMcpServer({
    name: "kaneo-mcp",
    version: "1.0.0",
  });
  registerMcpTools(toMcpToolRegistrar(server), internalApiUrl, token);
  return server;
}

async function validateBearerToken(
  req: Request,
): Promise<{ userId: string; token: string } | null> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(\S+)$/i);
  if (!match?.[1]) return null;
  const token = match[1];

  const mcpToken = await getMcpToken(token);
  if (!mcpToken || mcpToken.revokedAt) return null;

  const canonicalResource = getCanonicalMcpResource(publicApiUrl);
  if (
    normalizeResourceUrl(mcpToken.resource) !==
    normalizeResourceUrl(canonicalResource)
  ) {
    return null;
  }

  const headers = new Headers();
  headers.set("authorization", `Bearer ${token}`);
  const session = await auth.api.getSession({ headers });

  if (!session?.user?.id || session.user.id !== mcpToken.userId) return null;
  return { userId: session.user.id, token };
}

const mcp = new OpenAPIHono({
  defaultHook: (result, c) => {
    if (!result.success) {
      const issue = result.error.issues[0];
      const path = c.req.path;
      if (path.endsWith("/register")) {
        const isRedirect = issue?.path.includes("redirect_uris");
        return c.json(
          {
            error: isRedirect
              ? "invalid_redirect_uri"
              : "invalid_client_metadata",
            error_description: issue?.message || "Invalid client metadata",
          },
          400,
        );
      }
      return c.json(
        {
          error: "invalid_request",
          error_description: issue?.message || "Invalid request",
        },
        400,
      );
    }
  },
});

const jsonError = (description: string) =>
  jsonResponse(description, oauthErrorSchema);

// OAuth clients parse validation failures, so these routes answer with the
// RFC 6749 / RFC 7591 JSON error shape instead of the router's text default.
type ValidationResult = { success: boolean; error?: { issues: unknown[] } };

const oauthValidationHook =
  (error: "invalid_request" | "invalid_client_metadata") =>
  (result: ValidationResult): undefined => {
    if (result.success) return;
    const issue = result.error?.issues[0] as
      | { path?: PropertyKey[]; message?: string }
      | undefined;
    const field = issue?.path?.map(String).join(".");
    throw new HTTPException(400, {
      res: Response.json(
        {
          error: field?.startsWith("redirect_uri")
            ? "invalid_redirect_uri"
            : error,
          error_description: issue
            ? `${field || "request"}: ${issue.message}`
            : "Invalid request",
        },
        { status: 400 },
      ),
    });
  };

const registerRoute = createRoute({
  method: "post",
  operationId: "registerMcpOAuthClient",
  path: "/mcp/register",
  tags: ["MCP"],
  summary: "Register MCP OAuth client",
  description:
    "Dynamically register a public OAuth client for the MCP endpoint. Public clients hold no secret, so authorization is protected by PKCE and an explicit consent step.",
  security: [],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: clientRegistrationSchema } },
    },
  },
  responses: {
    201: jsonResponse(
      "Registered OAuth client",
      clientRegistrationResponseSchema,
    ),
    400: jsonError("Invalid client metadata"),
  },
});

const authorizeRoute = createRoute({
  method: "get",
  operationId: "authorizeMcpOAuthClient",
  path: "/mcp/authorize",
  tags: ["MCP"],
  summary: "Start MCP authorization",
  description:
    "Begin an MCP OAuth authorization. Redirects the browser to the Kaneo consent page, which then approves or denies the request.",
  security: [],
  request: { query: authorizationQuerySchema },
  responses: {
    302: { description: "Redirect to the Kaneo consent page" },
    400: jsonError("Invalid authorization request"),
  },
});

const getAuthorizationRequestRoute = createRoute({
  method: "get",
  operationId: "getMcpAuthorizationRequest",
  path: "/mcp/authorize/request/{requestId}",
  tags: ["MCP"],
  summary: "Get consent request",
  description:
    "Get the client name and redirect URI for a pending consent request, so the consent page can show who is asking.",
  security: [],
  request: { params: authorizationRequestParamSchema },
  responses: {
    200: jsonResponse(
      "Authorization request details",
      authorizationRequestResponseSchema,
    ),
    400: jsonError("Invalid OAuth client"),
    404: jsonError("Unknown or expired authorization request"),
  },
});

const decideAuthorizationRequestRoute = createRoute({
  method: "post",
  operationId: "decideMcpAuthorizationRequest",
  path: "/mcp/authorize/request/{requestId}",
  tags: ["MCP"],
  summary: "Decide consent request",
  description:
    "Approve or deny a pending consent request and get the URL to send the browser back to.",
  request: {
    params: authorizationRequestParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: authorizationDecisionSchema } },
    },
  },
  responses: {
    200: jsonResponse(
      "OAuth client redirect",
      authorizationDecisionResponseSchema,
    ),
    400: jsonError("Invalid request or OAuth client"),
    401: jsonError("Authentication required"),
    403: jsonError("Untrusted request origin"),
    404: jsonError("Unknown or expired authorization request"),
  },
});

mcp
  .openapi(
    registerRoute,
    async (c) => c.json(await registerMcpClient(c.req.valid("json")), 201),
    oauthValidationHook("invalid_client_metadata"),
  )
  .openapi(
    authorizeRoute,
    async (c) => c.redirect(await beginMcpAuthorization(c.req.valid("query"))),
    oauthValidationHook("invalid_request"),
  )
  .openapi(
    getAuthorizationRequestRoute,
    async (c) =>
      c.json(
        await getMcpAuthorizationRequest(c.req.valid("param").requestId),
        200,
      ),
    oauthValidationHook("invalid_request"),
  )
  .openapi(
    decideAuthorizationRequestRoute,
    async (c) => {
      const redirect = await decideMcpAuthorizationRequest({
        requestId: c.req.valid("param").requestId,
        decision: c.req.valid("json"),
        headers: c.req.raw.headers,
        origin: c.req.header("origin"),
      });
      return c.json({ redirect }, 200);
    },
    oauthValidationHook("invalid_request"),
  );

mcp.all("/mcp", async (c) => {
  const authResult = await validateBearerToken(c.req.raw);
  if (!authResult) {
    const prmUrl = `${publicApiUrl}/api/.well-known/oauth-protected-resource/api/mcp`;
    c.header("WWW-Authenticate", `Bearer resource_metadata="${prmUrl}"`);
    return c.json(
      {
        error: "invalid_token",
        error_description: "Missing or invalid token",
      },
      401,
    );
  }

  const sessionId = c.req.header("mcp-session-id");

  if (sessionId) {
    const existing = sessions.get(sessionId);
    // A mismatched owner is reported as missing rather than forbidden so the
    // response cannot confirm that someone else's session id is valid.
    if (existing && existing.userId === authResult.userId) {
      return existing.transport.handleRequest(c.req.raw);
    }
    return c.json({ error: "Session not found" }, 404);
  }

  if (c.req.method !== "POST") {
    return c.json({ error: "Method not allowed" }, 405);
  }

  if (!isJsonContentType(c.req.header("content-type"))) {
    return c.json({ error: "Unsupported Media Type" }, 415);
  }

  if (!(await isLegacyRequest(c.req.raw.clone()))) {
    const modern = createModernMcpHandler(authResult.token, internalApiUrl);
    return modern.fetch(c.req.raw);
  }

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  transport.onclose = () => {
    if (transport.sessionId) {
      sessions.delete(transport.sessionId);
    }
  };

  const server = createMcpServerForUser(authResult.token);
  await server.connect(transport);
  const response = await transport.handleRequest(c.req.raw);

  if (transport.sessionId) {
    sessions.set(transport.sessionId, {
      transport,
      userId: authResult.userId,
    });
  }

  return response;
});

mcp.post("/mcp/token", async (c) => {
  c.header("Cache-Control", "no-store");
  c.header("Pragma", "no-cache");

  const contentType = c.req.header("content-type") || "";
  let params: Record<string, string>;

  try {
    if (contentType.includes("application/x-www-form-urlencoded")) {
      const body = await c.req.text();
      params = Object.fromEntries(new URLSearchParams(body));
    } else {
      params = await c.req.json();
    }
  } catch {
    return c.json(
      {
        error: "invalid_request",
        error_description: "Malformed request payload",
      },
      400,
    );
  }

  if (!params || typeof params !== "object") {
    return c.json(
      {
        error: "invalid_request",
        error_description: "Invalid request payload",
      },
      400,
    );
  }

  const { grant_type, code, client_id, code_verifier, redirect_uri, resource } =
    params;

  if (grant_type !== "authorization_code") {
    return c.json(
      {
        error: "unsupported_grant_type",
        error_description: "Only authorization_code grant is supported",
      },
      400,
    );
  }
  if (!code || !client_id || !code_verifier || !redirect_uri) {
    return c.json(
      {
        error: "invalid_request",
        error_description: "Missing required parameter",
      },
      400,
    );
  }
  if (!isValidCodeVerifier(code_verifier)) {
    return c.json(
      {
        error: "invalid_grant",
        error_description: "Invalid code_verifier format",
      },
      400,
    );
  }

  const result = await exchangeCode(
    code,
    client_id,
    code_verifier,
    redirect_uri,
    resource,
  );
  if (!result) {
    return c.json(
      {
        error: "invalid_grant",
        error_description: "Invalid or expired authorization code",
      },
      400,
    );
  }

  return c.json({
    access_token: result.accessToken,
    token_type: "bearer",
    expires_in: result.expiresIn,
  });
});

mcp.get("/.well-known/oauth-protected-resource/api/mcp", (c) =>
  c.json(getProtectedResourceMetadata(publicApiUrl)),
);

mcp.get("/.well-known/oauth-authorization-server/api", (c) =>
  c.json(getAuthorizationServerMetadata(publicApiUrl)),
);

export default mcp;

export function mcpWellKnownRoutes(baseUrl: string) {
  const wellKnown = new Hono();

  wellKnown.get("/.well-known/oauth-protected-resource/api/mcp", (c) =>
    c.json(getProtectedResourceMetadata(baseUrl)),
  );

  wellKnown.get("/.well-known/oauth-authorization-server/api", (c) =>
    c.json(getAuthorizationServerMetadata(baseUrl)),
  );

  return wellKnown;
}
