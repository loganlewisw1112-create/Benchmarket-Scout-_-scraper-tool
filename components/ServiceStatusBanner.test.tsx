// @vitest-environment happy-dom
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ServiceStatusBanner, { describeDegradedHealth } from "./ServiceStatusBanner";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubHealth(body: unknown, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("ServiceStatusBanner", () => {
  it("shows the affected parts when /api/health reports degraded", async () => {
    const fetchMock = stubHealth(
      { status: "degraded", alertReasons: ["DURABLE_STORE_UNAVAILABLE"] },
      503
    );
    render(<ServiceStatusBanner />);
    expect(await screen.findByRole("status")).toHaveTextContent(
      /may not be saved or shareable/
    );
    expect(fetchMock.mock.calls[0][0]).toBe("/api/health");
  });

  it("renders nothing while healthy or in maintenance", async () => {
    const fetchMock = stubHealth({ status: "ok", alertReasons: [] });
    const { container } = render(<ServiceStatusBanner />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    expect(describeDegradedHealth({ status: "maintenance", alertReasons: [] })).toBeNull();
  });

  it("renders nothing when the health check cannot be read", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const { container } = render(<ServiceStatusBanner />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container).toBeEmptyDOMElement();
  });

  it("falls back to a general line for unknown alert reasons", () => {
    expect(describeDegradedHealth({ status: "degraded", alertReasons: ["NEW_REASON"] })).toEqual([
      "Some features may not work as expected.",
    ]);
    expect(
      describeDegradedHealth({ status: "degraded", alertReasons: ["SERVED_SAMPLES_STALE"] })
    ).toEqual(["Sample reports are older than usual."]);
  });
});
