# Native radio integration

`RadioAdapter` is the ordered byte-stream boundary used by the mesh transport.
The portable package does not import React Native or bundle a simulated radio.
The mobile host injects native modules, granted-permission checks and a
`react-native-ble-plx` manager. Native status, advertising, MTU and OS lifecycle
behavior still require physical-device validation.

## Android Wi-Fi Direct

`NativeWifiDirectRadio` wraps the included Android library in
`native/palmesh-wifi-direct`. Register/autolink that package in a React Native
host and pass `NativeModules.PalMeshWifiDirect` and its `NativeEventEmitter`:

```ts
import { NativeEventEmitter, NativeModules } from 'react-native';
import { NativeWifiDirectRadio } from '../src/features/mesh/infrastructure/radios/NativeWifiDirectRadio';

const module = NativeModules.PalMeshWifiDirect;
const wifi = new NativeWifiDirectRadio(
  module,
  module ? new NativeEventEmitter(module) : undefined,
);
```

An absent module reports `unsupported`; a permission-denied or powered-off
module cannot start. The host must request the Android permissions described in
the native library README before starting discovery. The adapter never opens a
permission prompt. Wi-Fi Direct is not an iOS capability.

The structural module contract is:

```ts
interface NativeWifiDirectModule {
  getStatus(): Promise<RadioStatus>;
  start(operationId: string): Promise<void>;
  stop(): Promise<void>;
  connect(endpointId: string, operationId: string): Promise<RadioLink>;
  disconnect(linkId: string): Promise<void>;
  write(linkId: string, base64: string, operationId: string): Promise<void>;
  cancel(operationId: string): void;
}
```

`operationId` is a nonempty opaque cancellation handle of at most 256 characters,
not a device identity or security token. `endpointId` and link IDs have the same
size limit. Link IDs must be unique for every new native socket session.
`maxChunkBytes` is an integer from 1 through 8192. Input/output base64 must be
canonical; native writes and emitted data must obey the link's byte limit.

`PalMeshWifiDirectEvent` carries exactly one of:

```ts
{ type: 'discovered', endpoint: { endpointId: string, rssi?: number } }
{ type: 'connected', link: { id: string, endpointId: string, maxChunkBytes: number } }
{ type: 'data', linkId: string, base64: string }
{ type: 'disconnected', linkId: string }
{ type: 'status', status: { available: boolean, reason?: 'unsupported' | 'permission-denied' | 'powered-off' | 'unavailable' } }
{ type: 'error', message: string }
```

Events may describe incoming sockets before an explicit JS `connect()`. Native
`start()` must support both discovery and incoming connections. Native discovery
must filter PalMesh's scoped service advertisement; endpoint IDs never become
DTN peer IDs. The mesh handshake establishes peer IDs separately.

Native cancellation must stop the identified operation and invalidate its
callbacks. A partially written stream cannot safely resume: cancelling an
in-progress socket write closes that socket. `stop()` must invalidate the old
native generation before releasing resources and must finish tearing down owned
groups/listeners before resolving. It must not mutate unrelated Wi-Fi networks.
The JS adapter also invalidates events and rejects pending operations
immediately, disconnects late `connect()` results, and refuses to restart if
native teardown fails/times out. A fresh radio/native instance is then required.

The JS operation timeout defaults to 30 seconds, above the Android library's
25-second connection timeout. A shorter timeout may be configured for testing.
Native socket write completion is only local I/O completion. It cannot resolve a
DTN delivery: the remote device must parse the packet, commit it to SQLite, and
return the separate mesh protocol ACK.

## BLE central and native peripheral hosting

`BlePlxRadio` uses the actual `react-native-ble-plx` 3.5.1 API for service-filtered
scanning, connection/MTU negotiation, service discovery, notifications and
write-with-response. Its structural `BlePlxManager` type was checked against the
package's published declaration. A host can pass a real manager directly:

```ts
import { NativeEventEmitter, NativeModules } from 'react-native';
import { BleManager } from 'react-native-ble-plx';
import { NativeBlePeripheralRadio } from '../src/features/mesh/infrastructure/radios/NativeBlePeripheralRadio';
import { BlePlxRadio } from '../src/features/mesh/infrastructure/radios/BlePlxRadio';

const module = NativeModules.PalMeshBlePeripheral;
const peripheral = module ? new NativeBlePeripheralRadio(
  module, new NativeEventEmitter(module),
) : undefined;
const ble = new BlePlxRadio(new BleManager(), {
  permissionsGranted: async () => checkAlreadyGrantedBluetoothPermissions(),
  ...(peripheral ? { peripheral } : {}),
});
```

`checkAlreadyGrantedBluetoothPermissions()` is host code. On Android, check the
permissions appropriate to the API/target level, including scan/connect and
advertise when hosting; older Android scanning can require location permission
and location services. iOS requires Bluetooth usage descriptions. The manager's
`Unauthorized`, `PoweredOff`, `Unsupported` and other unavailable states are
reported before scanning. Do not run another simultaneous scan on the same
manager: this adapter owns its scan until `stop()`. The host owns
`BleManager.destroy()` after the adapter has stopped.

