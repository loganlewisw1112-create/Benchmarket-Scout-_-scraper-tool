import { describe, expect, it } from "vitest";
import { validateAnalyzeMarketRequest } from "./validation";

const validInput = {
  businessName: "Acme Plumbing",
  businessUrl: "https://acme-plumbing.example.org",
  businessType: "plumbing",
  market: "Austin, TX",
};

describe("validateAnalyzeMarketRequest", () => {
  it("accepts a well-formed request", () => {
    const result = validateAnalyzeMarketRequest(validInput);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.businessName).toBe("Acme Plumbing");
      expect(result.data.market).toBe("Austin, TX");
    }
  });

  it("strips dangerous characters from name, type, and market", () => {
    const result = validateAnalyzeMarketRequest({
      ...validInput,
      businessName: 'Acme <script>"Plumbing"',
      businessType: "plumbing; DROP TABLE",
      market: "Austin {TX} $",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.businessName).toBe("Acme scriptPlumbing");
      expect(result.data.businessType).toBe("plumbing DROP TABLE");
      expect(result.data.market).toBe("Austin TX");
    }
  });

  it("trims but does not mangle the business URL", () => {
    const result = validateAnalyzeMarketRequest({
      ...validInput,
      businessUrl: "  https://acme.example.org  ",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.businessUrl).toBe("https://acme.example.org");
    }
  });

  it("rejects values below minimum length", () => {
    expect(
      validateAnalyzeMarketRequest({ ...validInput, businessName: "A" }).success
    ).toBe(false);
    expect(
      validateAnalyzeMarketRequest({ ...validInput, market: "X" }).success
    ).toBe(false);
  });

  it("rejects values above maximum length", () => {
    expect(
      validateAnalyzeMarketRequest({
        ...validInput,
        businessName: "x".repeat(81),
      }).success
    ).toBe(false);
    expect(
      validateAnalyzeMarketRequest({
        ...validInput,
        businessUrl: `https://example.org/${"x".repeat(300)}`,
      }).success
    ).toBe(false);
  });

  it("rejects missing required fields", () => {
    const withoutUrl = {
      businessName: validInput.businessName,
      businessType: validInput.businessType,
      market: validInput.market,
    };
    expect(validateAnalyzeMarketRequest(withoutUrl).success).toBe(false);
    expect(validateAnalyzeMarketRequest({}).success).toBe(false);
    expect(validateAnalyzeMarketRequest(null).success).toBe(false);
  });

  it("enforces the demoMode enum", () => {
    expect(
      validateAnalyzeMarketRequest({
        ...validInput,
        options: { demoMode: "mock" },
      }).success
    ).toBe(true);
    expect(
      validateAnalyzeMarketRequest({
        ...validInput,
        options: { demoMode: "banana" },
      }).success
    ).toBe(false);
  });
});
