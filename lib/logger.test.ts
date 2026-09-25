import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRequestLogger,
  getCurrentRequestId,
  isUserCausedError,
  logger,
  logLevelForError,
  serializeError,
  withRequestId,
} from "./logger";

function lastJsonLine(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  const call = spy.mock.calls.at(-1);
  return JSON.parse(call![0] as string);
}

describe("logger", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("routes info/warn/error to the matching console method as single-line JSON", () => {
    logger.info("hello info");
    logger.warn("hello warn");
    logger.error("hello error");

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);

    const infoLine = lastJsonLine(logSpy);
    expect(infoLine.level).toBe("info");
    expect(infoLine.service).toBe("benchmark-scout");
    expect(infoLine.message).toBe("hello info");
    expect(typeof infoLine.timestamp).toBe("string");
    expect(Number.isNaN(Date.parse(infoLine.timestamp as string))).toBe(false);
  });

  it("includes a context object only when fields are passed", () => {
    logger.info("no fields");
    expect(lastJsonLine(logSpy).context).toBeUndefined();

    logger.info("with fields", { a: 1, b: "two" });
    expect(lastJsonLine(logSpy).context).toEqual({ a: 1, b: "two" });
  });

  it("omits requestId when called outside any withRequestId scope", () => {
    logger.info("no scope");
    expect(lastJsonLine(logSpy).requestId).toBeUndefined();
    expect(getCurrentRequestId()).toBeUndefined();
  });

  it("attaches the current requestId within a withRequestId scope", () => {
    withRequestId("req-123", () => {
      logger.info("scoped");
      expect(getCurrentRequestId()).toBe("req-123");
    });

    expect(lastJsonLine(logSpy).requestId).toBe("req-123");
    // Scope does not leak after the callback returns.
    expect(getCurrentRequestId()).toBeUndefined();
  });

  it("propagates the requestId through nested async/await chains", async () => {
    async function inner() {
      await Promise.resolve();
      logger.info("inner call");
      return getCurrentRequestId();
    }

    const result = await withRequestId("req-async", async () => {
      await Promise.resolve();
      return inner();
    });

    expect(result).toBe("req-async");
    expect(lastJsonLine(logSpy).requestId).toBe("req-async");
  });

  it("keeps concurrent Promise.all branches correctly scoped to the same request", async () => {
    await withRequestId("req-fanout", async () => {
      await Promise.all([
        (async () => {
          await new Promise((r) => setTimeout(r, 5));
          logger.info("branch a");
        })(),
        (async () => {
          logger.info("branch b");
        })(),
      ]);
    });

    const calls: Array<Record<string, unknown>> = logSpy.mock.calls.map(
      (c: unknown[]) => JSON.parse(c[0] as string)
    );
    const scoped = calls.filter(
      (c) =>
        typeof c.message === "string" &&
        ["branch a", "branch b"].includes(c.message)
    );
    expect(scoped).toHaveLength(2);
    expect(scoped.every((c) => c.requestId === "req-fanout")).toBe(true);
  });

  it("isolates separate withRequestId scopes from each other", async () => {
    const ids: (string | undefined)[] = [];

    await Promise.all([
      withRequestId("req-a", async () => {
        await new Promise((r) => setTimeout(r, 5));
        ids.push(getCurrentRequestId());
      }),
      withRequestId("req-b", async () => {
        ids.push(getCurrentRequestId());
      }),
    ]);

    expect(ids.sort()).toEqual(["req-a", "req-b"]);
  });

  it("createRequestLogger always includes its bound id, even outside ALS scope", () => {
    const bound = createRequestLogger("req-bound");
    bound.error("bound error");

    const line = lastJsonLine(errorSpy);
    expect(line.requestId).toBe("req-bound");
    // Confirms it works with no ambient scope active.
    expect(getCurrentRequestId()).toBeUndefined();
  });
});

