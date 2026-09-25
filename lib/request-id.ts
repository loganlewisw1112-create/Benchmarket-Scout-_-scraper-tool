// Request correlation ids for API responses (x-request-id).
//
// proxy.ts mints one per /api request and forwards it to the route as the
// `x-request-id` request header. Routes that log under withRequestId() should
// take their id from requestIdFrom(request) so the response header and the
// log lines carry the same value. Outside the proxy (tests, a route the
// matcher skips) requestIdFrom mints a fresh id instead.
//
// Deliberately dependency-free so the proxy bundle stays small.

export const REQUEST_ID_HEADER = "x-request-id";

// UUIDs and similar opaque tokens only: no whitespace or control characters
// can reach a log line or a response header through this value.
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

export function isValidRequestId(value: string | null | undefined): value is string {
  return typeof value === "string" && REQUEST_ID_PATTERN.test(value);
}

export function newRequestId(): string {
  return crypto.randomUUID();
}

export function requestIdFrom(source: Request | Pick<Headers, "get">): string {
  const headers = "headers" in source ? source.headers : source;
  const existing = headers.get(REQUEST_ID_HEADER);
  return isValidRequestId(existing) ? existing : newRequestId();
}
