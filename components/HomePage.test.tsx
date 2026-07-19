// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import HomePage from "./HomePage";

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
