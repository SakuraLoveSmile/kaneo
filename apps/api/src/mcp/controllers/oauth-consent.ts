import { HTTPException } from "hono/http-exception";
import { auth } from "../../auth";
import { publishEvent } from "../../events";
import type { z } from "../../openapi";
import {
  consumeAuthorizationRequest,
  createAuthCode,
  createAuthorizationRequest,
  getAuthorizationRequest,
  getCanonicalMcpResource,
  getClient,
  normalizeResourceUrl,
  registerClient,
} from "../oauth";
import type {
  authorizationDecisionSchema,
  authorizationQuerySchema,
  clientRegistrationSchema,
} from "../schemas";

const clientUrl = process.env.KANEO_CLIENT_URL || "http://localhost:5173";
const publicApiUrl = (process.env.KANEO_API_URL || "http://localhost:1337")
  .replace(/\/api\/?$/, "")
  .replace(/\/+$/, "");
const issuerUrl = `${publicApiUrl}/api`;

type ClientRegistrationInput = z.infer<typeof clientRegistrationSchema>;
type AuthorizationInput = z.infer<typeof authorizationQuerySchema>;
type AuthorizationDecisionInput = z.infer<typeof authorizationDecisionSchema>;

type OAuthErrorStatus = 400 | 401 | 403 | 404;

function throwOAuthError(
  status: OAuthErrorStatus,
  error: string,
  errorDescription?: string,
): never {
  const body: { error: string; error_description?: string } = { error };
  if (errorDescription) {
    body.error_description = errorDescription;
  }
  throw new HTTPException(status, {
    res: Response.json(body, { status }),
  });
}

function buildAuthorizationRedirect(
  request: { redirectUri: string; state?: string },
  params: Record<string, string>,
): string {
  const url = new URL(request.redirectUri);
  url.searchParams.set("iss", issuerUrl);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  if (request.state !== undefined) {
    url.searchParams.set("state", request.state);
  }
  return url.toString();
}

function isTrustedConsentOrigin(origin: string | undefined): boolean {
  if (!origin) return false;

  try {
    return new URL(origin).origin === new URL(clientUrl).origin;
  } catch {
    return false;
  }
}

export async function registerMcpClient(input: ClientRegistrationInput) {
  if (input.grant_types !== undefined) {
    if (!Array.isArray(input.grant_types) || input.grant_types.length === 0) {
      throwOAuthError(
        400,
        "invalid_client_metadata",
        "grant_types must not be empty",
      );
    }
    if (!input.grant_types.includes("authorization_code")) {
      throwOAuthError(
        400,
        "invalid_client_metadata",
        "grant_types must include authorization_code",
      );
    }
    const hasUnsupportedGrant = input.grant_types.some(
      (gt) => gt !== "authorization_code" && gt !== "refresh_token",
    );
    if (hasUnsupportedGrant) {
      throwOAuthError(
        400,
        "invalid_client_metadata",
        "Unsupported grant_type requested",
      );
    }
  }

  if (input.response_types !== undefined) {
    if (
      !Array.isArray(input.response_types) ||
      input.response_types.length === 0
    ) {
      throwOAuthError(
        400,
        "invalid_client_metadata",
        "response_types must not be empty",
      );
    }
    if (
      !input.response_types.includes("code") ||
      input.response_types.some((rt) => rt !== "code")
    ) {
      throwOAuthError(
        400,
        "invalid_client_metadata",
        "Only response_type 'code' is supported",
      );
    }
  }

  if (
    input.token_endpoint_auth_method !== undefined &&
    input.token_endpoint_auth_method !== "none"
  ) {
    throwOAuthError(
      400,
      "invalid_client_metadata",
      "Only token_endpoint_auth_method 'none' is supported",
    );
  }

  const client = await registerClient({
    redirectUris: input.redirect_uris,
    clientName: input.client_name,
    applicationType: input.application_type,
  });

  return {
    client_id: client.clientId,
    client_id_issued_at: client.issuedAt,
    redirect_uris: client.redirectUris,
    ...(client.clientName ? { client_name: client.clientName } : {}),
    ...(client.applicationType
      ? { application_type: client.applicationType }
      : {}),
    token_endpoint_auth_method: "none" as const,
    grant_types: ["authorization_code"] as "authorization_code"[],
    response_types: ["code"] as "code"[],
  };
}

export async function beginMcpAuthorization(
  input: AuthorizationInput,
): Promise<string> {
  const client = await getClient(input.client_id);
  if (!client) throwOAuthError(400, "invalid_client");
  if (!client.redirectUris.includes(input.redirect_uri)) {
    throwOAuthError(400, "invalid_redirect_uri");
  }

  const canonicalResource = getCanonicalMcpResource(publicApiUrl);
  if (
    input.resource &&
    normalizeResourceUrl(input.resource) !==
      normalizeResourceUrl(canonicalResource)
  ) {
    throwOAuthError(400, "invalid_target", "The requested resource is invalid");
  }

  const requestId = await createAuthorizationRequest({
    clientId: input.client_id,
    codeChallenge: input.code_challenge,
    redirectUri: input.redirect_uri,
    state: input.state,
    resource: canonicalResource,
  });
  const consentUrl = new URL("/mcp/authorize", clientUrl);
  consentUrl.searchParams.set("request_id", requestId);
  return consentUrl.toString();
}

export async function getMcpAuthorizationRequest(requestId: string) {
  const request = await getAuthorizationRequest(requestId);
  if (!request) throwOAuthError(404, "invalid_or_expired_request");

  const client = await getClient(request.clientId);
  if (!client) throwOAuthError(400, "invalid_client");

  return {
    client_name: client.clientName ?? "MCP client",
    redirect_uri: request.redirectUri,
  };
}

export async function decideMcpAuthorizationRequest(params: {
  requestId: string;
  decision: AuthorizationDecisionInput;
  headers: Headers;
  origin?: string;
}): Promise<string> {
  if (!isTrustedConsentOrigin(params.origin)) {
    throwOAuthError(403, "invalid_origin");
  }

  const session = await auth.api.getSession({ headers: params.headers });
  if (!session?.user?.id) throwOAuthError(401, "unauthorized");

  const request = await consumeAuthorizationRequest(params.requestId);
  if (!request) throwOAuthError(404, "invalid_or_expired_request");

  const client = await getClient(request.clientId);
  if (!client?.redirectUris.includes(request.redirectUri)) {
    throwOAuthError(400, "invalid_client");
  }

  if (!params.decision.approved) {
    return buildAuthorizationRedirect(request, { error: "access_denied" });
  }

  const code = await createAuthCode({
    clientId: request.clientId,
    userId: session.user.id,
    codeChallenge: request.codeChallenge,
    redirectUri: request.redirectUri,
    resource: request.resource,
  });
  await publishEvent("mcp.authorization_code_issued", {
    clientId: request.clientId,
    userId: session.user.id,
    redirectUri: request.redirectUri,
  });
  return buildAuthorizationRedirect(request, { code });
}
