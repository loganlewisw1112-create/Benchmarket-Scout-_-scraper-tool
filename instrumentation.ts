import type { Instrumentation } from "next";

// Next.js instrumentation hooks (stable since v15): register() runs once per
// server instance; onRequestError() is called by Next itself for any server
// error it captures (Server Components, Route Handlers, Server Actions) —
// a safety net for errors that never reach a route's own try/catch.
//
// Both guard on the edge runtime and use dynamic import so lib/logger.ts
// (whose AsyncLocalStorage needs node:async_hooks) is never evaluated under
// a hypothetical future edge route. This app pins runtime = "nodejs" today.

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "edge") return;
  const { logServerStart } = await import("./lib/instrumentation-node");
  logServerStart();
}

export const onRequestError: Instrumentation.onRequestError = async (
  error,
  request,
  context
) => {
  if (process.env.NEXT_RUNTIME === "edge") return;
  const { createRequestLogger, getCurrentRequestId, serializeError } =
    await import("./lib/logger");

  // Reuse the request's correlation id when the error surfaced inside a
  // withRequestId() scope; otherwise mint one so the line is still traceable.
  const requestId = getCurrentRequestId() ?? crypto.randomUUID();

  createRequestLogger(requestId).error(
    "unhandled server error captured by Next.js",
    {
      path: request.path,
      method: request.method,
      routerKind: context.routerKind,
      routePath: context.routePath,
      routeType: context.routeType,
      ...serializeError(error),
    }
  );
};