describe("serializeError", () => {
  it("extracts message, name, and stack from an Error", () => {
    const err = new Error("boom");
    const result = serializeError(err);
    expect(result.errorMessage).toBe("boom");
    expect(result.errorName).toBe("Error");
    expect(result.stack).toContain("boom");
    expect(result.digest).toBeUndefined();
  });

  it("captures a digest property when present on an Error", () => {
    const err = new Error("boom") as Error & { digest?: string };
    err.digest = "abc123";
    expect(serializeError(err).digest).toBe("abc123");
  });

  it("handles non-Error thrown values", () => {
    expect(serializeError("just a string").errorMessage).toBe("just a string");
    expect(serializeError(42).errorMessage).toBe("42");
    expect(serializeError(null).errorMessage).toBe("null");
  });

  it("captures a digest property on a non-Error object", () => {
    const result = serializeError({ digest: "xyz789", other: "field" });
    expect(result.digest).toBe("xyz789");
  });
});

describe("serializeError typed fields and cause chain", () => {
  class FakePipelineError extends Error {
    readonly code = "SOURCE_UNAVAILABLE";
    readonly status = 503;
    readonly source = "overpass";
    readonly retryable = true;
  }

  it("copies pipeline code/status/source/retryable and the cause chain", () => {
    const root = Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" });
    const middle = new Error("fetch failed", { cause: root });
    const err = new FakePipelineError("Competitor discovery is temporarily unavailable.", {
      cause: middle,
    });
    expect(serializeError(err)).toMatchObject({
      errorMessage: "Competitor discovery is temporarily unavailable.",
      code: "SOURCE_UNAVAILABLE",
      status: 503,
      source: "overpass",
      retryable: true,
      cause: {
        errorMessage: "fetch failed",
        errorName: "Error",
        cause: { errorMessage: "connect ETIMEDOUT", code: "ETIMEDOUT" },
      },
    });
  });

  it("limits the cause chain to depth 3 and omits cause stacks", () => {
    let err: Error = new Error("level 5");
    for (let level = 4; level >= 0; level--) {
      err = new Error(`level ${level}`, { cause: err });
    }
    const result = serializeError(err);
    expect(result.cause?.errorMessage).toBe("level 1");
    expect(result.cause?.cause?.errorMessage).toBe("level 2");
    expect(result.cause?.cause?.cause?.errorMessage).toBe("level 3");
    expect(result.cause?.cause?.cause?.cause).toBeUndefined();
    expect(JSON.stringify(result.cause)).not.toContain("stack");
  });

  it("redacts email addresses from messages, stacks, and causes", () => {
    const err = new Error("Signup failed for jane.doe@example.com", {
      cause: new Error("duplicate jane.doe@example.com"),
    });
    const json = JSON.stringify(serializeError(err));
    expect(json).not.toContain("jane.doe@example.com");
    expect(json).toContain("[redacted-email]");
  });

  it("does not copy arbitrary own properties", () => {
    const err = Object.assign(new Error("x"), { email: "a@b.co", body: "secret" });
    const json = JSON.stringify(serializeError(err));
    expect(json).not.toContain("secret");
    expect(json).not.toContain("a@b.co");
  });
});

describe("logLevelForError", () => {
  it("logs user-caused failures at warn", () => {
    expect(logLevelForError(Object.assign(new Error("x"), { code: "MARKET_NOT_FOUND", status: 422 }))).toBe("warn");
    expect(logLevelForError(Object.assign(new Error("x"), { status: 400 }))).toBe("warn");
    expect(logLevelForError(Object.assign(new Error("x"), { name: "ZodError" }))).toBe("warn");
    expect(isUserCausedError({ code: "INVALID_REQUEST" })).toBe(true);
  });

  it("keeps faults and upstream outages at error", () => {
    expect(logLevelForError(new Error("boom"))).toBe("error");
    expect(logLevelForError(Object.assign(new Error("x"), { code: "SOURCE_UNAVAILABLE", status: 503 }))).toBe("error");
    expect(logLevelForError("string")).toBe("error");
    expect(logLevelForError(null)).toBe("error");
  });
});
