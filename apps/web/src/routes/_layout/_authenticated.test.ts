import { isRedirect } from "@tanstack/react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authClient } from "@/lib/auth-client";
import { Route } from "./_authenticated";

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    getSession: vi.fn(),
  },
}));

type RedirectError = {
  options: {
    to: string;
    search: {
      redirect: string;
    };
  };
};

describe("_authenticated route guard (beforeLoad)", () => {
  const beforeLoad = Route.options.beforeLoad;
  if (!beforeLoad) {
    throw new Error("Route.options.beforeLoad is undefined");
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("redirects unauthenticated user accessing /dashboard with redirect=/dashboard", async () => {
    vi.mocked(authClient.getSession).mockResolvedValue({
      data: null,
      error: null,
    });

    const location = {
      href: "/dashboard",
      pathname: "/dashboard",
      search: {},
      hash: "",
    };

    let caughtError: unknown;
    try {
      // @ts-expect-error test mock location
      await beforeLoad({ location });
    } catch (err) {
      caughtError = err;
    }

    expect(isRedirect(caughtError)).toBe(true);
    const redirectErr = caughtError as RedirectError;
    expect(redirectErr.options).toMatchObject({
      to: "/auth/sign-in",
      search: {
        redirect: "/dashboard",
      },
    });
  });

  it("does not throw type conversion error when location.search is Object.create(null)", async () => {
    vi.mocked(authClient.getSession).mockResolvedValue({
      data: null,
      error: null,
    });

    const nullProtoSearch = Object.create(null) as Record<string, unknown>;
    const location = {
      href: "/dashboard",
      pathname: "/dashboard",
      search: nullProtoSearch,
      hash: "",
    };

    let caughtError: unknown;
    try {
      // @ts-expect-error test mock location
      await beforeLoad({ location });
    } catch (err) {
      caughtError = err;
    }

    // Should not throw "TypeError: Cannot convert object to primitive value"
    expect(caughtError).not.toBeInstanceOf(TypeError);
    expect(isRedirect(caughtError)).toBe(true);
    const redirectErr = caughtError as RedirectError;
    expect(redirectErr.options.search.redirect).toBe("/dashboard");
  });

  it("preserves query string and hash in redirect parameter for /dashboard?view=list#tasks", async () => {
    vi.mocked(authClient.getSession).mockResolvedValue({
      data: null,
      error: null,
    });

    const location = {
      href: "/dashboard?view=list#tasks",
      pathname: "/dashboard",
      search: { view: "list" },
      hash: "tasks",
    };

    let caughtError: unknown;
    try {
      // @ts-expect-error test mock location
      await beforeLoad({ location });
    } catch (err) {
      caughtError = err;
    }

    expect(isRedirect(caughtError)).toBe(true);
    const redirectErr = caughtError as RedirectError;
    expect(redirectErr.options.search.redirect).toBe(
      "/dashboard?view=list#tasks",
    );
  });

  it("returns session and does not redirect when user is authenticated", async () => {
    const mockSession = {
      user: {
        id: "user_1",
        name: "Alice",
        email: "alice@example.com",
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      session: {
        id: "sess_1",
        userId: "user_1",
        token: "token_1",
        expiresAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    };
    vi.mocked(authClient.getSession).mockResolvedValue({
      data: mockSession,
      error: null,
    });

    const location = {
      href: "/dashboard",
      pathname: "/dashboard",
      search: {},
      hash: "",
    };

    // @ts-expect-error test mock location
    const result = await beforeLoad({ location });
    expect(result).toEqual({
      session: mockSession,
      sessionError: false,
    });
  });

  it("maintains sessionError behavior and skips redirect when getSession throws", async () => {
    vi.mocked(authClient.getSession).mockRejectedValue(
      new Error("Network connection dropped"),
    );

    const location = {
      href: "/dashboard",
      pathname: "/dashboard",
      search: {},
      hash: "",
    };

    // @ts-expect-error test mock location
    const result = await beforeLoad({ location });
    expect(result).toEqual({
      session: null,
      sessionError: true,
    });
  });
});
