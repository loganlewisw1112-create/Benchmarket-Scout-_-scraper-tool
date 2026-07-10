import { logger } from "./logger";

// Node-runtime half of instrumentation.ts's register(), split out so the
// direct process.pid reference lives behind the dynamic-import boundary —
// Turbopack statically checks instrumentation.ts itself for Edge Runtime
// compatibility and would flag Node-only APIs there.
export function logServerStart(): void {
  logger.info("server instance starting", {
    pid: process.pid,
    nodeEnv: process.env.NODE_ENV,
  });
}
