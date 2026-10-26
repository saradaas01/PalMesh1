import type { RadioLink } from '../../domain/types';
import { NativeStreamRadio } from './NativeStreamRadio';
import type { NativeEventSource, NativeRadioModule } from './NativeStreamRadio';
import { abortError } from './shared';

export type NativeBlePeripheralModule = NativeRadioModule;

/** Passive native BLE GATT server + advertiser. Compose with BlePlxRadio's
 * central role: neither class alone implements both directions of discovery. */
export class NativeBlePeripheralRadio extends NativeStreamRadio<'ble'> {
  constructor(native: NativeBlePeripheralModule | undefined, emitter: NativeEventSource | undefined,
    options: { operationTimeoutMs?: number } = {}) {
    super('ble', native, emitter, 'PalMeshBlePeripheralEvent', 'BLE peripheral', 512, options);
  }

  override connect(_endpointId: string, signal: AbortSignal): Promise<RadioLink> {
    return Promise.reject(signal.aborted ? abortError() : new Error('BLE peripheral accepts inbound connections only; use the BLE central adapter to connect'));
  }
}
