import type { RadioEvent, RadioLink, RadioStatus } from '../../domain/types';

export const MAX_RADIO_CHUNK_BYTES = 8192;
export const MAX_RADIO_ID_LENGTH = 256;

export function isRadioId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_RADIO_ID_LENGTH && value.trim() === value;
}

export function isRadioLink(value: unknown): value is RadioLink {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<RadioLink>;
  return isRadioId(v.id) && isRadioId(v.endpointId) && typeof v.maxChunkBytes === 'number'
    && Number.isInteger(v.maxChunkBytes) && v.maxChunkBytes > 0 && v.maxChunkBytes <= MAX_RADIO_CHUNK_BYTES;
}

export function isRadioStatus(value: unknown): value is RadioStatus {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<RadioStatus>;
  return typeof v.available === 'boolean' && (v.reason === undefined
    || ['unsupported', 'permission-denied', 'powered-off', 'unavailable'].includes(v.reason));
}

export function abortError(message = 'Radio operation aborted'): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

export function ignoreFailure(action: () => unknown): void {
  try { void Promise.resolve(action()).catch(() => undefined); } catch { /* Best-effort native teardown. */ }
}

export class RadioEvents {
  private readonly listeners = new Set<(event: RadioEvent) => void>();
  subscribe(listener: (event: RadioEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  emit(event: RadioEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* One subscriber cannot break native cleanup. */ }
    }
  }
}

/** Native cancellation is best effort. The JS promise must settle even when a
 * permission prompt, OS Bluetooth stack, or bridge never resolves its promise. */
export class RadioOperations {
  private sequence = 0;
  private readonly pending = new Map<string, { fail(error: Error): void; owner?: string }>();
  constructor(private readonly prefix: string, private readonly timeoutMs: number) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error('Invalid radio operation timeout');
  }

  run<T>(signal: AbortSignal | undefined, work: (id: string, isActive: () => boolean) => Promise<T>, cancel: (id: string) => void,
    onLate?: (value: T) => void, owner?: string): Promise<T> {
    if (signal?.aborted) return Promise.reject(abortError());
    const id = `${this.prefix}-${++this.sequence}`;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.pending.delete(id);
      };
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        ignoreFailure(() => cancel(id));
        reject(error);
      };
      const onAbort = (): void => fail(abortError());
      this.pending.set(id, { fail, ...(owner === undefined ? {} : { owner }) });
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => fail(new Error('Radio operation timed out')), this.timeoutMs);
      Promise.resolve().then(() => {
        if (settled) throw abortError();
        return work(id, () => !settled);
      }).then(value => {
        if (settled) { if (onLate) ignoreFailure(() => onLate(value)); return; }
        settled = true;
        cleanup();
        resolve(value);
      }, error => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      });
    });
  }

  cancelOwner(owner: string): void {
    for (const operation of [...this.pending.values()]) {
      if (operation.owner === owner) operation.fail(abortError('Radio link closed'));
    }
  }

  cancelAll(): void {
    for (const operation of [...this.pending.values()]) operation.fail(abortError('Radio stopped'));
  }
}

/** One bounded FIFO per physical link prevents concurrent callers from
 * interleaving chunks or exceeding the native stack's write backlog. */
export class OrderedRadioWrites {
  private readonly queues = new Map<string, { tail: Promise<unknown>; count: number }>();
  run<T>(linkId: string, work: () => Promise<T>): Promise<T> {
    let queue = this.queues.get(linkId);
    if (!queue) { queue = { tail: Promise.resolve(), count: 0 }; this.queues.set(linkId, queue); }
    if (queue.count >= 64) return Promise.reject(new Error('Radio write queue is full'));
    ++queue.count;
    const result = queue.tail.catch(() => undefined).then(work);
    const current = queue;
    queue.tail = result.finally(() => {
      if (--current.count === 0 && this.queues.get(linkId) === current) this.queues.delete(linkId);
    });
    // The caller owns result's rejection. The queue must also absorb it.
    void queue.tail.catch(() => undefined);
    return result;
  }
}
