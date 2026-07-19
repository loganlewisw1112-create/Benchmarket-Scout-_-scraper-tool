import { describe, expect, it } from "vitest";
import {
  buildSignalScanFromPageTexts,
  extractChangeSignals,
  extractHiringSignals,
  extractMomentumSignals,
  extractOfferSignals,
  extractRiskSignals,
  extractSocialLinksFromHrefs,
} from "./signals";
import type { PageText } from "./audit";

describe("keyword signal extractors", () => {
  it("returns no signals when no keywords are present", () => {
    const sourceUrl = "https://example.org/";
    expect(extractMomentumSignals("just a plain sentence", sourceUrl)).toEqual([]);
    expect(extractRiskSignals("just a plain sentence", sourceUrl)).toEqual([]);
    expect(extractChangeSignals("just a plain sentence", sourceUrl)).toEqual([]);
    expect(extractOfferSignals("just a plain sentence", sourceUrl)).toEqual([]);
    expect(extractHiringSignals("just a plain sentence", sourceUrl)).toEqual([]);
  });

  it("detects a single keyword hit with low confidence", () => {
    const [signal] = extractMomentumSignals(
      "We just won an award for excellence.",
      "https://example.org/about",
      "linked_page",
      ["S2"]
    );
    expect(signal.label).toBe("Momentum language detected");
    expect(signal.evidence).toContain('"award"');
    expect(signal.sourceUrl).toBe("https://example.org/about");
    expect(signal.sourceType).toBe("linked_page");
    expect(signal.sourceIds).toEqual(["S2"]);
    expect(signal.confidence).toBe("low");
  });

  it("escalates confidence to medium with multiple keyword hits", () => {
    const [signal] = extractRiskSignals(
      "We apologize for the delay and reduced hours this week.",
      "https://example.org/"
    );
    expect(signal.confidence).toBe("medium");
  });

  it("detects change, offer, and hiring language independently", () => {
    expect(extractChangeSignals("Under new management as of this year.", "https://example.org/")).toHaveLength(1);
    expect(extractOfferSignals("Ask about our financing and 24/7 emergency service.", "https://example.org/")).toHaveLength(1);
    expect(extractHiringSignals("We are hiring a new technician.", "https://example.org/")).toHaveLength(1);
  });

  it("defaults sourceType to homepage when omitted", () => {
    const [signal] = extractMomentumSignals(
      "Grand opening this weekend!",
      "https://example.org/",
      undefined,
      ["S1"]
    );
    expect(signal.sourceType).toBe("homepage");
    expect(signal.sourceUrl).toBe("https://example.org/");
    expect(signal.sourceIds).toEqual(["S1"]);
  });
});

describe("buildSignalScanFromPageTexts", () => {
  it("aggregates signals across multiple pages and preserves social links", () => {
    const pages: PageText[] = [
      { url: "https://example.org/", text: "We are hiring a crew leader.", sourceType: "homepage", sourceIds: ["S1"] },
      {
        url: "https://example.org/about",
        text: "Under new management. Free estimate available.",
        sourceType: "linked_page",
        sourceIds: ["S2"],
      },
    ];

    const scan = buildSignalScanFromPageTexts(
      pages,
      { facebook: "https://facebook.com/acme" },
      "complete"
    );

    expect(scan.socialLinks).toEqual({ facebook: "https://facebook.com/acme" });
    expect(scan.hiringSignals).toHaveLength(1);
    expect(scan.changeSignals).toHaveLength(1);
    expect(scan.offerSignals).toHaveLength(1);
    expect(scan.momentumSignals).toHaveLength(0);
    expect(scan.riskSignals).toHaveLength(0);
    expect(scan.newsSignals).toEqual([]);
    expect(scan.sourceIds).toEqual(["S1", "S2"]);
    // Raw scores are computed elsewhere (lib/scoring.ts), not here.
    expect(scan.momentumScore).toBe(0);
  });

  it("returns empty signal arrays for empty page text input", () => {
    const scan = buildSignalScanFromPageTexts([], {}, "unavailable");
    expect(scan.momentumSignals).toEqual([]);
    expect(scan.riskSignals).toEqual([]);
    expect(scan.changeSignals).toEqual([]);
    expect(scan.offerSignals).toEqual([]);
    expect(scan.hiringSignals).toEqual([]);
    expect(scan.momentumScore).toBeNull();
    expect(scan.riskScore).toBeNull();
  });
});

describe("extractSocialLinksFromHrefs", () => {
  const platforms: Array<[string, string]> = [
    ["facebook", "https://facebook.com/acme"],
    ["instagram", "https://instagram.com/acme"],
    ["linkedin", "https://linkedin.com/company/acme"],
    ["youtube", "https://youtube.com/acme"],
    ["x", "https://x.com/acme"],
    ["tiktok", "https://tiktok.com/@acme"],
  ];

  for (const [platform, href] of platforms) {
    it(`detects a ${platform} link`, () => {
      const links = extractSocialLinksFromHrefs([href]);
      expect(links[platform as keyof typeof links]).toBe(href);
    });
  }

  it("recognizes legacy twitter.com URLs as the x platform", () => {
    const links = extractSocialLinksFromHrefs(["https://twitter.com/acme"]);
    expect(links.x).toBe("https://twitter.com/acme");
  });

  it("ignores non-social hrefs", () => {
    expect(
      extractSocialLinksFromHrefs(["https://example.org/contact", "https://example.org/about"])
    ).toEqual({});
  });

  it("keeps the first match per platform", () => {
    const links = extractSocialLinksFromHrefs([
      "https://facebook.com/acme-first",
      "https://facebook.com/acme-second",
    ]);
    expect(links.facebook).toBe("https://facebook.com/acme-first");
  });
});
