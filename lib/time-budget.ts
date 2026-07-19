export type RequestBudgetOptions = {
  signal?: AbortSignal;
  budgetMs?: number;
};

export type TimedSignal = {
  signal: AbortSignal;
  timedOut: () => boolean;
  cleanup: () => void;
};

export function createTimedSignal(
  parentSignal: AbortSignal | undefined,
  timeoutMs: number
): TimedSignal {
  const controller = new AbortController();
  let didTimeOut = false;
  const abortFromParent = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  const timeout = setTimeout(() => {
    didTimeOut = true;
    controller.abort(new Error("Operation time budget exhausted"));
  }, Math.max(1, timeoutMs));
  return {
    signal: controller.signal,
    timedOut: () => didTimeOut,
    cleanup: () => {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", abortFromParent);
    },
  };
}

export async function abortable<T>(
  operation: Promise<T>,
  signal: AbortSignal
): Promise<T> {
  if (signal.aborted) throw signal.reason ?? new Error("Operation aborted");
  let rejectAbort!: (reason?: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () =>
    rejectAbort(signal.reason ?? new Error("Operation aborted"));
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export async function abortableDelay(
  delayMs: number,
  signal?: AbortSignal
): Promise<void> {
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return;
  }
  const timed = createTimedSignal(signal, delayMs);
  try {
    await abortable(
      new Promise<void>((resolve) => setTimeout(resolve, delayMs)),
      timed.signal
    );
  } catch {
    // Both the delay timer and parent cancellation end the backoff.
  } finally {
    timed.cleanup();
  }
}

export function remainingBudgetMs(deadlineAt: number): number {
  return Math.max(0, deadlineAt - Date.now());
}
