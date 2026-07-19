// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import MaintenancePage from "./MaintenancePage";

describe("MaintenancePage", () => {
  it("explains the real-data maintenance window", () => {
    render(<MaintenancePage />);

    expect(
      screen.getByRole("heading", {
        name: /making every report source-verifiable/i,
      })
    ).toBeInTheDocument();
    expect(screen.getByText(/Real public sources only/i)).toBeInTheDocument();
  });
});

