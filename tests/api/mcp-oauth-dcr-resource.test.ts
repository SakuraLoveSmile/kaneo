import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const insertedSessions: Array<Record<string, unknown>> = [];
  const getSession = vi.fn(async ({ headers }: { headers: Headers }) => {
    const authHeader = headers.get("authorization");
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice(7);
      return {
        user: { id: "user-123", email: "user@example.com", name: "Kaneo User" },
        session: { token },
      };
    }
    const cookie = headers.get("cookie") ?? "";
    if (cookie.includes("auth_session=1")) {
      return {
        user: { id: "user-123", email: "user@example.com", name: "Kaneo User" },
        session: { token: "cookie-session-token" },
      };
    }
    return null;
  });
  const insert = vi.fn(() => ({
    values: vi.fn(async (row: Record<string, unknown>) => {
      insertedSessions.push(row);
      return row;
    }),
  }));
  const del = vi.fn(() => ({
    where: vi.fn(async () => []),
  }));
  return { getSession, insert, del, insertedSessions };
});

vi.mock("../../apps/api/src/auth", () => ({
  auth: { api: { getSession: mocks.getSession } },
}));

vi.mock("../../apps/api/src/database", () => ({
  default: { insert: mocks.insert, delete: mocks.del },
}));

vi.mock("../../apps/api/src/mcp/tools", () => ({
  registerMcpTools: vi.fn(),
}));

vi.mock("../../apps/api/src/mcp/oauth-store", () => {
  const rows = new Map<string, { payload: unknown; expiresAt: Date }>();
  const keyOf = (kind: string, key: string) => `${kind}:${key}`;
  return {
    putState: async (
      kind: string,
      key: string,
      payload: unknown,
      expiresAt: Date,
    ) => {
      rows.set(keyOf(kind, key), { payload, expiresAt });
    },
    getState: async (kind: string, key: string) => {
      const row = rows.get(keyOf(kind, key));
      if (!row) return null;
      if (row.expiresAt.getTime() < Date.now()) return null;
      return row.payload;
    },
    consumeState: async (kind: string, key: string) => {
      const row = rows.get(keyOf(kind, key));
      rows.delete(keyOf(kind, key));
      if (!row) return null;
      if (row.expiresAt.getTime() < Date.now()) return null;
      return row.payload;
    },
    deleteState: async (kind: string, key: string) => {
      rows.delete(keyOf(kind, key));
    },
    enforceStateCap: async () => {},
    deleteExpiredStates: async () => {
      const now = Date.now();
      for (const [key, row] of rows) {
        if (row.expiresAt.getTime() < now) rows.delete(key);
      }
    },
  };
});

import mcpRoutes from "../../apps/api/src/mcp";
import {
  createAuthCode,
  getCanonicalMcpResource,
  getClient,
  getMcpToken,
  revokeMcpToken,
} from "../../apps/api/src/mcp/oauth";

const clientUrl = process.env.KANEO_CLIENT_URL || "http://localhost:5173";
const clientOrigin = new URL(clientUrl).origin;

function challengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

