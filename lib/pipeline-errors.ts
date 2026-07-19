export type PipelineErrorCode =
  | "SOURCE_UNAVAILABLE"
  | "MARKET_NOT_FOUND"
  | "INSUFFICIENT_REAL_DATA";

export class PipelineError extends Error {
  readonly code: PipelineErrorCode;
  readonly status: 422 | 503;
  readonly source: string;
  readonly retryable: boolean;

  constructor(args: {
    code: PipelineErrorCode;
    status: 422 | 503;
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
  constructor(market: string) {
    super({
      code: "MARKET_NOT_FOUND",
      status: 422,
      source: "nominatim",
      message: `No market could be resolved for "${market}".`,
      retryable: false,
    });
    this.name = "MarketNotFoundError";
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
