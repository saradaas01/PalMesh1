import type { RadioAdapter } from '../domain/ports';
import type { RadioLink, WireFrame } from '../domain/types';
import { DEFAULT_MAX_CHUNK_BYTES, encodeFrame } from '../domain/wire';
import { abortError, handledRejection, runBounded } from './async';

export class FrameQueueFullError extends Error {
  public constructor() {
    super('Frame writer queue capacity reached');
    this.name = 'FrameQueueFullError';
  }
}

export interface FrameWriterOptions {
  readonly radio: RadioAdapter;
  readonly link: RadioLink;
  readonly signal: AbortSignal;
  readonly writeTimeoutMs: number;
  readonly maxFrameBytes: number;
  readonly maxQueuedFrames: number;
  readonly reservedControlFrames: number;
  readonly onFailure: (error: unknown) => void;
}

interface QueuedFrame {
  readonly bytes: Uint8Array;
  readonly control: boolean;
  readonly signal: AbortSignal | undefined;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  onAbort: (() => void) | undefined;
  settled: boolean;
}

/** A length-prefixed byte stream cannot recover after a partially written
 * frame. Failure or cancellation of an active frame permanently closes this
 * writer; its owner must disconnect the link and perform a fresh handshake.
 */
export class FrameWriter {
  private readonly queue: QueuedFrame[] = [];
  private readonly shutdown = new AbortController();
  private current: QueuedFrame | undefined;
  private closed = false;
  private closeError: unknown = new Error('Frame writer is closed');
  private readonly onParentAbort: () => void;

  public constructor(private readonly options: FrameWriterOptions) {
    integerInRange(options.writeTimeoutMs, 1, 0x7fffffff, 'writeTimeoutMs');
    integerInRange(options.maxFrameBytes, 1, 0xffffffff, 'maxFrameBytes');
    integerInRange(options.maxQueuedFrames, 1, 256, 'maxQueuedFrames');
    integerInRange(options.reservedControlFrames, 0, options.maxQueuedFrames, 'reservedControlFrames');
    integerInRange(options.link.maxChunkBytes, 1, DEFAULT_MAX_CHUNK_BYTES, 'maxChunkBytes');
    this.onParentAbort = () => this.fail(abortError());
    if (options.signal.aborted) {
      this.closed = true;
      this.closeError = abortError();
      this.shutdown.abort();
    } else options.signal.addEventListener('abort', this.onParentAbort, { once: true });
  }

  public send(frame: WireFrame, control: boolean, signal?: AbortSignal): Promise<void> {
    if (this.closed) return handledRejection(this.closeError);
    if (signal?.aborted) return handledRejection(abortError());
    const outstanding = this.queue.length + (this.current ? 1 : 0);
    const ceiling = control ? this.options.maxQueuedFrames
      : this.options.maxQueuedFrames - this.options.reservedControlFrames;
    if (outstanding >= ceiling) return handledRejection(new FrameQueueFullError());
    let bytes: Uint8Array;
    try { bytes = encodeFrame(frame, this.options.maxFrameBytes); }
    catch (error) { return handledRejection(error); }
    const result = new Promise<void>((resolve, reject) => {
      const entry: QueuedFrame = { bytes, control, signal, resolve, reject, onAbort: undefined, settled: false };
      if (signal) {
        entry.onAbort = () => {
          if (entry.settled) return;
          if (this.current === entry) { this.fail(abortError()); return; }
          const index = this.queue.indexOf(entry);
          if (index >= 0) this.queue.splice(index, 1);
          this.settle(entry, true, abortError());
        };
        signal.addEventListener('abort', entry.onAbort, { once: true });
      }
      this.queue.push(entry);
      this.startNext();
    });
    void result.catch(() => undefined);
    return result;
  }

  /** Explicit teardown rejects outstanding work without reporting a second
   * failure to the owner. All underlying writes receive an aborted signal.
   */
  public close(error: unknown = new Error('Frame writer is closed')): void {
    if (this.closed) return;
    this.closed = true;
    this.closeError = error;
    this.options.signal.removeEventListener('abort', this.onParentAbort);
    if (this.current) this.settle(this.current, true, error);
    this.current = undefined;
    for (const entry of this.queue.splice(0)) this.settle(entry, true, error);
    this.shutdown.abort();
  }

  private startNext(): void {
    if (this.closed || this.current) return;
    const controlIndex = this.queue.findIndex(entry => entry.control);
    const entry = this.queue.splice(controlIndex >= 0 ? controlIndex : 0, 1)[0];
    if (!entry) return;
    this.current = entry;
    // runBounded applies one deadline to the entire frame, rather than allowing
    // every BLE chunk to restart a timer and keep a stalled frame alive forever.
    void runBounded(async operationSignal => {
      for (let offset = 0; offset < entry.bytes.length; offset += this.options.link.maxChunkBytes) {
        if (operationSignal.aborted) throw abortError();
        await this.options.radio.write(this.options.link.id,
          entry.bytes.subarray(offset, offset + this.options.link.maxChunkBytes), operationSignal);
      }
    }, [this.shutdown.signal, ...(entry.signal ? [entry.signal] : [])], this.options.writeTimeoutMs)
      .then(() => {
        if (this.current === entry) this.current = undefined;
        this.settle(entry, false);
        this.startNext();
      }, error => this.fail(error)).catch(() => undefined);
  }

  private settle(entry: QueuedFrame, failed: boolean, error?: unknown): void {
    if (entry.settled) return;
    entry.settled = true;
    if (entry.signal && entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort);
    if (failed) entry.reject(error);
    else entry.resolve();
  }

  private fail(error: unknown): void {
    if (this.closed) return;
    this.close(error);
    try { this.options.onFailure(error); } catch { /* Failure observers cannot reopen or strand the stream. */ }
  }
}

function integerInRange(value: number, minimum: number, maximum: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
}
