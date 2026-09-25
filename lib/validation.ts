import { z } from "zod";

// Output is JSON-encoded and React-escaped, and every upstream query encodes
// its parameters, so only markup delimiters and control characters are
// removed. Apostrophes and quotes stay: "Al's Barbershop" and "O'Fallon, MO"
// are real names, and stripping them broke self-exclusion and news matching.
const unsafeCharsRegex = /[<>`{}\u0000-\u001f\u007f]/g;

function sanitizeText(value: string): string {
  return value.replace(unsafeCharsRegex, "").replace(/\s+/g, " ").trim();
}

// "City, ST" or "City, Country": a bare city name ("Portland", "Springfield")
// silently resolves to one arbitrary place, so a region is required.
const MARKET_REGION_MESSAGE =
  'Include the city and its state or country, for example "Alameda, CA" or "Leeds, UK".';

function hasPlaceAndRegion(market: string): boolean {
  const parts = market.split(",").map((part) => part.trim());
  return (
    parts.length >= 2 &&
    parts[0].length >= 2 &&
    parts.slice(1).some((part) => part.length >= 2)
  );
}

export const analyzeMarketRequestSchema = z.object({
  businessName: z
    .string()
    .min(2)
    .max(80)
    .transform(sanitizeText)
    .pipe(z.string().min(2)),
  businessUrl: z
    .string()
    .max(300)
    .transform((v) => v.trim())
    .pipe(z.url().refine((url) => /^https?:\/\//i.test(url), "Use an HTTP(S) URL")),
  businessType: z
    .string()
    .min(2)
    .max(80)
    .transform(sanitizeText)
    .pipe(z.string().min(2)),
  market: z
    .string()
    .min(2)
    .max(120)
    .transform(sanitizeText)
    .pipe(z.string().min(2).refine(hasPlaceAndRegion, MARKET_REGION_MESSAGE)),
}).strict();

export type ValidatedAnalyzeMarketRequest = z.infer<
  typeof analyzeMarketRequestSchema
>;

export function validateAnalyzeMarketRequest(input: unknown) {
  return analyzeMarketRequestSchema.safeParse(input);
}

/**
 * The 400 `details` payload: per-field errors plus form-level errors such as
 * unrecognized keys, which `fieldErrors` alone silently drops.
 */
export function validationErrorDetails(error: z.ZodError): {
  fieldErrors: Record<string, string[] | undefined>;
  formErrors: string[];
} {
  const flat = z.flattenError(error);
  return {
    fieldErrors: flat.fieldErrors as Record<string, string[] | undefined>,
    formErrors: flat.formErrors,
  };
}

/**
 * The `error` text for a 400: the first rule-specific message (e.g. the
 * market's "Include the city and its state or country" guidance), which the
 * UI shows as-is, or a generic line when only type/length checks failed.
 */
export function validationErrorMessage(error: z.ZodError): string {
  const specific = error.issues.find((issue) => issue.code === "custom");
  return specific?.message ?? "Invalid input.";
}
