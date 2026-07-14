import { describe, expect, it } from "vitest";
import { validateWaitlistRequest } from "./waitlist";

describe("validateWaitlistRequest", () => {
  it("accepts and normalizes a valid email", () => {
    const parsed = validateWaitlistRequest({ email: "Test@Example.COM" });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.email).toBe("test@example.com");
    }
  });

  it("preserves optional source and reportId", () => {
    const parsed = validateWaitlistRequest({
      email: "a@b.com",
      source: "report",
      reportId: "abc123",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.source).toBe("report");
      expect(parsed.data.reportId).toBe("abc123");
    }
  });

  it("rejects a malformed email", () => {
    expect(validateWaitlistRequest({ email: "not-an-email" }).success).toBe(
      false
    );
  });

  it("rejects a missing email", () => {
    expect(validateWaitlistRequest({}).success).toBe(false);
  });

  it("rejects an over-long email", () => {
    const huge = "x".repeat(250) + "@example.com";
    expect(validateWaitlistRequest({ email: huge }).success).toBe(false);
  });
});
