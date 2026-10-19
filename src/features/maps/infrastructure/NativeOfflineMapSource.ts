import type { OfflineMapSource } from '../domain/ports';
import type { OfflineMapDescriptor } from '../domain/types';
import { validateOfflineMapDescriptor } from '../domain/offlineMap';

export { validateOfflineMapDescriptor } from '../domain/offlineMap';

/** Inject NativeModules.PalMeshOfflineMaps; importing this file never loads React Native. */
export interface NativeOfflineMapsBridge {
  open(options: { readonly assetName: string; readonly expectedSha256?: string }): Promise<unknown>;
  close(): Promise<void>;
}

export interface NativeOfflineMapOptions {
  readonly assetName?: string;
  /** Pin a trusted, independently obtained digest; this does not authenticate an untrusted digest. */
  readonly expectedSha256?: string;
}

interface Attempt {
  cancelled: boolean;
  settled: boolean;
  resolve(value: OfflineMapDescriptor): void;
  reject(error: unknown): void;
  detach(): void;
  cleanup: Promise<void> | undefined;
}

const abortError = (): Error => Object.assign(new Error('Offline map opening cancelled'), { name: 'AbortError' });

/** One owner per native module. Cancellation settles immediately, then drains native cleanup
 * before the next open, so a slow, cancelled open cannot close a newer map session. */
export class NativeOfflineMapSource implements OfflineMapSource {
  private readonly options: { readonly assetName: string; readonly expectedSha256?: string };
  private tail: Promise<void> = Promise.resolve();
  private current: Attempt | undefined;
  private active: Attempt | undefined;

  constructor(private readonly native: NativeOfflineMapsBridge | undefined, options: NativeOfflineMapOptions = {}) {
    const assetName = options.assetName ?? 'palmesh/palestine.mbtiles';
    if (!/^palmesh\/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}\.mbtiles$/.test(assetName)) {
      throw new Error('Invalid bundled MBTiles asset name');
    }
    if (options.expectedSha256 !== undefined && !/^[a-fA-F0-9]{64}$/.test(options.expectedSha256)) {
      throw new Error('Expected MBTiles checksum must be a SHA-256 hex digest');
    }
    this.options = Object.freeze(options.expectedSha256 === undefined ? { assetName }
      : { assetName, expectedSha256: options.expectedSha256.toLowerCase() });
  }

  open(signal: AbortSignal): Promise<OfflineMapDescriptor> {
    if (signal.aborted) return Promise.reject(abortError());
    if (!this.native) return Promise.reject(new Error('Offline MBTiles native bridge is unavailable'));
    if (this.current) this.cancel(this.current);
    let resolve!: (value: OfflineMapDescriptor) => void;
    let reject!: (error: unknown) => void;
    const result = new Promise<OfflineMapDescriptor>((yes, no) => { resolve = yes; reject = no; });
    const attempt: Attempt = { cancelled: false, settled: false, resolve, reject, detach: () => undefined, cleanup: undefined };
    const onAbort = (): void => { this.cancel(attempt); };
    attempt.detach = () => signal.removeEventListener('abort', onAbort);
    this.current = attempt;
    signal.addEventListener('abort', onAbort, { once: true });
    const operation = this.tail.then(async () => {
      if (attempt.cancelled || signal.aborted) { this.cancel(attempt); return; }
      this.active = attempt;
      try {
        const descriptor = validateOfflineMapDescriptor(await this.native!.open(this.options));
        if (!attempt.cancelled) {
          attempt.settled = true;
          attempt.resolve(descriptor);
        }
      } catch (error) {
        if (!attempt.cancelled) {
          attempt.settled = true;
          attempt.reject(error);
          attempt.detach();
          // Invalid descriptors and partially failed opens must not leave a tile host running.
          await this.native!.close();
          if (this.active === attempt) this.active = undefined;
        }
      }
    });
    this.tail = operation.catch(() => undefined);
    // The signal can abort between the first check and listener registration.
    if (signal.aborted) this.cancel(attempt);
    return result;
  }

  close(): Promise<void> {
    const cleanup = this.current ? this.cancel(this.current) : undefined;
    return cleanup ?? this.active?.cleanup ?? this.tail;
  }

  private cancel(attempt: Attempt): Promise<void> | undefined {
    if (attempt.cancelled) return attempt.cleanup;
    attempt.cancelled = true;
    attempt.detach();
    if (!attempt.settled) attempt.reject(abortError());
    if (this.active !== attempt || !this.native) return;
    // Request cancellation while an asset copy is in flight, then close again after its
    // promise settles. Even bridges without cooperative cancellation cannot leak a late host.
    const eagerStop = Promise.resolve().then(() => this.native!.close()).catch(() => undefined);
    const cleanup = this.tail.then(async () => {
      await eagerStop;
      await this.native!.close();
      if (this.active === attempt) this.active = undefined;
    });
    attempt.cleanup = cleanup;
    this.tail = cleanup.catch(() => undefined);
    return cleanup;
  }
}

