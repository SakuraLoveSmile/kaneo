import { describe, expect, it } from "vitest";
import { listTasksQuery } from "../../apps/api/src/task/schema";

describe("task search validation and escaping", () => {
  it("trims whitespace from search input", () => {
    const parsed = listTasksQuery.parse({ search: "   release v1.0   " });
    expect(parsed.search).toBe("release v1.0");
  });

  it("allows search string up to 200 characters", () => {
    const validSearch = "x".repeat(200);
    const parsed = listTasksQuery.parse({ search: validSearch });
    expect(parsed.search).toBe(validSearch);
  });

  it("rejects search string longer than 200 characters", () => {
    const invalidSearch = "x".repeat(201);
    const result = listTasksQuery.safeParse({ search: invalidSearch });
    expect(result.success).toBe(false);
  });

  it("handles optional or omitted search parameter", () => {
    const parsed = listTasksQuery.parse({});
    expect(parsed.search).toBeUndefined();
  });

  it("correctly escapes SQL LIKE wildcards (% and _) and backslashes", () => {
    const escapeSqlLike = (str: string) => str.replace(/[%_\\]/g, "\\$&");

    expect(escapeSqlLike("100% coverage")).toBe("100\\% coverage");
    expect(escapeSqlLike("task_item_1")).toBe("task\\_item\\_1");
    expect(escapeSqlLike("path\\to\\file")).toBe("path\\\\to\\\\file");
    expect(escapeSqlLike("100%_special\\char")).toBe(
      "100\\%\\_special\\\\char",
    );
    expect(escapeSqlLike("normal search query")).toBe("normal search query");
  });
});
