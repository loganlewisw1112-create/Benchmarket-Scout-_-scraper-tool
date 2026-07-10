import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRequestLogger,
  getCurrentRequestId,
  logger,
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
