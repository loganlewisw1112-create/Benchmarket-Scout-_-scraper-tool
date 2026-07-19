import { describe, expect, it } from "vitest";
import { validateRealReport, validateSharedReportHtml } from "./validate-real-report.mjs";

function validReport() {
  const unavailableAudit = {
    auditStatus: "unavailable",
    h1Count: null, headingCount: null, wordCount: null, ctaCount: null,
    hasPhone: null, hasEmail: null, hasContactPage: null,
    hasBookingOrQuote: null, hasPricingPage: null, hasServicesPage: null,
    hasAboutOrTeamPage: null, hasBlogOrNewsPage: null, hasCareersPage: null,
    hasTestimonials: null, hasTrustLanguage: null,
    hasGalleryOrCaseStudy: null, hasSocialLinks: null, hasViewport: null,
    isHttps: null, htmlBytes: null, fetchMs: null, websiteScore: null,
    sourceIds: ["S1"],
  };
  return {
    schemaVersion: 2,
    provenance: {
      policy: "real-only",
      containsSyntheticData: false,
      sources: [{
        id: "S1", kind: "user_input", provider: "User input",
        title: "Input", url: "https://business.test/", businessName: "Business",
        accessedAt: "2026-07-19T00:00:00.000Z", status: "used",
      }],
    },
    user: {
      name: "Business", source: "user", sourceIds: ["S1"],
      auditStatus: "unavailable", websiteAudit: unavailableAudit,
      finalScore: null, rank: null,
    },
    competitors: [],
    report: { topFindings: [], topRisks: [], competitorHighlights: [], actionPlan: [] },
  };
}

describe("real report launch validator", () => {
  it("accepts a source-resolved partial real report", () => {
    expect(validateRealReport(validReport())).toEqual({ sourceCount: 1, scoredEntityCount: 0 });
  });

  it("allows an unavailable nested audit to have no direct source mapping", () => {
    const report = validReport();
    report.user.websiteAudit.sourceIds = [];
    expect(validateRealReport(report)).toEqual({ sourceCount: 1, scoredEntityCount: 0 });
  });

  it("rejects legacy demo fields even when false", () => {
    const report = validReport();
    report.dataQuality = { usedMockData: false };
    expect(() => validateRealReport(report)).toThrow(/usedMockData/);
  });

  it("requires appendix and robots metadata on shared HTML", () => {
    expect(() => validateSharedReportHtml("<meta name='robots' content='index'>"))
      .toThrow(/Sources Appendix/);
    expect(() => validateSharedReportHtml(
      "<meta name='robots' content='noindex,nofollow'><meta property='og:title' content='Report'><meta property='og:description' content='Observed report'><h2>Sources Appendix</h2><span>[S1]</span>"
    ))
      .not.toThrow();
  });
});
