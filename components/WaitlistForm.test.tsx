// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import WaitlistForm from "./WaitlistForm";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WaitlistForm", () => {
  it("submits optional feedback with the waitlist context", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: "added", message: "Thanks!" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<WaitlistForm source="report" reportId="report-123" />);

    await user.type(screen.getByLabelText("Email"), "Owner@Example.com");
    await user.type(
      screen.getByLabelText(/Feedback/),
      "The competitor list was useful."
    );
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/waitlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "Owner@Example.com",
        message: "The competitor list was useful.",
        source: "report",
        reportId: "report-123",
      }),
    });
  });

  it("caps feedback at 1000 characters in the browser", () => {
    render(<WaitlistForm />);

    expect(screen.getByLabelText(/Feedback/)).toHaveAttribute(
      "maxlength",
      "1000"
    );
  });

  it("shows consent copy with a link to the privacy page", () => {
    render(<WaitlistForm />);

    expect(screen.getByText(/By sending, you agree/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "privacy page" })).toHaveAttribute(
      "href",
      "/privacy"
    );
    expect(screen.getByRole("button", { name: "Send" })).toHaveAttribute(
      "aria-describedby",
      "waitlist-consent"
    );
  });

  it("explains a rate limit using the API code and Retry-After", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json(
          { code: "RATE_LIMITED", error: "Too many requests." },
          { status: 429, headers: { "Retry-After": "30" } }
        )
      )
    );
    const user = userEvent.setup();
    render(<WaitlistForm />);

    await user.type(screen.getByLabelText("Email"), "owner@example.com");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Please try again in 30 seconds."
    );
  });

  it("reports a network failure as a connection problem", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const user = userEvent.setup();
    render(<WaitlistForm />);

    await user.type(screen.getByLabelText("Email"), "owner@example.com");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/internet connection/);
  });
});
