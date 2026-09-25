import { NextResponse, type NextRequest } from "next/server";
import { newRequestId, REQUEST_ID_HEADER } from "./lib/request-id";

// Next 16 Proxy (formerly middleware), scoped to /api. It gives every API
// response an x-request-id: a fresh id is minted here (any client-supplied
// value is replaced, since the proxy is the trust boundary), forwarded to the
// route as a request header, and set on the response. That covers framework
// responses (automatic 405s, unhandled 500s) as well as route responses.
//
// Routes that log under withRequestId() adopt the forwarded id with
// requestIdFrom(request), so their log lines and any x-request-id they set
// themselves carry the same value. Next keeps the first x-request-id written
// to a response (the proxy's), so the two never disagree or duplicate.

export function proxy(request: NextRequest) {
  const requestId = newRequestId();
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(REQUEST_ID_HEADER, requestId);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set(REQUEST_ID_HEADER, requestId);
  return response;
}

export const config = {
  matcher: "/api/:path*",
};
