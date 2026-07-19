import { z } from "zod";

// Kept intentionally small: we validate shape and length, normalize case, and
// let the store dedupe. We do not attempt deliverability checks here.
export const waitlistRequestSchema = z.object({
  email: z
    .string()
    .trim()
    .min(5)
    .max(254)
    .email()
    .transform((v) => v.toLowerCase()),
  // Optional context so we know which report drove a signup, without storing
  // anything sensitive. Length-capped to avoid abuse.
  source: z.string().trim().max(80).optional(),
  reportId: z.string().trim().max(64).optional(),
  message: z.string().trim().max(1_000).optional(),
});

export type ValidatedWaitlistRequest = z.infer<typeof waitlistRequestSchema>;

export function validateWaitlistRequest(input: unknown) {
  return waitlistRequestSchema.safeParse(input);
}