describe("MCP OAuth DCR and Capability Normalization", () => {
  it("accepts ChatGPT DCR registration, returns 201 with strictly approved capabilities", async () => {
    const chatGptPayload = {
      client_name: "ChatGPT",
      redirect_uris: ["https://chatgpt.com/api/aip/p_123/oauth/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "web",
      unsupported_extension: "ignored_value",
      scope: "read write admin",
    };

    const response = await mcpRoutes.request("/mcp/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(chatGptPayload),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;

    expect(body.client_id).toBeTruthy();
    expect(body.client_id_issued_at).toBeTypeOf("number");
    expect(body.client_name).toBe("ChatGPT");
    expect(body.redirect_uris).toEqual([
      "https://chatgpt.com/api/aip/p_123/oauth/callback",
    ]);
    expect(body.token_endpoint_auth_method).toBe("none");
    expect(body.grant_types).toEqual(["authorization_code"]);
    expect(body.response_types).toEqual(["code"]);
    expect(body.application_type).toBe("web");
    expect(body).not.toHaveProperty("client_secret");
    expect(body).not.toHaveProperty("refresh_token");
    expect(body).not.toHaveProperty("scope");
    expect(body).not.toHaveProperty("unsupported_extension");
  });

  it("accepts reversed grant_types order and defaults when omitted", async () => {
    const reversed = await mcpRoutes.request("/mcp/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["https://client.example/callback"],
        grant_types: ["refresh_token", "authorization_code"],
      }),
    });
    expect(reversed.status).toBe(201);
    const revBody = (await reversed.json()) as Record<string, unknown>;
    expect(revBody.grant_types).toEqual(["authorization_code"]);

    const minimal = await mcpRoutes.request("/mcp/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["https://client.example/callback"],
      }),
    });
    expect(minimal.status).toBe(201);
    const minBody = (await minimal.json()) as Record<string, unknown>;
    expect(minBody.grant_types).toEqual(["authorization_code"]);
    expect(minBody.response_types).toEqual(["code"]);
    expect(minBody.token_endpoint_auth_method).toBe("none");
  });

  it("rejects unsupported, empty, or refresh-only grant_types with OAuth error", async () => {
    const onlyRefresh = await mcpRoutes.request("/mcp/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["https://client.example/callback"],
        grant_types: ["refresh_token"],
      }),
    });
    expect(onlyRefresh.status).toBe(400);
    expect((await onlyRefresh.json()).error).toBe("invalid_client_metadata");

    const emptyGrants = await mcpRoutes.request("/mcp/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["https://client.example/callback"],
        grant_types: [],
      }),
    });
    expect(emptyGrants.status).toBe(400);
    expect((await emptyGrants.json()).error).toBe("invalid_client_metadata");

    const unsupportedGrant = await mcpRoutes.request("/mcp/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["https://client.example/callback"],
        grant_types: ["authorization_code", "client_credentials"],
      }),
    });
    expect(unsupportedGrant.status).toBe(400);
    expect((await unsupportedGrant.json()).error).toBe(
      "invalid_client_metadata",
    );
  });

  it("rejects invalid response_types or non-none token_endpoint_auth_method", async () => {
    const badResponseTypes = await mcpRoutes.request("/mcp/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["https://client.example/callback"],
        response_types: ["token"],
      }),
    });
    expect(badResponseTypes.status).toBe(400);
    expect((await badResponseTypes.json()).error).toBe(
      "invalid_client_metadata",
    );

    const badAuthMethod = await mcpRoutes.request("/mcp/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["https://client.example/callback"],
        token_endpoint_auth_method: "client_secret_post",
      }),
    });
    expect(badAuthMethod.status).toBe(400);
    expect((await badAuthMethod.json()).error).toBe("invalid_client_metadata");
  });
});

