// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { SourceId } from "@/lib/types";
import SourcesAppendix, {
  CitationMarkers,
  describeSourceUrl,
} from "./ProvenanceDetails";

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

describe("describeSourceUrl", () => {
  it("shows the domain plus a decoded, shortened query instead of raw percent-encoding", () => {
    const url =
      "https://api.gdeltproject.org/api/v2/doc/doc?query=%22Absolute%20Air%20Solutions%22%20(%22award%22%20OR%20%22opening%22%20OR%20%22expansion%22%20OR%20%22hiring%22)&mode=ArtList&format=json";
    const { domain, detail, linkable } = describeSourceUrl(url);
    expect(domain).toBe("api.gdeltproject.org");
    expect(linkable).toBe(true);
    expect(detail).toContain('"Absolute Air Solutions"');
    expect(detail).not.toContain("%22");
    expect(detail.length).toBeLessThanOrEqual(72);
    expect(detail.endsWith("…")).toBe(true);
  });

  it("keeps malformed escapes readable instead of throwing", () => {
    expect(describeSourceUrl("https://example.com/a%E0%A4%A").detail).toBe("/a%E0%A4%A");
  });

  it("does not present the POST-only Overpass endpoint as a link", () => {
    expect(describeSourceUrl("https://overpass-api.de/api/interpreter")).toMatchObject({
      domain: "overpass-api.de",
      linkable: false,
    });
  });
});

describe("SourcesAppendix", () => {
  it("wraps URLs at word boundaries and keeps the full URL in href/title", () => {
    const url = "https://www.example.com/services/emergency%20plumbing";
    render(
      <SourcesAppendix
        sources={[
          {
            id: "S1",
            kind: "homepage",
            provider: "Public website",
            title: "Example homepage",
            url,
            accessedAt: "2026-09-22T14:04:16.509Z",
            status: "used",
          },
        ]}
      />
    );
    const link = screen.getByRole("link", { name: /example\.com/ });
    expect(link).toHaveAttribute("href", url);
    expect(link).toHaveAttribute("title", url);
    expect(link).toHaveTextContent("/services/emergency plumbing");
    expect(link.closest("td")?.className).toContain("break-words");
    expect(link.closest("td")?.className).not.toContain("break-all");
    expect(screen.getByText("2026-09-22 14:04 UTC")).toBeInTheDocument();
    // Homepage-only sources carry no OSM data, so no OSM notice is needed.
    expect(screen.queryByText(/OpenStreetMap contributors/)).not.toBeInTheDocument();
  });
});
