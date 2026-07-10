// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { generateRecommendations } from "@/lib/recommendations";
import { generateBenchmarkReport } from "@/lib/report";
import { buildMarketSummary, rankCompetitors } from "@/lib/scoring";
import { makeReport } from "@/lib/test-fixtures";
import type {
  AnalyzeMarketRequest,
  AnalyzeMarketResponse,
  DataQuality,
} from "@/lib/types";
import ResultsDashboard from "./ResultsDashboard";

// Assemble a full response through the real (pure, already-tested) pipeline
// pieces so the fixture always matches what production hands the dashboard.
function buildResponse(): AnalyzeMarketResponse {
  const input: AnalyzeMarketRequest = {
    businessName: "Verify Dental",
    businessUrl: "https://verify-dental.example.org",
    businessType: "dentist",
    market: "Austin, TX",
  };

  const user = makeReport({
    name: "Verify Dental",
    source: "user",
    finalScore: 55,
    website: input.businessUrl,
  });
  const rivalA = makeReport({
    name: "Rival Alpha Dental",
    source: "mock",
    finalScore: 72,
  });
  const rivalB = makeReport({
    name: "Rival Beta Dental",
    source: "mock",
    finalScore: 41,
  });

  const ranked = rankCompetitors(user, [rivalA, rivalB]);
  const summary = buildMarketSummary(ranked.user, ranked.competitors);
  const recommendations = generateRecommendations({
    user: ranked.user,
    competitors: ranked.competitors,
  });
  const dataQuality: DataQuality = {
    discoverySource: "mock",
    usedMockData: true,
    liveCompetitorsFound: 0,
    failedHomepageFetches: 0,
    limitedAudits: 0,
    cacheHit: false,
    notes: ["Mock demo mode is active for this test render."],
  };
  const report = generateBenchmarkReport({
    input,
    user: ranked.user,
    competitors: ranked.competitors,
    summary,
    recommendations,
    dataQuality,
  });

  return {
    input,
    market: { label: "Austin, TX (mock mode)", source: "mock" },
    user: ranked.user,
    competitors: ranked.competitors,
    summary,
    report,
    recommendations,
    dataQuality,
    generatedAt: new Date().toISOString(),
  };
}

describe("ResultsDashboard", () => {
  it("renders every dashboard section from a full pipeline response", () => {
    const data = buildResponse();
    render(<ResultsDashboard data={data} />);

    // Section heading owned by ResultsDashboard itself.
    expect(screen.getByText("Local Competitor Landscape")).toBeInTheDocument();

    // Competitor table rows (names may also appear in report highlights).
    expect(
      screen.getAllByText(/Rival Alpha Dental/).length
    ).toBeGreaterThan(0);
    expect(screen.getAllByText(/Rival Beta Dental/).length).toBeGreaterThan(0);

    // The user's business shows up in the landscape.
    expect(screen.getAllByText(/Verify Dental/).length).toBeGreaterThan(0);

    // Data-quality note surfaces (banner and/or report data-quality note).
    expect(
      screen.getAllByText("Mock demo mode is active for this test render.")
        .length
    ).toBeGreaterThan(0);

    // Recommendations render (panel and/or report action plan).
    expect(
      screen.getAllByText(data.recommendations[0].title).length
    ).toBeGreaterThan(0);
  });

  it("renders rank and score information for the ranked market", () => {
    const data = buildResponse();
    render(<ResultsDashboard data={data} />);

    // User finalScore 55 ranks #2 of 3 (72 > 55 > 41).
    expect(data.user.rank).toBe(2);
    // The final scores appear somewhere in the dashboard output.
    expect(screen.getAllByText(/72/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/55/).length).toBeGreaterThan(0);
  });
});