describe("MCP OAuth Resource Binding and RFC 9207 Issuer Identification", () => {
  it("validates resource matching and defaults to canonical resource when omitted", async () => {
    const regRes = await mcpRoutes.request("/mcp/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["https://client.example/callback"],
      }),
    });
    const { client_id } = (await regRes.json()) as { client_id: string };
    const verifier = "sample-verifier-at-least-43-characters-long-12345";
    const challenge = challengeFor(verifier);

    const canonical = getCanonicalMcpResource();

    const validAuthUrl = new URL("http://api.local/mcp/authorize");
    validAuthUrl.searchParams.set("response_type", "code");
    validAuthUrl.searchParams.set("client_id", client_id);
    validAuthUrl.searchParams.set(
      "redirect_uri",
      "https://client.example/callback",
    );
    validAuthUrl.searchParams.set("code_challenge", challenge);
    validAuthUrl.searchParams.set("code_challenge_method", "S256");
    validAuthUrl.searchParams.set("resource", canonical);

    const validRes = await mcpRoutes.request(validAuthUrl.toString(), {
      redirect: "manual",
    });
    expect(validRes.status).toBe(302);

    const invalidAuthUrl = new URL(validAuthUrl.toString());
    invalidAuthUrl.searchParams.set(
      "resource",
      "https://unauthorized-resource.example/api",
    );
    const invalidRes = await mcpRoutes.request(invalidAuthUrl.toString(), {
      redirect: "manual",
    });
    expect(invalidRes.status).toBe(400);
    expect((await invalidRes.json()).error).toBe("invalid_target");

    const noResourceAuthUrl = new URL(validAuthUrl.toString());
    noResourceAuthUrl.searchParams.delete("resource");
    const noResourceRes = await mcpRoutes.request(
      noResourceAuthUrl.toString(),
      {
        redirect: "manual",
      },
    );
    expect(noResourceRes.status).toBe(302);
  });

  it("returns RFC 9207 iss in both approved and denied redirects", async () => {
    const regRes = await mcpRoutes.request("/mcp/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["https://client.example/iss-check"],
      }),
    });
    const { client_id } = (await regRes.json()) as { client_id: string };
    const verifier = "verifier-for-iss-check-at-least-43-characters-long";
    const challenge = challengeFor(verifier);

    const authUrl = new URL("http://api.local/mcp/authorize");
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", client_id);
    authUrl.searchParams.set(
      "redirect_uri",
      "https://client.example/iss-check",
    );
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("state", "xyz-state");

    const authRes = await mcpRoutes.request(authUrl.toString(), {
      redirect: "manual",
    });
    const consentUrl = new URL(authRes.headers.get("location") ?? "");
    const requestId = consentUrl.searchParams.get("request_id") ?? "";

    const approvalRes = await mcpRoutes.request(
      `/mcp/authorize/request/${requestId}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "auth_session=1",
          origin: clientOrigin,
        },
        body: JSON.stringify({ approved: true }),
      },
    );
    expect(approvalRes.status).toBe(200);
    const approvalRedirect = new URL((await approvalRes.json()).redirect);
    expect(approvalRedirect.searchParams.get("code")).toBeTruthy();
    expect(approvalRedirect.searchParams.get("iss")).toBe(
      "http://localhost:1337/api",
    );

    const authResDeny = await mcpRoutes.request(authUrl.toString(), {
      redirect: "manual",
    });
    const consentUrlDeny = new URL(authResDeny.headers.get("location") ?? "");
    const requestIdDeny = consentUrlDeny.searchParams.get("request_id") ?? "";

    const denyRes = await mcpRoutes.request(
      `/mcp/authorize/request/${requestIdDeny}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "auth_session=1",
          origin: clientOrigin,
        },
        body: JSON.stringify({ approved: false }),
      },
    );
    expect(denyRes.status).toBe(200);
    const denyRedirect = new URL((await denyRes.json()).redirect);
    expect(denyRedirect.searchParams.get("error")).toBe("access_denied");
    expect(denyRedirect.searchParams.get("iss")).toBe(
      "http://localhost:1337/api",
    );
  });

  it("declares authorization_response_iss_parameter_supported and authorization_code only in AS metadata", async () => {
    const metaRes = await mcpRoutes.request(
      "/.well-known/oauth-authorization-server/api",
    );
    expect(metaRes.status).toBe(200);
    const meta = (await metaRes.json()) as Record<string, unknown>;
    expect(meta.authorization_response_iss_parameter_supported).toBe(true);
    expect(meta.grant_types_supported).toEqual(["authorization_code"]);
  });
});

