/** A predictable AbortError without a DOMException dependency in React Native. */
export function abortError(): Error {
  const error = new Error('Mesh operation aborted');
  error.name = 'AbortError';
  return error;
}

/** Bound an operation even when a native bridge ignores cancellation or never
 * settles. Late rejections remain observed, and no timer/listener is retained
 * after success, failure, cancellation, or the deadline.
 */
export function runBounded<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  signals: readonly AbortSignal[],
  timeoutMs: number,
): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 0x7fffffff) {
    return handledRejection(new RangeError('timeoutMs must be a positive 32-bit timer duration'));
  }
  const controller = new AbortController();
  const parents = [...new Set(signals)];
  const result = new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      for (const signal of parents) signal.removeEventListener('abort', onAbort);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      // Settle first: a native abort listener may synchronously throw or reject.
      reject(error);
      controller.abort();
    };
    const onAbort = (): void => fail(abortError());
    for (const signal of parents) {
      if (signal.aborted) { fail(abortError()); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    timer = setTimeout(() => {
      const error = new Error('Mesh operation timed out');
      error.name = 'TimeoutError';
      fail(error);
    }, timeoutMs);
    try {
      Promise.resolve(operation(controller.signal)).then(value => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      }, fail);
    } catch (error) { fail(error); }
  });
  // The caller still receives the original rejection. This side handler also
  // protects fire-and-forget lifecycle work until its owner attaches a handler.
  void result.catch(() => undefined);
  return result;
}

export function handledRejection<T = never>(error: unknown): Promise<T> {
  const promise = Promise.reject<T>(error);
  void promise.catch(() => undefined);
  return promise;
}
