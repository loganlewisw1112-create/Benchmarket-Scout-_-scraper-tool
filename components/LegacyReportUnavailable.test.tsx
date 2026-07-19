// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import LegacyReportUnavailable from "./LegacyReportUnavailable";

describe("LegacyReportUnavailable", () => {
  it("explains why legacy reports are withheld and offers a new run", () => {
    render(<LegacyReportUnavailable status="legacy" />);

    expect(
      screen.getByRole("heading", {
        name: "This report cannot be displayed safely",
      })
    ).toBeInTheDocument();
    expect(screen.getByText(/before Benchmark Scout required/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Run a new report" })).toHaveAttribute(
      "href",
      "/"
    );
  });

  it("distinguishes invalid reports from missing links", () => {
    render(<LegacyReportUnavailable status="invalid" />);

    expect(screen.getByText(/does not pass/i)).toBeInTheDocument();
    expect(screen.queryByText(/link may be broken/i)).not.toBeInTheDocument();
  });
});
