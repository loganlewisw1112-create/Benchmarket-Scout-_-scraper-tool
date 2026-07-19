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
});
