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

export type SerializedErrorCause = {
  errorMessage: string;
  errorName?: string;
  code?: string;
  cause?: SerializedErrorCause;
};

export type SerializedError = {
  errorMessage: string;
  errorName?: string;
  stack?: string;
  digest?: string;
  // Typed pipeline errors (lib/pipeline-errors.ts) carry these; copied only
  // when they are primitives of the expected type.
  code?: string;
  status?: number;
  source?: string;
  retryable?: boolean;
  // err.cause chain, depth-limited. Causes carry no stack (the top-level
  // stack already locates the throw site) to keep log lines bounded.
  cause?: SerializedErrorCause;
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

// Upstream error messages can echo user input (a typed market, a submitted
// URL, a waitlist email). Emails are the only PII shape this app handles, so
// they are redacted from every serialized message and stack.
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const MAX_CAUSE_DEPTH = 3;

function redact(value: string): string {
  return value.replace(EMAIL_PATTERN, "[redacted-email]");
}

function stringProperty(err: object, key: string): string | undefined {
  const value = (err as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function typedErrorFields(err: object): Pick<
  SerializedError,
  "code" | "status" | "source" | "retryable"
> {
  const record = err as Record<string, unknown>;
  const code = stringProperty(err, "code");
  const status =
    typeof record.status === "number" && Number.isInteger(record.status)
      ? record.status
      : undefined;
  const source = stringProperty(err, "source");
  const retryable =
    typeof record.retryable === "boolean" ? record.retryable : undefined;
  return {
    ...(code !== undefined ? { code } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(source !== undefined ? { source } : {}),
    ...(retryable !== undefined ? { retryable } : {}),
  };
}

function serializeCause(
  cause: unknown,
  depth: number
): SerializedErrorCause | undefined {
  if (cause === undefined || cause === null || depth > MAX_CAUSE_DEPTH) {
    return undefined;
  }
  if (cause instanceof Error) {
    const code = stringProperty(cause, "code");
    const next = serializeCause(cause.cause, depth + 1);
    return {
      errorMessage: redact(cause.message),
      errorName: cause.name,
      ...(code !== undefined ? { code } : {}),
      ...(next ? { cause: next } : {}),
    };
  }
  return { errorMessage: redact(String(cause)) };
}

export function serializeError(err: unknown): SerializedError {
  if (err instanceof Error) {
    const digest = stringProperty(err, "digest");
    const cause = serializeCause(err.cause, 1);
    return {
      errorMessage: redact(err.message),
      errorName: err.name,
      stack: err.stack === undefined ? undefined : redact(err.stack),
      ...(digest ? { digest } : {}),
      ...typedErrorFields(err),
      ...(cause ? { cause } : {}),
    };
  }

  if (typeof err === "object" && err !== null) {
    const digest = stringProperty(err, "digest");
    return { errorMessage: redact(String(err)), ...(digest ? { digest } : {}) };
  }

  return { errorMessage: redact(String(err)) };
}

// Pipeline codes that describe the caller's input rather than a fault in this
// service or its upstreams (contract: lib/pipeline-errors.ts).
const USER_CAUSED_CODES = new Set([
  "INVALID_REQUEST",
  "AMBIGUOUS_MARKET",
  "MARKET_NOT_FOUND",
  "INDUSTRY_NOT_RESOLVED",
  "NO_COMPETITORS_FOUND",
  "USER_SITE_UNAVAILABLE",
  "INSUFFICIENT_REAL_DATA",
]);

// True for validation failures, unresolvable markets, and any error carrying a
// 4xx status. Those are logged at warn so error-level lines mean a real fault.
export function isUserCausedError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const record = err as Record<string, unknown>;
  if (typeof record.code === "string" && USER_CAUSED_CODES.has(record.code)) {
    return true;
  }
  const status = record.status ?? record.statusCode;
  if (typeof status === "number" && status >= 400 && status < 500) return true;
  return record.name === "ZodError";
}

export function logLevelForError(err: unknown): "warn" | "error" {
  return isUserCausedError(err) ? "warn" : "error";
}
