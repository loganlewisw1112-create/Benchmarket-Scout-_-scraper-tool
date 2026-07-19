export function isMaintenanceMode(): boolean {
  return process.env.MAINTENANCE_MODE?.trim().toLowerCase() === "true";
}

export const MAINTENANCE_RESPONSE = {
  error: "Benchmark Scout is temporarily in maintenance while we upgrade every report to verified real-world sources.",
  code: "MAINTENANCE",
} as const;

