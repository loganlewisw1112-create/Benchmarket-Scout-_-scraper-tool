import { describe, expect, it } from "vitest";
import * as route from "@/app/api/[[...path]]/route";

// api-contract-5: unknown /api paths answer JSON, not the HTML 404 page.
describe("/api catch-all route", () => {
  const methods = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

  it.each(methods)("returns a JSON 404 for %s", async (method) => {
    const handler = route[method];
    const response = handler(
      new Request("http://localhost/api/does-not-exist", { method })
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("x-request-id")).toBeTruthy();
    expect(await response.json()).toEqual({
      code: "NOT_FOUND",
      error: expect.any(String),
    });
  });

  it("is dynamic so the 404 is never prerendered", () => {
    expect(route.dynamic).toBe("force-dynamic");
  });
});
