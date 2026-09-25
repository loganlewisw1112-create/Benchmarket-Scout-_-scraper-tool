import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { config, proxy } from "@/proxy";
import { isValidRequestId, requestIdFrom } from "./request-id";

// api-contract-6: every /api response carries x-request-id.
describe("proxy x-request-id", () => {
  it("is scoped to /api", () => {
    expect(config.matcher).toBe("/api/:path*");
  });

  it("mints an id, forwards it to the route, and sets it on the response", () => {
    const response = proxy(new NextRequest("http://localhost/api/health"));
    const id = response.headers.get("x-request-id");
    expect(isValidRequestId(id)).toBe(true);
    // Next forwards request-header overrides via these internal headers.
    expect(response.headers.get("x-middleware-override-headers")).toContain(
      "x-request-id"
    );
    expect(response.headers.get("x-middleware-request-x-request-id")).toBe(id);
  });

  it("replaces a client-supplied id", () => {
    const response = proxy(
      new NextRequest("http://localhost/api/reports/abc", {
        headers: { "x-request-id": "client-chosen-id" },
      })
    );
    expect(response.headers.get("x-request-id")).not.toBe("client-chosen-id");
  });

  it.each(["/api/analyze-market", "/api/sample-report", "/api/waitlist", "/api/sample-report/refresh"])(
    "tags %s with the same id it forwards to the route",
    (path) => {
      const response = proxy(new NextRequest(`http://localhost${path}`, { method: "POST" }));
      const id = response.headers.get("x-request-id");
      expect(isValidRequestId(id)).toBe(true);
      // The route adopts this forwarded id via requestIdFrom(), so a header
      // it sets itself carries the same value.
      expect(response.headers.get("x-middleware-request-x-request-id")).toBe(id);
    }
  );
});

describe("requestIdFrom", () => {
  it("reuses a well-formed forwarded id and mints otherwise", () => {
    expect(requestIdFrom(new Headers({ "x-request-id": "abc-12345" }))).toBe(
      "abc-12345"
    );
    expect(requestIdFrom(new Headers({ "x-request-id": "short" }))).not.toBe("short");
    expect(
      requestIdFrom(new Request("http://localhost/", { headers: { "x-request-id": "a b c-1234" } }))
    ).toMatch(/^[0-9a-f-]{36}$/);
  });
});
