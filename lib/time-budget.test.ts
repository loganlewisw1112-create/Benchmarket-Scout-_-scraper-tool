import { afterEach, describe, expect, it, vi } from "vitest";
import { abortable, createTimedSignal } from "./time-budget";

describe("time budget helpers", () => {
  afterEach(() => vi.useRealTimers());

  it("aborts at the explicit operation deadline", async () => {
    vi.useFakeTimers();
    const timed = createTimedSignal(undefined, 100);
    const pending = abortable(new Promise<never>(() => {}), timed.signal);
    const rejection = expect(pending).rejects.toThrow(/time budget exhausted/i);

    await vi.advanceTimersByTimeAsync(100);

    await rejection;
    expect(timed.timedOut()).toBe(true);
    timed.cleanup();
  });

  it("propagates parent cancellation before the local timeout", () => {
    const parent = new AbortController();
    const timed = createTimedSignal(parent.signal, 1_000);
    parent.abort(new Error("parent deadline"));

    expect(timed.signal.aborted).toBe(true);
    expect(timed.signal.reason).toMatchObject({ message: "parent deadline" });
    expect(timed.timedOut()).toBe(false);
    timed.cleanup();
  });
});