**BLE PLX implements the central role only. Two copies of this adapter alone
cannot discover/connect to each other as phones.** Absent a native peripheral,
`capabilities` explicitly reports `{ central: true, peripheral: false,
fullPhoneToPhone: false }`. Central-only mode can connect to a compatible PalMesh
GATT peripheral. The Android library in `native/palmesh-wifi-direct` supplies
`PalMeshBlePeripheral`, wrapped by `NativeBlePeripheralRadio`, for GATT hosting
and advertising. Compose it with the central adapter as shown above for Android
phone-to-phone links. An iOS `CBPeripheralManager` bridge remains outstanding.
Native Android code and radio behavior still need a real mobile build/device
validation; capability flags describe installed roles rather than certify them.

A host may inject a second `RadioAdapter` as `peripheral`. The included Android
implementation uses `BluetoothGattServer` + advertising; an iOS adapter must use
`CBPeripheralManager`. Any delegate must expose `kind: 'ble'`, gate its own
permissions/status, and implement these GATT characteristics:

| Role | UUID | Required behavior |
| --- | --- | --- |
| Advertised primary service | `c62d6a00-7e41-4cc2-9d31-c7a81ef11310` | Include in service discovery/advertisement. |
| Central-to-host write | `c62d6a01-7e41-4cc2-9d31-c7a81ef11310` | Support write-with-response and emit ordered received bytes. |
| Host-to-central notify | `c62d6a02-7e41-4cc2-9d31-c7a81ef11310` | Notify/indicate subscribed centrals; honor CCCD and backpressure. |

The Android module uses the same structural methods and event shape as the
Wi-Fi module, with module name `PalMeshBlePeripheral` and event name
`PalMeshBlePeripheralEvent`. The wrapper subscribes/removes only that event and
never removes another radio's listeners. Native endpoints use opaque
`ble-inbound:` handles; link IDs identify unique accepted sessions.
`NativeBlePeripheralRadio.connect()` rejects because it is passive; the central
adapter handles outbound connections. Native chunks are bounded by negotiated
`MTU - 3` and 512 bytes. `connected` is emitted only once notifications have
been enabled through the CCCD. Up to eight pre-CCCD writes/4 KiB are retained
until then; peers that do not subscribe within 20 seconds are disconnected.
Incoming GATT values are split to the immutable exposed link limit if MTU
increases later, preserving byte order without oversized bridge chunks.

The delegate's `start()` starts advertising and GATT hosting; accepted central
connections emit `connected`, writes emit `data`, and drops emit `disconnected`.
`write()` sends a notification/indication to the specified central, and `stop()`
cancels every pending operation and releases the GATT server/advertising. Use a
new link ID for each accepted connection, check subscription readiness before
notifying, respect each central's negotiated ATT MTU, and never report a native
notification/write as a durable DTN ACK. `BlePlxRadio` remaps delegate IDs into
unique session IDs and forwards inbound bytes and outgoing writes. Advertising
and scanning at the same time depend on device/OS support; a supplied delegate
still needs device testing before its capability is established operationally.

ATT chunks are bounded by `MTU - 3` (20 bytes for the default MTU 23) and the
512-byte GATT characteristic value limit. BLE requests MTU 517; the actual discovered MTU controls the limit.
The mesh layer handles fragment framing, so notifications must preserve order
and bytes rather than decode message JSON. GATT notifications can become ready
after monitor registration; the mesh handshake/ACK timeout handles readiness
losses and reconnection. The central adapter buffers up to eight early notifications/4 KiB until its
`connected` event is published, then flushes them in byte order; setup overflow
closes the link. The adapter cancels native transaction IDs, removes
subscriptions, ignores old-generation callbacks and disconnects late connections
when aborted or stopped. Both adapters cap pending link counts and per-link
write queues (64 chunks); a disconnected or cancelled queue cannot replay bytes
onto a replacement link.

## Lifecycle and security limits

Call `start(lifetimeSignal)` once per runtime lifecycle and abort that signal or
await `stop()` when suspending. Write/connect signals additionally cancel those
operations. Keep the native permission/foreground/background policy in the
mobile host; these portable adapters cannot guarantee background availability or
survival of OS process termination. Do not hardcode emergency/background bypasses.

The mesh handshake provides protocol compatibility and loop/session binding. It
is not authentication, encryption, identity attestation or protection against
malicious nearby radios. Neither Wi-Fi peer discovery nor GATT service UUIDs
prove a trusted PalMesh peer. High-risk deployment requires authenticated
end-to-end encryption, a peer/key trust design, rate-limit review and on-device
radio/lifecycle tests before carrying sensitive emergency traffic.
