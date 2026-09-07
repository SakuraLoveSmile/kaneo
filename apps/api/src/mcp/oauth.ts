import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createId } from "@paralleldrive/cuid2";
import { eq } from "drizzle-orm";
import db from "../database";
import { sessionTable } from "../database/schema";
import {
  consumeState,
  deleteExpiredStates,
  deleteState,
  enforceStateCap,
  getState,
  putState,
} from "./oauth-store";

export type RegisteredClient = {
  clientId: string;
  redirectUris: string[];
  clientName?: string;
  applicationType?: "web" | "native";
  issuedAt: number;
};

export type AuthCode = {
  clientId: string;
  userId: string;
  codeChallenge: string;
  redirectUri: string;
  resource?: string;
};

export type AuthorizationRequest = {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  state?: string;
  resource?: string;
};

export type McpTokenRecord = {
  token: string;
  clientId: string;
  userId: string;
  resource: string;
  expiresAt: string;
  createdAt: string;
  revokedAt?: string | null;
};

// Clients are long-lived and reused across sessions/users (e.g. by ChatGPT).
// Set far-future TTL (10 years) and bound table growth with enforceStateCap.
const clientTtlMs = 10 * 365 * 24 * 60 * 60 * 1000;
const codeTtlMs = 5 * 60 * 1000;
const requestTtlMs = 10 * 60 * 1000;
// Bounds table growth; authorize is reachable without a session.
const maxAuthorizationRequests = 10_000;
const maxRegisteredClients = 10_000;

export function normalizeResourceUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export function getCanonicalMcpResource(baseUrl?: string): string {
  const base = (baseUrl || process.env.KANEO_API_URL || "http://localhost:1337")
    .replace(/\/api\/?$/, "")
    .replace(/\/+$/, "");
  return `${base}/api/mcp`;
}

export async function getClient(
  clientId: string,
): Promise<RegisteredClient | null> {
  return getState<RegisteredClient>("client", clientId);
}

export async function registerClient(params: {
  redirectUris: string[];
  clientName?: string;
  applicationType?: "web" | "native";
}): Promise<RegisteredClient> {
  await deleteExpiredStates();
  await enforceStateCap("client", maxRegisteredClients);
  const clientId = randomUUID();
  const client: RegisteredClient = {
    clientId,
    redirectUris: [...params.redirectUris],
    clientName: params.clientName,
    applicationType: params.applicationType,
    issuedAt: Math.floor(Date.now() / 1000),
  };
  await putState(
    "client",
    clientId,
    client,
    new Date(Date.now() + clientTtlMs),
  );
  return client;
}

export async function revokeClient(clientId: string): Promise<void> {
  await deleteState("client", clientId);
}

export async function createAuthCode(params: AuthCode): Promise<string> {
  const code = randomUUID();
  const canonical = getCanonicalMcpResource();
  const resource = params.resource || canonical;
  await putState(
    "code",
    code,
    { ...params, resource },
    new Date(Date.now() + codeTtlMs),
  );
  return code;
}

export async function createAuthorizationRequest(
  params: AuthorizationRequest,
): Promise<string> {
  await deleteExpiredStates();
  await enforceStateCap("request", maxAuthorizationRequests);
  const requestId = randomUUID();
  const canonical = getCanonicalMcpResource();
  const resource = params.resource || canonical;
  await putState(
    "request",
    requestId,
    { ...params, resource },
    new Date(Date.now() + requestTtlMs),
  );
  return requestId;
}

export async function getAuthorizationRequest(
  requestId: string,
): Promise<AuthorizationRequest | null> {
  return getState<AuthorizationRequest>("request", requestId);
}

export async function consumeAuthorizationRequest(
  requestId: string,
): Promise<AuthorizationRequest | null> {
  return consumeState<AuthorizationRequest>("request", requestId);
}

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

const PKCE_VERIFIER_REGEX = /^[A-Za-z0-9\-._~]{43,128}$/;

export function isValidCodeVerifier(verifier: string): boolean {
  return PKCE_VERIFIER_REGEX.test(verifier);
}

function verifyPkce(codeVerifier: string, codeChallenge: string): boolean {
  if (!isValidCodeVerifier(codeVerifier)) return false;
  const hash = createHash("sha256").update(codeVerifier).digest();
  const challengeBuf = Buffer.from(codeChallenge, "utf8");
  const computedBuf = Buffer.from(base64url(hash), "utf8");
  if (challengeBuf.length !== computedBuf.length) return false;
  return timingSafeEqual(challengeBuf, computedBuf);
}

export async function exchangeCode(
  code: string,
  clientId: string,
  codeVerifier: string,
  redirectUri: string,
  resource?: string,
): Promise<{ accessToken: string; expiresIn: number } | null> {
  const stored = await consumeState<AuthCode>("code", code);
  if (!stored) return null;

  if (stored.clientId !== clientId) return null;
  if (stored.redirectUri !== redirectUri) return null;
  const storedResource = stored.resource || getCanonicalMcpResource();
  if (
    resource &&
    normalizeResourceUrl(resource) !== normalizeResourceUrl(storedResource)
  ) {
    return null;
  }
  if (!verifyPkce(codeVerifier, stored.codeChallenge)) return null;

  const sessionToken = randomUUID();
  const expiresIn = 30 * 24 * 60 * 60;
  const expiresAt = new Date(Date.now() + expiresIn * 1000);
  const now = new Date();

  await db.insert(sessionTable).values({
    id: createId(),
    token: sessionToken,
    userId: stored.userId,
    expiresAt,
    createdAt: now,
    updatedAt: now,
  });

  const mcpToken: McpTokenRecord = {
    token: sessionToken,
    clientId: stored.clientId,
    userId: stored.userId,
    resource: storedResource,
    expiresAt: expiresAt.toISOString(),
    createdAt: now.toISOString(),
  };
  await putState("token", sessionToken, mcpToken, expiresAt);

  return { accessToken: sessionToken, expiresIn };
}

export async function getMcpToken(
  token: string,
): Promise<McpTokenRecord | null> {
  return getState<McpTokenRecord>("token", token);
}

export async function revokeMcpToken(token: string): Promise<void> {
  await deleteState("token", token);
  await db.delete(sessionTable).where(eq(sessionTable.token, token));
}
