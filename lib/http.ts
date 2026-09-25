import { NextResponse } from "next/server";
import { REQUEST_ID_HEADER, requestIdFrom } from "./request-id";

// Shared answers for HTTP methods a route does not implement. Next's built-in
// 405 has no body and no Allow header, and its automatic OPTIONS lists every
// exported handler (including these 405 ones) as allowed. Routes export the
// handlers from methodHandlers() for every method they do not serve, so every
// API route answers 405s with the shared JSON error shape and an accurate
// Allow header.

type Handler = (request: Request) => Response;

export function methodHandlers(allowedMethods: string): {
  OPTIONS: Handler;
  methodNotAllowed: Handler;
} {
  return {
    OPTIONS(request) {
      return new NextResponse(null, {
        status: 204,
        headers: {
          Allow: allowedMethods,
          [REQUEST_ID_HEADER]: requestIdFrom(request),
        },
      });
    },
    methodNotAllowed(request) {
      return NextResponse.json(
        {
          code: "METHOD_NOT_ALLOWED",
          error: `This endpoint only supports ${allowedMethods}.`,
        },
        {
          status: 405,
          headers: {
            Allow: allowedMethods,
            [REQUEST_ID_HEADER]: requestIdFrom(request),
          },
        }
      );
    },
  };
}
