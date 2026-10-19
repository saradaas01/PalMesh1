import { NativeStreamRadio } from './NativeStreamRadio';
import type { NativeEventSource, NativeRadioModule } from './NativeStreamRadio';

export type { NativeEventSource } from './NativeStreamRadio';
export type NativeWifiDirectModule = NativeRadioModule;

/** Native Android Wi-Fi Direct socket discovery + incoming/outgoing links. */
export class NativeWifiDirectRadio extends NativeStreamRadio<'wifi-direct'> {
  constructor(native: NativeWifiDirectModule | undefined, emitter: NativeEventSource | undefined,
    options: { operationTimeoutMs?: number } = {}) {
    super('wifi-direct', native, emitter, 'PalMeshWifiDirectEvent', 'Wi-Fi Direct', 8192, options);
  }
}
