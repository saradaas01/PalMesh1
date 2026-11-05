import { useSyncExternalStore } from 'react';
import { AppState, NativeModules } from 'react-native';

// This is a device display preference, never message metadata or sender time.
// A single store/listener serves every mounted message bubble and preview.
let hour12: boolean | undefined;
let generation = 0;
let foregroundSubscription: ReturnType<typeof AppState.addEventListener> | null = null;
const listeners = new Set<() => void>();

function snapshot(): boolean | undefined { return hour12; }
function fallback(): undefined { return undefined; }

function refresh(): void {
  const request = ++generation;
  void Promise.resolve().then(async (): Promise<unknown> => {
    const bridge = NativeModules.PalMeshRuntime as { getClockFormat?: () => Promise<boolean> } | undefined;
    return typeof bridge?.getClockFormat === 'function' ? bridge.getClockFormat() : undefined;
  }).catch(() => undefined).then(value => {
    if (request !== generation || listeners.size === 0) return;
    const next = typeof value === 'boolean' ? value : undefined;
    if (next === hour12) return;
    hour12 = next;
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* A consumer cannot interrupt other subscribers. */ }
    }
  });
}

function subscribe(listener: () => void): () => void {
  const first = listeners.size === 0;
  listeners.add(listener);
  if (first) {
    // Native modules are registered when the host starts. Unlinked/older hosts
    // keep Intl fallback without allocating a useless foreground listener.
    let supported = false;
    try { supported = typeof NativeModules.PalMeshRuntime?.getClockFormat === 'function'; }
    catch { /* The initial refresh below also handles unavailable host bridges. */ }
    if (supported) foregroundSubscription = AppState.addEventListener('change', state => {
        if (state === 'active') refresh();
        else generation += 1; // Invalidate a read started before leaving the app.
      });
    refresh();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      generation += 1;
      foregroundSubscription?.remove();
      foregroundSubscription = null;
    }
  };
}

/** true = 12-hour, false = 24-hour; undefined keeps Intl's device-locale fallback.
 * Rechecks after returning from Settings; never queries separately per bubble. */
export function useDeviceHourCycle(): boolean | undefined {
  return useSyncExternalStore(subscribe, snapshot, fallback);
}
