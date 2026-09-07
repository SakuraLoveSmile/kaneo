import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { resetTestDatabase } from "./helpers/database";
import { createWorkspaceMember } from "./helpers/fixtures";

const clientUrl = process.env.KANEO_CLIENT_URL || "http://localhost:5173";
const clientOrigin = new URL(clientUrl).origin;
const protocolVersion = "2026-07-28";

function challengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function modernRequest(
  method: string,
  id: number,
  params: Record<string, unknown>,
  token: string,
): Request {
  const name = method === "tools/call" ? String(params.name) : undefined;
  return new Request("http://localhost:1337/api/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "mcp-method": method,
      "mcp-protocol-version": protocolVersion,
      ...(name ? { "mcp-name": name } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": protocolVersion,
          "io.modelcontextprotocol/clientInfo": {
            name: "kaneo-e2e-chatgpt-test",
            version: "1.0.0",
          },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
}

async function rpcBody(response: Response) {
  const text = await response.text();
  const data = text
    .split("\n")
    .find((line) => line.startsWith("data: "))
    ?.slice(6);
  return JSON.parse(data ?? text);
}

describe("API integration: MCP OAuth E2E and Tool Execution", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("completes full ChatGPT OAuth flow -> MCP connection -> runs whoami, list_workspaces, create_project against real Postgres", async () => {
    const { app } = createApp();

    // Route internal API fetch calls directly to app.fetch so real routing,
    // authentication, authorization, and Postgres interactions occur.
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = new Request(input, init);
        return app.fetch(req);
      },
    );

    // 1. DCR: Dynamic Client Registration with ChatGPT style payload
    const dcrResponse = await app.request("/api/mcp/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "ChatGPT MCP Client",
        redirect_uris: ["https://chatgpt.com/api/aip/p_abc/oauth/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        application_type: "web",
      }),
    });

    expect(dcrResponse.status).toBe(201);
    const clientData = (await dcrResponse.json()) as { client_id: string };
    expect(clientData.client_id).toBeTruthy();

    // 2. Seed a real user, workspace, and an active login session in Postgres
    const member = await createWorkspaceMember({
      userName: "OAuth Agent",
      workspaceName: "OAuth Workspace",
      role: "admin",
    });

    const loginSessionToken = randomUUID();
    await db.insert(schema.sessionTable).values({
      id: `login-session-${randomUUID()}`,
      token: loginSessionToken,
      userId: member.user.id,
      expiresAt: new Date(Date.now() + 3600_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // 3. Initiate authorization with S256 PKCE and canonical resource
    const verifier = "valid-length-verifier-for-e2e-chatgpt-flow-123456789";
    const challenge = challengeFor(verifier);
    const redirectUri = "https://chatgpt.com/api/aip/p_abc/oauth/callback";
    const canonicalResource = "http://localhost:1337/api/mcp";

    const authUrl = new URL("http://localhost:1337/api/mcp/authorize");
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", clientData.client_id);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("resource", canonicalResource);
    authUrl.searchParams.set("state", "chatgpt-state-token");

    const authResponse = await app.request(authUrl.toString(), {
      redirect: "manual",
    });
    expect(authResponse.status).toBe(302);
    const consentUrl = new URL(authResponse.headers.get("location") ?? "");
    const requestId = consentUrl.searchParams.get("request_id") ?? "";
    expect(requestId).toBeTruthy();

    // 4. Consent page decision: approve with active login session
    const decisionResponse = await app.request(
      `/api/mcp/authorize/request/${requestId}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${loginSessionToken}`,
          origin: clientOrigin,
        },
        body: JSON.stringify({ approved: true }),
      },
    );

    expect(decisionResponse.status).toBe(200);
    const decisionBody = (await decisionResponse.json()) as {
      redirect: string;
    };
    const redirectCallback = new URL(decisionBody.redirect);
    const code = redirectCallback.searchParams.get("code") ?? "";
    expect(code).toBeTruthy();
    expect(redirectCallback.searchParams.get("state")).toBe(
      "chatgpt-state-token",
    );
    expect(redirectCallback.searchParams.get("iss")).toBe(
      "http://localhost:1337/api",
    );

    // 5. Code exchange at /api/mcp/token
    const tokenResponse = await app.request("/api/mcp/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientData.client_id,
        redirect_uri: redirectUri,
        code_verifier: verifier,
        resource: canonicalResource,
      }),
    });

    expect(tokenResponse.status).toBe(200);
    expect(tokenResponse.headers.get("cache-control")).toBe("no-store");
    expect(tokenResponse.headers.get("pragma")).toBe("no-cache");

    const tokenData = (await tokenResponse.json()) as { access_token: string };
    const mcpAccessToken = tokenData.access_token;
    expect(mcpAccessToken).toBeTruthy();

    // Verify token was stored in Postgres mcp_oauth_state table
    const [storedTokenState] = await db
      .select()
      .from(schema.mcpOauthStateTable)
      .where(eq(schema.mcpOauthStateTable.key, mcpAccessToken));
    expect(storedTokenState).toBeTruthy();
    expect((storedTokenState.payload as Record<string, unknown>).userId).toBe(
      member.user.id,
    );
    expect((storedTokenState.payload as Record<string, unknown>).resource).toBe(
      canonicalResource,
    );

    // 6. Tools/list via stateless modern MCP protocol
    const toolsListRes = await app.fetch(
      modernRequest("tools/list", 1, {}, mcpAccessToken),
    );
    expect(toolsListRes.status).toBe(200);
    const toolsListBody = await rpcBody(toolsListRes);
    const toolNames = toolsListBody.result.tools.map(
      (t: { name: string }) => t.name,
    );
    expect(toolNames).toContain("whoami");
    expect(toolNames).toContain("list_workspaces");
    expect(toolNames).toContain("create_project");

    // 7. Call tool: whoami -> verify user identity returned and no session token leaked
    const whoamiRes = await app.fetch(
      modernRequest(
        "tools/call",
        2,
        { name: "whoami", arguments: {} },
        mcpAccessToken,
      ),
    );
    expect(whoamiRes.status).toBe(200);
    const whoamiBody = await rpcBody(whoamiRes);
    const whoamiData = JSON.parse(whoamiBody.result.content[0].text);
    expect(whoamiData.user).toMatchObject({
      id: member.user.id,
      name: "OAuth Agent",
    });
    expect(whoamiData).not.toHaveProperty("session");
    expect(whoamiBody.result.content[0].text).not.toContain(mcpAccessToken);
    expect(whoamiBody.result.content[0].text).not.toContain(loginSessionToken);

    // 8. Call tool: list_workspaces -> verify workspace list from real Postgres
    const listWsRes = await app.fetch(
      modernRequest(
        "tools/call",
        3,
        { name: "list_workspaces", arguments: {} },
        mcpAccessToken,
      ),
    );
    expect(listWsRes.status).toBe(200);
    const listWsBody = await rpcBody(listWsRes);
    const listWsData = JSON.parse(listWsBody.result.content[0].text);
    expect(Array.isArray(listWsData)).toBe(true);
    expect(
      listWsData.some((w: { id: string }) => w.id === member.workspace.id),
    ).toBe(true);

    // 9. Call tool: create_project -> verify project is created in real Postgres
    const createProjectRes = await app.fetch(
      modernRequest(
        "tools/call",
        4,
        {
          name: "create_project",
          arguments: {
            workspaceId: member.workspace.id,
            name: "ChatGPT Created Project",
            icon: "Folder",
            slug: "chatgpt-created-project",
          },
        },
        mcpAccessToken,
      ),
    );
    expect(createProjectRes.status).toBe(200);
    const createProjectBody = await rpcBody(createProjectRes);
    expect(createProjectBody.result.isError).toBeFalsy();

    // Verify database record in Postgres
    const [insertedProject] = await db
      .select()
      .from(schema.projectTable)
      .where(eq(schema.projectTable.slug, "chatgpt-created-project"));
    expect(insertedProject).toBeTruthy();
    expect(insertedProject.name).toBe("ChatGPT Created Project");
    expect(insertedProject.workspaceId).toBe(member.workspace.id);

    // 10. Call tool: create_project on an unauthorized workspace -> rejected
    const unauthorizedProjectRes = await app.fetch(
      modernRequest(
        "tools/call",
        5,
        {
          name: "create_project",
          arguments: {
            workspaceId: "workspace-unauthorized-123",
            name: "Hacker Project",
            icon: "Folder",
            slug: "hacker-project",
          },
        },
        mcpAccessToken,
      ),
    );
    expect(unauthorizedProjectRes.status).toBe(200);
    const unauthorizedBody = await rpcBody(unauthorizedProjectRes);
    expect(unauthorizedBody.result.isError).toBe(true);
    expect(unauthorizedBody.result.content[0].text).toContain("error");

    // 11. Call /mcp with a regular session token (not an MCP OAuth token) -> 401
    const plainSessionRes = await app.fetch(
      modernRequest("tools/list", 6, {}, loginSessionToken),
    );
    expect(plainSessionRes.status).toBe(401);
    expect(plainSessionRes.headers.get("www-authenticate")).toContain(
      "resource_metadata=",
    );
  });
});
