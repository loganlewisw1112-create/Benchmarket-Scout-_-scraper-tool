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
    .transform(stripDangerousChars),
  businessUrl: z
    .string()
    .min(3)
    .max(300)
    .transform((v) => v.trim()),
  businessType: z
    .string()
    .min(2)
    .max(80)
    .transform(stripDangerousChars),
  market: z
    .string()
    .min(2)
    .max(120)
    .transform(stripDangerousChars),
  options: z
    .object({
      demoMode: z.enum(["live", "auto", "mock"]).optional(),
    })
    .optional(),
});

export type ValidatedAnalyzeMarketRequest = z.infer<
  typeof analyzeMarketRequestSchema
>;

export function validateAnalyzeMarketRequest(input: unknown) {
  return analyzeMarketRequestSchema.safeParse(input);
}
