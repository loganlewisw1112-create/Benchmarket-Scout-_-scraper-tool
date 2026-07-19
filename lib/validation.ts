import { z } from "zod";

const dangerousCharsRegex = /[<>"'`;{}$]/g;

function stripDangerousChars(value: string): string {
  return value.replace(dangerousCharsRegex, "").trim();
}

export const analyzeMarketRequestSchema = z.object({
  businessName: z
    .string()
    .min(2)
    .max(80)
    .transform(stripDangerousChars)
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
    .transform(stripDangerousChars)
    .pipe(z.string().min(2)),
  market: z
    .string()
    .min(2)
    .max(120)
    .transform(stripDangerousChars)
    .pipe(z.string().min(2)),
}).strict();

export type ValidatedAnalyzeMarketRequest = z.infer<
  typeof analyzeMarketRequestSchema
>;

export function validateAnalyzeMarketRequest(input: unknown) {
  return analyzeMarketRequestSchema.safeParse(input);
}
