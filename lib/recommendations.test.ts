import { describe, expect, it } from "vitest";
import { generateRecommendations } from "./recommendations";
import { makeReport } from "./test-fixtures";

function userWithScores(scoreBreakdown: {
  seo: number;
  conversion: number;
  trust: number;
  content: number;
  technical: number;
}) {
  return makeReport({
    name: "You",
    source: "user",
    finalScore: 40,
    websiteAudit: { skipped: false, scoreBreakdown },
  });
}

describe("generateRecommendations", () => {
  it("returns all 5 generic recommendations at medium priority when there are no competitors", () => {
    const user = userWithScores({ seo: 10, conversion: 10, trust: 10, content: 10, technical: 5 });

    const recs = generateRecommendations({ user, competitors: [] });

    expect(recs).toHaveLength(5);
    expect(recs.every((r) => r.priority === "medium")).toBe(true);
    expect(new Set(recs.map((r) => r.title)).size).toBe(5);
  });

  it("prioritizes gap-based recommendations by gap size", () => {
    // seo gap 15 (>8 -> high), conversion gap 6 (>4 -> medium), technical gap 1 (<=0.5 excluded)
    const user = userWithScores({ seo: 5, conversion: 14, trust: 15, content: 15, technical: 9 });
    const competitor = makeReport({
      name: "Rival",
      source: "overpass",
      finalScore: 80,
      websiteAudit: { skipped: false, scoreBreakdown: { seo: 20, conversion: 20, trust: 15, content: 15, technical: 9.4 } },
    });

    const recs = generateRecommendations({ user, competitors: [competitor] });

    const seoRec = recs.find((r) => r.title === "Close the on-page SEO gap");
    const conversionRec = recs.find((r) => r.title === "Close the conversion elements gap");

    expect(seoRec?.priority).toBe("high");
    expect(conversionRec?.priority).toBe("medium");
    // Largest gap (seo, 15) should be ordered before the smaller gap (conversion, 6).
    expect(recs.findIndex((r) => r === seoRec)).toBeLessThan(
      recs.findIndex((r) => r === conversionRec)
    );
  });

  it("fills remaining slots from the generic pool without duplicate titles, capped at 5", () => {
    // Only one real gap (seo); the rest must come from GENERIC_POOL.
    const user = userWithScores({ seo: 5, conversion: 20, trust: 15, content: 15, technical: 9 });
    const competitor = makeReport({
      name: "Rival",
      source: "overpass",
      finalScore: 80,
      websiteAudit: { skipped: false, scoreBreakdown: { seo: 20, conversion: 20, trust: 15, content: 15, technical: 9 } },
    });

    const recs = generateRecommendations({ user, competitors: [competitor] });

    expect(recs).toHaveLength(5);
    expect(recs[0].title).toBe("Close the on-page SEO gap");
    const titles = recs.map((r) => r.title);
    expect(new Set(titles).size).toBe(titles.length);
  });
});
