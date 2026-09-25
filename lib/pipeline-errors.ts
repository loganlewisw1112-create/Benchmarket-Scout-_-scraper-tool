export type PipelineErrorCode =
  | "SOURCE_UNAVAILABLE"
  | "MARKET_NOT_FOUND"
  | "INSUFFICIENT_REAL_DATA"
  | "AMBIGUOUS_MARKET"
  | "INDUSTRY_NOT_RESOLVED"
  | "NO_COMPETITORS_FOUND"
  | "USER_SITE_UNAVAILABLE"
  | "ANALYSIS_TIMEOUT";

export class PipelineError extends Error {
  readonly code: PipelineErrorCode;
  readonly status: 422 | 503 | 504;
  readonly source: string;
  readonly retryable: boolean;

  constructor(args: {
    code: PipelineErrorCode;
    status: 422 | 503 | 504;
    source: string;
    message: string;
    retryable: boolean;
    cause?: unknown;
  }) {
    super(args.message, { cause: args.cause });
    this.name = "PipelineError";
    this.code = args.code;
    this.status = args.status;
    this.source = args.source;
    this.retryable = args.retryable;
  }
}

export class SourceUnavailableError extends PipelineError {
  constructor(source: string, message: string, cause?: unknown) {
    super({
      code: "SOURCE_UNAVAILABLE",
      status: 503,
      source,
      message,
      retryable: true,
      cause,
    });
    this.name = "SourceUnavailableError";
  }
}

export class MarketNotFoundError extends PipelineError {
  constructor(market: string, message?: string) {
    super({
      code: "MARKET_NOT_FOUND",
      status: 422,
      source: "nominatim",
      message: message ?? `No market could be resolved for "${market}".`,
      retryable: false,
    });
    this.name = "MarketNotFoundError";
  }
}

export class AmbiguousMarketError extends PipelineError {
  /** Human-readable labels of the competing places, strongest first. */
  readonly candidates: string[];

  constructor(market: string, candidates: string[]) {
    super({
      code: "AMBIGUOUS_MARKET",
      status: 422,
      source: "nominatim",
      message: `"${market}" matches several places (${candidates
        .slice(0, 3)
        .join("; ")}). Add the state or country so the right one is used.`,
      retryable: false,
    });
    this.name = "AmbiguousMarketError";
    this.candidates = candidates;
  }
}

export class IndustryNotResolvedError extends PipelineError {
  constructor(businessType: string) {
    super({
      code: "INDUSTRY_NOT_RESOLVED",
      status: 422,
      source: "openstreetmap",
      message: `"${businessType}" could not be matched to an OpenStreetMap business category, so competitors cannot be found reliably. Try a more common name for the business type (for example "dentist", "barber" or "escape room").`,
      retryable: false,
    });
    this.name = "IndustryNotResolvedError";
  }
}

export class NoCompetitorsFoundError extends PipelineError {
  constructor(businessType: string, placeLabel: string, radiusKm: number) {
    super({
      code: "NO_COMPETITORS_FOUND",
      status: 422,
      source: "overpass",
      message: `OpenStreetMap lists no named ${businessType} businesses within ${radiusKm} km of ${placeLabel}, so there is nothing to benchmark against. No report was saved.`,
      retryable: false,
    });
    this.name = "NoCompetitorsFoundError";
  }
}

/**
 * User-site audit failures that are usually transient (a slow response, a
 * dropped connection, a bot-protection or rate-limit refusal): the same
 * request can succeed later, so they are retryable. Wrong or blocked
 * addresses, robots.txt refusals and content-empty pages are not.
 */
export const RETRYABLE_USER_SITE_REASONS: ReadonlySet<string> = new Set([
  "timeout",
  "connection_failed",
  "blocked_by_site",
]);

export class UserSiteUnavailableError extends PipelineError {
  /** Coarse reason category, safe to show the user. */
  readonly reason: string;

  constructor(reason: string, message: string) {
    super({
      code: "USER_SITE_UNAVAILABLE",
      status: 422,
      source: "audit",
      message,
      retryable: RETRYABLE_USER_SITE_REASONS.has(reason),
    });
    this.name = "UserSiteUnavailableError";
    this.reason = reason;
  }
}

export class AnalysisTimeoutError extends PipelineError {
  constructor(message = "Analysis could not complete within the request time budget.", cause?: unknown) {
    super({
      code: "ANALYSIS_TIMEOUT",
      status: 504,
      source: "analysis",
      message,
      retryable: true,
      cause,
    });
    this.name = "AnalysisTimeoutError";
  }
}

export class InsufficientRealDataError extends PipelineError {
  constructor(message = "No entity had enough observed data to produce a report.") {
    super({
      code: "INSUFFICIENT_REAL_DATA",
      status: 422,
      source: "analysis",
      message,
      retryable: false,
    });
    this.name = "InsufficientRealDataError";
  }
}

/** Thrown for request-shape problems the route detects before the pipeline. */
export class InvalidRequestError extends Error {
  readonly details?: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.name = "InvalidRequestError";
    this.details = details;
  }
}

export type PipelineErrorClass = {
  status: number;
  code: string;
  retryable: boolean;
  message: string;
};

/**
 * Map any error thrown by the analysis pipeline to the shared API error
 * contract. Unknown errors never leak their message: they become a generic
 * INTERNAL_ERROR so stack details and upstream bodies stay in the logs.
 */
export function classifyPipelineError(err: unknown): PipelineErrorClass {
  if (err instanceof PipelineError) {
    return {
      status: err.status,
      code: err.code,
      retryable: err.retryable,
      message: err.message,
    };
  }
  if (err instanceof InvalidRequestError) {
    return {
      status: 400,
      code: "INVALID_REQUEST",
      retryable: false,
      message: err.message,
    };
  }
  return {
    status: 500,
    code: "INTERNAL_ERROR",
    retryable: false,
    message: "Analysis failed unexpectedly. Please try again.",
  };
}
