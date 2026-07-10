// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import BusinessForm from "./BusinessForm";

// Inputs are located by placeholder — the form's labels are not
// programmatically associated (no htmlFor/id pairing).
const PLACEHOLDERS = {
  name: "Logan Lawn Care",
  url: "https://example.com",
  type: "landscaping, plumbing, dentist…",
  market: "Dallas, TX",
};

describe("BusinessForm", () => {
  it("renders all four fields and the submit button", () => {
    render(<BusinessForm onSubmit={vi.fn()} isLoading={false} />);

    for (const placeholder of Object.values(PLACEHOLDERS)) {
      expect(screen.getByPlaceholderText(placeholder)).toBeInTheDocument();
    }
    expect(
      screen.getByRole("button", { name: "Analyze Market" })
    ).toBeInTheDocument();
  });

  it("does not submit while any field is empty", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<BusinessForm onSubmit={onSubmit} isLoading={false} />);

    await user.type(screen.getByPlaceholderText(PLACEHOLDERS.name), "Acme Co");
    await user.click(screen.getByRole("button", { name: "Analyze Market" }));

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits the entered values as an AnalyzeMarketRequest payload", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<BusinessForm onSubmit={onSubmit} isLoading={false} />);

    await user.type(
      screen.getByPlaceholderText(PLACEHOLDERS.name),
      "Acme Plumbing"
    );
    await user.type(
      screen.getByPlaceholderText(PLACEHOLDERS.url),
      "https://acme.example.org"
    );
    await user.type(screen.getByPlaceholderText(PLACEHOLDERS.type), "plumbing");
    await user.type(
      screen.getByPlaceholderText(PLACEHOLDERS.market),
      "Austin, TX"
    );
    await user.click(screen.getByRole("button", { name: "Analyze Market" }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({
      businessName: "Acme Plumbing",
      businessUrl: "https://acme.example.org",
      businessType: "plumbing",
      market: "Austin, TX",
    });
  });

  it("disables the button and shows progress text while loading", () => {
    render(<BusinessForm onSubmit={vi.fn()} isLoading={true} />);

    const button = screen.getByRole("button", { name: "Analyzing…" });
    expect(button).toBeDisabled();
  });
});
