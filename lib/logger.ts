import { AsyncLocalStorage } from "node:async_hooks";

// Provider-agnostic structured logging: single-line JSON on console.*
// (grep/ingest-friendly, zero new dependencies), with per-request
// correlation via AsyncLocalStorage so every call site under a request's
// withRequestId() scope automatically carries that request's id — no
// logger parameter threading through lib/geocode.ts, lib/discover.ts,
// lib/audit.ts, lib/gdelt.ts, etc.

export type LogLevel = "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

export interface Logger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export type SerializedError = {
  errorMessage: string;
  errorName?: string;
  stack?: string;
  digest?: string;
};

const SERVICE = "benchmark-scout";

const requestContext = new AsyncLocalStorage<{ requestId: string }>();

function write(level: LogLevel, message: string, fields?: LogFields): void {
  const requestId = requestContext.getStore()?.requestId;
  const line = {
    timestamp: new Date().toISOString(),
    level,
    service: SERVICE,
    message,
    ...(requestId ? { requestId } : {}),
    ...(fields ? { context: fields } : {}),
  };

  const json = JSON.stringify(line);
  if (level === "error") console.error(json);
  else if (level === "warn") console.warn(json);
  else console.log(json);
}

export const logger: Logger = {
  info: (message, fields) => write("info", message, fields),
  warn: (message, fields) => write("warn", message, fields),
  error: (message, fields) => write("error", message, fields),
};

export function withRequestId<T>(requestId: string, fn: () => T): T {
  return requestContext.run({ requestId }, fn);
}

export function getCurrentRequestId(): string | undefined {
  return requestContext.getStore()?.requestId;
}

// Explicit-binding escape hatch for contexts outside a guaranteed ALS
// scope (e.g. instrumentation.ts's onRequestError, which Next can invoke
// for errors that never entered a withRequestId() scope).
export function createRequestLogger(requestId: string): Logger {
  return {
    info: (message, fields) => withRequestId(requestId, () => write("info", message, fields)),
    warn: (message, fields) => withRequestId(requestId, () => write("warn", message, fields)),
    error: (message, fields) => withRequestId(requestId, () => write("error", message, fields)),
  };
}

export function serializeError(err: unknown): SerializedError {
  if (err instanceof Error) {
    const digest =
      "digest" in err && typeof (err as { digest?: unknown }).digest === "string"
        ? (err as { digest: string }).digest
        : undefined;
    return {
      errorMessage: err.message,
      errorName: err.name,
      stack: err.stack,
      ...(digest ? { digest } : {}),
    };
  }

  if (typeof err === "object" && err !== null) {
    const digest =
      "digest" in err && typeof (err as { digest?: unknown }).digest === "string"
        ? (err as { digest: string }).digest
        : undefined;
    return { errorMessage: String(err), ...(digest ? { digest } : {}) };
  }

  return { errorMessage: String(err) };
}
