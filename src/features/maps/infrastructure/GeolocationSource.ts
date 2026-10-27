import type { LocationSource } from '../domain/ports';
import type { GpsResult } from '../domain/types';
import { validLocationFix } from '../domain/locations';

export interface GeolocationBridge {
  watchPosition(
    success: (position: { readonly coords: { readonly latitude: number; readonly longitude: number; readonly accuracy?: number }; readonly approximate?: boolean; readonly timestamp: number }) => void,
    error: (error: { readonly code: number }) => void,
    options: { readonly enableHighAccuracy: boolean; readonly maximumAge: number; readonly timeout: number; readonly distanceFilter: number },
  ): number;
  clearWatch(id: number): void;
}

export interface GeolocationSourceOptions {
  readonly bridge: GeolocationBridge;
  readonly requestPermission: () => Promise<'granted' | 'denied'>;
  readonly timeoutMs?: number;
  readonly maximumAgeMs?: number;
}

/** A temporary native watch lets us actually stop GPS on background/abort.
 * It is cleared after the first fix, failure or deadline, including a callback
 * delivered synchronously before watchPosition returns its watch ID. */
export class GeolocationSource implements LocationSource {
  private readonly timeoutMs: number;
  private readonly maximumAgeMs: number;
  private reading = false;

  constructor(private readonly options: GeolocationSourceOptions) {
    this.timeoutMs = options.timeoutMs ?? 90_000;
    this.maximumAgeMs = options.maximumAgeMs ?? 60_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 120_000
      || !Number.isSafeInteger(this.maximumAgeMs) || this.maximumAgeMs < 0 || this.maximumAgeMs > 3_600_000) {
      throw new RangeError('Invalid GPS source configuration');
    }
  }

  read(signal: AbortSignal): Promise<GpsResult> {
    if (signal.aborted) return Promise.resolve({ status: 'cancelled' });
    if (this.reading) return Promise.resolve({ status: 'unavailable' });
    this.reading = true;
    return new Promise<GpsResult>(resolve => {
      let settled = false;
      let watch: number | null = null;
      const clear = (): void => {
        if (watch === null) return;
        const id = watch;
        watch = null;
        try { this.options.bridge.clearWatch(id); } catch { /* Still settle the action and reject all late callbacks. */ }
      };
      const finish = (result: GpsResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        clear();
        this.reading = false;
        resolve(result);
      };
      const onAbort = (): void => finish({ status: 'cancelled' });
      let timer = setTimeout(() => finish({ status: 'timeout' }), Math.min(30_000, this.timeoutMs));
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) { onAbort(); return; }
      // Permission prompts may outlive the action. Late authorization must not
      // start a native GPS request after this action has timed out or stopped.
      void Promise.resolve().then(() => settled ? undefined : this.options.requestPermission()).then(permission => {
        if (settled) return;
        if (permission !== 'granted') { finish({ status: 'denied' }); return; }
        clearTimeout(timer); timer = setTimeout(() => finish({ status: 'timeout' }), this.timeoutMs);
        try {
          watch = this.options.bridge.watchPosition(position => {
            if (settled) return;
            try {
              const location = {
                latitude: position.coords.latitude, longitude: position.coords.longitude,
                timestamp: position.timestamp,
              };
              const accuracy = position.coords.accuracy;
              const quality = typeof accuracy === 'number' && Number.isFinite(accuracy) && accuracy >= 0 ? { timestamp: location.timestamp, approximate: position.approximate === true || accuracy > 100, accuracyMeters: accuracy } : undefined;
              finish(validLocationFix(location) ? { status: 'fix', location: Object.freeze(location), ...(quality ? {quality} : {}) } : { status: 'unavailable' });
            } catch { finish({ status: 'unavailable' }); }
          }, error => finish({ status: error.code === 1 ? 'denied' : error.code === 3 ? 'timeout' : error.code === 4 ? 'disabled' : error.code === 5 ? 'cancelled' : 'unavailable' }), {
            enableHighAccuracy: true, maximumAge: this.maximumAgeMs,
            timeout: this.timeoutMs, distanceFilter: 0,
          });
          if (settled) clear();
        } catch { finish({ status: 'unavailable' }); }
      }, () => finish({ status: 'unavailable' }));
    });
  }
}