describe("Token Endpoint, Cache Control, and PKCE", () => {
  it("sets Cache-Control: no-store, Pragma: no-cache, and rejects refresh grant", async () => {
    const refreshRes = await mcpRoutes.request("/mcp/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: "fake-refresh-token",
      }),
    });
    expect(refreshRes.status).toBe(400);
    expect(refreshRes.headers.get("cache-control")).toBe("no-store");
    expect(refreshRes.headers.get("pragma")).toBe("no-cache");
    expect((await refreshRes.json()).error).toBe("unsupported_grant_type");
  });

  it("handles malformed json/urlencoded payloads with 400 invalid_request", async () => {
    const malformedJson = await mcpRoutes.request("/mcp/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ invalid json ...",
    });
    expect(malformedJson.status).toBe(400);
    expect((await malformedJson.json()).error).toBe("invalid_request");
  });

  it("rejects invalid PKCE format and code_verifier length < 43", async () => {
    const shortVerifier = await mcpRoutes.request("/mcp/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: "test-code",
        client_id: "test-client",
        redirect_uri: "https://client.example/callback",
        code_verifier: "short-verifier",
      }),
    });
    expect(shortVerifier.status).toBe(400);
    expect((await shortVerifier.json()).error).toBe("invalid_grant");
  });

  it("exchanges code for resource-bound access token without refresh_token", async () => {
    const verifier = "valid-length-verifier-for-successful-exchange-123456";
    const challenge = challengeFor(verifier);
    const redirectUri = "https://client.example/token-test";
    const canonical = getCanonicalMcpResource();

    const code = await createAuthCode({
      clientId: "client-token-test",
      userId: "user-123",
      codeChallenge: challenge,
      redirectUri,
      resource: canonical,
    });

    const tokenRes = await mcpRoutes.request("/mcp/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: "client-token-test",
        redirect_uri: redirectUri,
        code_verifier: verifier,
        resource: canonical,
      }),
    });

    expect(tokenRes.status).toBe(200);
    expect(tokenRes.headers.get("cache-control")).toBe("no-store");
    expect(tokenRes.headers.get("pragma")).toBe("no-cache");

    const body = (await tokenRes.json()) as Record<string, unknown>;
    expect(body.access_token).toBeTypeOf("string");
    expect(body.token_type).toBe("bearer");
    expect(body.expires_in).toBeTypeOf("number");
    expect(body).not.toHaveProperty("refresh_token");

    const mcpToken = await getMcpToken(String(body.access_token));
    expect(mcpToken).toBeTruthy();
    expect(mcpToken?.resource).toBe(canonical);
    expect(mcpToken?.userId).toBe("user-123");
  });
});

describe("Audience Check and Registered Client Lifecycle", () => {
  it("rejects normal session token without MCP token record on /mcp", async () => {
    const unauthenticated = await mcpRoutes.request("/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer plain-session-without-mcp-record",
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("www-authenticate")).toContain(
      "resource_metadata=",
    );
  });

  it("revoked token is rejected on /mcp", async () => {
    const verifier = "valid-length-verifier-for-revocation-test-123456";
    const challenge = challengeFor(verifier);
    const redirectUri = "https://client.example/revocation";
    const canonical = getCanonicalMcpResource();

    const code = await createAuthCode({
      clientId: "client-rev-test",
      userId: "user-123",
      codeChallenge: challenge,
      redirectUri,
      resource: canonical,
    });

    const tokenRes = await mcpRoutes.request("/mcp/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: "client-rev-test",
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
    });
    const { access_token } = (await tokenRes.json()) as {
      access_token: string;
    };

    await revokeMcpToken(access_token);

    const mcpReq = await mcpRoutes.request("/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${access_token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(mcpReq.status).toBe(401);
  });

  it("registered client remains valid past 35 days (ChatGPT client reuse)", async () => {
    const regRes = await mcpRoutes.request("/mcp/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "LongLivedChatGPT",
        redirect_uris: ["https://chatgpt.com/callback"],
      }),
    });
    const { client_id } = (await regRes.json()) as { client_id: string };

    vi.useFakeTimers();
    try {
      const now = Date.now();
      vi.setSystemTime(now + 35 * 24 * 60 * 60 * 1000);

      const client = await getClient(client_id);
      expect(client).toBeTruthy();
      expect(client?.clientName).toBe("LongLivedChatGPT");
    } finally {
      vi.useRealTimers();
    }
  });
});
