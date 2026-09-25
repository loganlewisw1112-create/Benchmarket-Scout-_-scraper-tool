// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import DataQualityBanner from "./DataQualityBanner";
import type { DataQuality } from "@/lib/types";

const base: DataQuality = {
  coverageStatus: "partial",
  realCompetitorsFound: 10,
  scoredCompetitors: 6,
  failedAudits: 1,
  limitedAudits: 0,
  unavailableFields: [],
  cacheHit: false,
  notes: [],
};

describe("DataQualityBanner counts", () => {
  it("shows the discovered count separately from the capped listed count", () => {
    render(
      <DataQualityBanner
        dataQuality={{ ...base, discoveredCount: 37, discoveryTruncated: true }}
      />
    );
    expect(screen.getByText("Nearby businesses found: 37+")).toBeInTheDocument();
    expect(screen.getByText("Businesses listed: 10")).toBeInTheDocument();
    expect(screen.getByText("Scored competitors: 6")).toBeInTheDocument();
  });

  it("does not claim a discovered count for older reports that lack one", () => {
    render(<DataQualityBanner dataQuality={base} />);
    expect(screen.queryByText(/Nearby businesses found/)).toBeNull();
    expect(screen.getByText("Businesses listed: 10")).toBeInTheDocument();
  });
});
