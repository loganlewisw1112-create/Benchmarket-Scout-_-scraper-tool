// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { SourceId } from "@/lib/types";
import { CitationMarkers } from "./ProvenanceDetails";

const manySources = Array.from(
  { length: 23 },
  (_, i) => `S${i + 1}` as SourceId
);

describe("CitationMarkers", () => {
  it("renders nothing when there are no sources", () => {
    const { container } = render(<CitationMarkers sourceIds={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("exposes the sources to assistive tech", () => {
    render(<CitationMarkers sourceIds={["S1", "S4"] as SourceId[]} />);
    expect(screen.getByLabelText("Sources S1, S4")).toBeInTheDocument();
  });

  // Regression guard: a long citation run used to be one nowrap span, which
  // overflowed its grid column on the report page and painted over the
  // neighbouring column. Each marker may be individually unbreakable, but the
  // run as a whole has to stay wrappable.
  it("keeps each marker unbreakable without making the run unwrappable", () => {
    render(<CitationMarkers sourceIds={manySources} />);

    const group = screen.getByLabelText(`Sources ${manySources.join(", ")}`);
    expect(group.className).not.toContain("whitespace-nowrap");

    const markers = group.querySelectorAll("span.whitespace-nowrap");
    expect(markers).toHaveLength(manySources.length);
    expect(markers[0]).toHaveTextContent("[S1]");

    // separated by real whitespace, so the browser has somewhere to wrap
    expect(group.textContent).toContain("[S1] [S2]");
  });
});
