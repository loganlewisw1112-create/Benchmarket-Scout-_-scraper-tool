// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import HomePage from "./HomePage";

// The dashboard has its own tests; here only the page's own states matter.
vi.mock("./ResultsDashboard", () => ({
  default: () => <div data-testid="results-dashboard" />,
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function submitForm() {
  const user = userEvent.setup();
  await user.type(screen.getByPlaceholderText("Logan Lawn Care"), "Acme Plumbing");
  await user.type(screen.getByLabelText("Business website"), "acme.example.org");
  await user.type(
    screen.getByPlaceholderText("landscaping, plumbing, dentist…"),
    "plumbing"
  );
  await user.type(screen.getByPlaceholderText("Dallas, TX"), "Springfield");
  await user.click(screen.getByRole("button", { name: "Analyze Market" }));
}

describe("HomePage key gate UI", () => {
  it("hides the access-code button and panel when the gate is off", () => {
    render(<HomePage keyGateEnabled={false} />);

    expect(
      screen.queryByRole("button", { name: /Access code/ })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText("Paste your beta access code")
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "See a real sample report" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Analyze Market" })
    ).toBeInTheDocument();
  });

  it("keeps the access-code control available when the gate is on", () => {
    render(<HomePage keyGateEnabled />);

    expect(
      screen.getByRole("button", { name: "Access code" })
    ).toBeInTheDocument();
  });
});

describe("HomePage error states", () => {
  it("shows the server's specific message for an ambiguous market", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json(
        {
          code: "AMBIGUOUS_MARKET",
          error:
            '"Springfield" matches several places (Springfield, IL; Springfield, MO). Add the state or country so the right one is used.',
        },
        { status: 422 }
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<HomePage keyGateEnabled={false} />);

    await submitForm();

    expect(await screen.findByText(/Springfield, IL; Springfield, MO/)).toBeInTheDocument();
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.businessUrl).toBe("https://acme.example.org");
  });

  it("treats a non-JSON 504 page as a server problem, not a network one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("<html>Gateway Timeout</html>", { status: 504 }))
    );
    render(<HomePage keyGateEnabled={false} />);

    await submitForm();

    expect(await screen.findByText(/problem on our side/)).toBeInTheDocument();
    expect(screen.queryByText(/internet connection/)).not.toBeInTheDocument();
  });

  it("reports a failed fetch as a connection problem", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    render(<HomePage keyGateEnabled={false} />);

    await submitForm();

    expect(await screen.findByText(/internet connection/)).toBeInTheDocument();
  });

  it("gives the retry time when rate limited", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json(
          { code: "RATE_LIMITED", error: "Too many requests." },
          { status: 429, headers: { "Retry-After": "120" } }
        )
      )
    );
    render(<HomePage keyGateEnabled={false} />);

    await submitForm();

    expect(
      await screen.findByText("Too many requests right now. Please try again in 2 minutes.")
    ).toBeInTheDocument();
  });
});

describe("HomePage sample view", () => {
  it("labels the sample with its generation date and age", async () => {
    const generatedAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          sampleId: "sample-1",
          reportId: "report-abc123",
          generatedAt,
          freshness: "active",
          report: { generatedAt, reportId: "report-abc123" },
        })
      )
    );
    const user = userEvent.setup();
    render(<HomePage keyGateEnabled={false} />);

    await user.click(screen.getByRole("button", { name: "See a real sample report" }));

    expect(await screen.findByText("Real sample report")).toBeInTheDocument();
    expect(screen.getByText(/3 days ago/)).toBeInTheDocument();
    expect(screen.getByTestId("results-dashboard")).toBeInTheDocument();
  });
});
