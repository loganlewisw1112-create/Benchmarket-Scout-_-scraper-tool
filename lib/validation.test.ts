import { describe, expect, it } from "vitest";
import {
  validateAnalyzeMarketRequest,
  validationErrorDetails,
  validationErrorMessage,
} from "./validation";

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

  it("strips markup delimiters and control characters only", () => {
    const result = validateAnalyzeMarketRequest({
      ...validInput,
      businessName: 'Acme <script>"Plumbing"',
      businessType: "plumbing\u0000  services",
      market: "Austin, {TX}",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.businessName).toBe('Acme script"Plumbing"');
      expect(result.data.businessType).toBe("plumbing services");
      expect(result.data.market).toBe("Austin, TX");
    }
  });

  it("keeps apostrophes and quotes in real names and markets", () => {
    const result = validateAnalyzeMarketRequest({
      ...validInput,
      businessName: "Al’s Barbershop",
      businessType: "barber",
      market: "St. John's, NL",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.businessName).toBe("Al’s Barbershop");
      expect(result.data.market).toBe("St. John's, NL");
    }
    const straight = validateAnalyzeMarketRequest({
      ...validInput,
      businessName: "O'Brien & Sons Plumbing",
      market: "O'Fallon, MO",
    });
    expect(straight.success && straight.data.businessName).toBe(
      "O'Brien & Sons Plumbing"
    );
    expect(straight.success && straight.data.market).toBe("O'Fallon, MO");
  });

  it("requires the market to name a region so it cannot silently resolve elsewhere", () => {
    const result = validateAnalyzeMarketRequest({ ...validInput, market: "Portland" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(validationErrorDetails(result.error).fieldErrors.market?.[0]).toMatch(
        /state or country/
      );
    }
    expect(
      validateAnalyzeMarketRequest({ ...validInput, market: "Portland, ME" }).success
    ).toBe(true);
    expect(
      validateAnalyzeMarketRequest({ ...validInput, market: "Leeds, UK" }).success
    ).toBe(true);
    expect(
      validateAnalyzeMarketRequest({ ...validInput, market: "Portland, " }).success
    ).toBe(false);
  });

  it("uses the rule-specific message as the 400 error text, else a generic line", () => {
    const noRegion = validateAnalyzeMarketRequest({ ...validInput, market: "Portland" });
    expect(!noRegion.success && validationErrorMessage(noRegion.error)).toMatch(
      /state or country/
    );
    const tooShort = validateAnalyzeMarketRequest({ ...validInput, businessName: "A" });
    expect(!tooShort.success && validationErrorMessage(tooShort.error)).toBe(
      "Invalid input."
    );
  });

  it("reports unknown keys in the 400 details instead of dropping them", () => {
    const result = validateAnalyzeMarketRequest({ ...validInput, extra: "field" });
    expect(result.success).toBe(false);
    if (!result.success) {
      const details = validationErrorDetails(result.error);
      expect(details.formErrors.join(" ")).toMatch(/extra/);
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

  it("rejects the legacy options/demoMode input", () => {
    expect(
      validateAnalyzeMarketRequest({
        ...validInput,
        options: { demoMode: "mock" },
      }).success
    ).toBe(false);
  });

  it("rejects all unknown top-level fields", () => {
    expect(
      validateAnalyzeMarketRequest({
        ...validInput,
        unexpected: true,
      }).success
    ).toBe(false);
  });

  it("rejects non-HTTP business URLs", () => {
    expect(
      validateAnalyzeMarketRequest({ ...validInput, businessUrl: "acme.test" })
        .success
    ).toBe(false);
    expect(
      validateAnalyzeMarketRequest({ ...validInput, businessUrl: "ftp://acme.test" })
        .success
    ).toBe(false);
  });
});
