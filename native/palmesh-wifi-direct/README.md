# PalMesh Android native radio transports

This local React Native library implements `NativeModules.PalMeshWifiDirect` for
the typed mesh radio adapter. It uses Android `WifiP2pManager` DNS-SD discovery and
a real TCP stream on the Wi-Fi Direct group interface. It never contacts an
Internet service, changes the process default network, or creates a VPN.
The same autolinked package exports `NativeModules.PalMeshBlePeripheral` for
Android BLE advertising/GATT hosting alongside the BLE-PLX central adapter.

## Host integration

The host must be a React Native Android application with native builds enabled
(not Expo Go). Add this directory as a local dependency; React Native autolinking
finds `PalMeshWifiDirectPackage` without editing the host application class:

```json
{
  "dependencies": {
    "@palmesh/wifi-direct": "file:./native/palmesh-wifi-direct"
  }
}
```

If the host app lives elsewhere, adjust the dependency's relative path. Install
with the host package manager, then build the host's Android project. The module
uses React Native's legacy native-module interop under the New Architecture;
the repository includes an Android host under `android/`. The Gradle library
consumes the host's Android plugin and React Android version.
Java 17 source compatibility, Android API 24 minimum, and API 36 compile/target
defaults are declared; host SDK settings override the defaults.

The host requests runtime permissions through an explicit user action before
expecting discovery. Starting without grants leaves local queuing available:

- Android 13 / API 33 and later: `NEARBY_WIFI_DEVICES`.
- Android 12 / API 32 and earlier: `ACCESS_FINE_LOCATION`, and enable the system
  location switch. The location permission is capped at API 32 in the manifest.
- Enable Wi-Fi on all supported versions. System Wi-Fi Direct dialogs may ask
  users to approve a connection; the module does not bypass system consent.

The merged library manifest declares the permissions. `INTERNET` is necessary
for Android's socket API even when both ends are on a private Wi-Fi Direct
network. No remote address or Internet discovery service is used.

Create the JS radio adapter with `NativeModules.PalMeshWifiDirect` and a
`NativeEventEmitter` for that module (see the mesh feature's integration guide).
Permission requests and application lifecycle policy belong to the host; the
native module only checks current permission/status and reports failures.

## Native contract

All methods return Promises except `cancel` and NativeEventEmitter's listener
registration methods. Operation IDs are unique, nonempty, trimmed strings up to
256 characters. At most 64 operations can be pending.

| Method | Result |
| --- | --- |
| `getStatus()` | `{ available, reason? }` |
| `start(operationId)` | Starts PalMesh advertisement and discovery |
| `stop()` | Invalidates old events/operations, closes sockets, releases this session's resources |
| `connect(endpointId, operationId)` | `{ id, endpointId, maxChunkBytes: 8192 }` after a real socket greeting |
| `disconnect(linkId)` | Closes that stream; the group remains available for reuse |
| `write(linkId, base64, operationId)` | Resolves after the native stream write and flush |
| `cancel(operationId)` | Rejects the pending operation and closes its incomplete socket/write |

The event `PalMeshWifiDirectEvent` carries `discovered`, `connected`, `data`,
`disconnected`, `status`, or `error` objects matching the JS adapter contract.
`data` includes `{ linkId, base64 }`; TCP chunks can split or combine application
frames. The JS mesh protocol supplies framing and durable acknowledgments.
A successful `write` acknowledges a local socket write, not remote storage.

Discovery accepts only `_palmesh._tcp` services named `palmesh-<UUID>` with
version `1`, a matching UUID TXT identity, and port `45459`. Endpoint IDs are
`p2p:<UUID>` values scoped to this native module instance; they are never DTN
peer/device identities. A bounded native greeting checks the protocol and
discovered endpoint before exposing a socket. DTN identity is established by
the higher-level mesh handshake.

## Limits and lifecycle

- Wi-Fi Direct is a group topology, not arbitrary simultaneous mesh links.
  The owner accepts at most four local TCP peers. A group client can open a
  Wi-Fi link to its owner only; other peers require another radio or later
  group formation. The adapter can fall back to BLE on `E_GROUP_LIMIT`.
- Only PalMesh advertisements are surfaced. Discovery records are bounded to
  128; explicit connection requests require a record seen within two minutes.
- A single outstanding P2P negotiation avoids repeated connect loops. Clients
  automatically attempt their discovered group owner once per group; an
  explicit connection request can retry after failure. Peer discovery is not
  polled in a reconnect loop. DNS-SD discovery itself resumes after Android
  stops discovery, with bounded backoff up to 60 seconds and a periodic refresh.
  Dense TXT advertisements coalesce group-info queries to at most two per second.
- Links expose a maximum 8 KiB write chunk. IO/write task queues and the
  main-thread incoming delivery queue are bounded. TCP provides transport
  backpressure; the JS protocol must retain its own bounded frame/transfer
  limits and await writes/acknowledgments.
- Native deadlines are 20 seconds for discovery startup, 25 seconds for a
  connection, 10 seconds for a write, 7 seconds for TCP connect, and 5 seconds
  for the native greeting. Set the JS operation deadline above 25 seconds.
- Cancelling or timing out a write closes its link because a partial byte
  stream cannot safely resume. DTN retries from persisted state over a new
  session. Link loss emits `disconnected`; discovery does not manufacture a
  successful connection.
- `stop`, React Native invalidation, and host destruction cancel tasks and
  suppress earlier-generation connection/data callbacks. Cleanup removes only
  this module's DNS-SD advertisement/request and a group observed forming with
  a PalMesh peer during this session. A group that existed before `start` is
  rejected with `E_EXISTING_GROUP`; it is never removed. An owned group removal
  failure rejects `stop` rather than claiming cleanup succeeded.
  Cancelled negotiations suppress late links and reconcile any resulting group;
  `stop` awaits cancellation and queries group state before final cleanup.
- There is no foreground service, wake lock, or background-location request in
  this library. Continuous operation while the host is backgrounded requires a
  host-managed Android foreground service and device-specific validation.
  Android may suspend the process or networking otherwise.
- This module is Android-only. iOS does not expose Android Wi-Fi Direct APIs.
  BLE or a separately designed native peer framework is required there.

Wi-Fi Direct link encryption does not authenticate DTN identities. The native
greeting and JS handshake are protocol checks, not cryptographic authentication.
Application-level authentication/encryption and replay protection are required
before deployment in adversarial environments.

## Android BLE peripheral

`PalMeshBlePeripheral` uses the same native method/event shapes, with event name
`PalMeshBlePeripheralEvent`. It is a passive radio: `connect` rejects with
`E_UNSUPPORTED`; the BLE-PLX central adapter initiates connections. Use the JS
`CompositeBleRadio` to expose central and peripheral roles as one `RadioAdapter`.

The host requests `BLUETOOTH_ADVERTISE`, `BLUETOOTH_CONNECT`, and (for the composed
central scanner) `BLUETOOTH_SCAN` on Android 12 / API 31 and later. The library
declares those permissions, plus legacy normal
`BLUETOOTH`/`BLUETOOTH_ADMIN` capped at API 30. Peripheral advertising/GATT hosting
does not request location. The host's BLE central scanner separately needs its
scan/location permissions and Android location policy; consult the JS radio
integration guide. Devices without BLE peripheral advertising support report
`unsupported`; a disabled adapter reports `powered-off`.

The peripheral advertises service `c62d6a00-7e41-4cc2-9d31-c7a81ef11310` without
the device name. Characteristic `...6a01...` accepts writes **with response**;
characteristic `...6a02...` provides read/notify with the standard `0x2902`
client-configuration descriptor. Characteristic reads return no old packet data.
Only normal offset-zero writes are accepted; prepared writes are rejected.

Up to eight centrals can connect. `connected` is emitted only once the central
enables notifications, with a per-connection opaque endpoint/link and a chunk
limit `min(MTU - 3, 512)`. Until then, at most eight incoming chunks / 4 KiB are
buffered for the handshake; overflow or a 20-second subscription deadline closes
the connection. After CCC activation, `connected` precedes buffered `data` events.
An MTU decrease below the exposed limit closes the link so a new session can
negotiate safe framing.

Outgoing notification writes are globally serialized, including across devices
for Android's legacy mutable characteristic API. A write Promise resolves only
on `onNotificationSent`; Android 13+ uses the immutable-value notification API.
Queued operations are bounded to 64 and time out after ten seconds. Cancelling
an active write closes its connection. Its address remains blocked until the
old notification callback drains, preventing that callback from acknowledging
a new connection's write. If Android never delivers the callback, stop/start
the radio to create a fresh GATT server generation. These callbacks acknowledge
local GATT transport completion, never durable DTN storage.

`stop`, host destruction, and React Native invalidation stop advertising, cancel
connections/operations, close the GATT server, and invalidate old callbacks.
As with Wi-Fi Direct, sustained background BLE operation needs a host-managed
Android foreground service and physical-device validation. No iOS peripheral
implementation is included.

## Validation

This environment has a Java runtime but no `javac`, Android SDK, Gradle, `adb`,
or React Native host project. **The Android library has not been compiled or
tested on devices here.** TypeScript tests cannot establish native correctness.
Java source syntax, manifest XML, and autolinking metadata were checked. An
attempt to retrieve the official React Native Android AAR redirected to
`repo.reactnative.dev` and returned HTTP 403, including for baseline versions;
it did not provide an artifact for compilation.

In an Android host, build the debug app, verify the autolinked module appears,
and run on at least two physical Wi-Fi Direct-capable devices. Test discovery
with Internet/cellular disabled, both owner/client roles, actual message and
durable-ack exchange, permission denial/revocation, Wi-Fi toggles, interrupted
TCP writes, stop/restart, pre-existing unrelated groups, background suspension,
and BLE fallback when a group cannot include the requested endpoint. For BLE,
test central/peripheral operation in both directions, MTU 23 and larger MTUs,
early handshake writes before CCC setup, multiple centrals, notification
cancellation/reconnect, permission revocation and Bluetooth toggles. Include
API 32 and API 33+ devices and multiple vendors; Wi-Fi P2P behavior varies.

## iOS

The included `PalMeshWifiDirect.podspec` autolinks the CoreBluetooth peripheral and authorization bridges. iOS exposes no Android-style Wi-Fi Direct bridge. Pair the native BLE peripheral with BLE PLX's central role, after the user explicitly grants Bluetooth access through `PalMeshBluetoothAuthorization`. The authorization check does not instantiate a manager. Peripheral links enforce negotiated chunk limits and bounded notification backpressure; revoking a logical session cannot force the remote central to disconnect. See [iOS host setup and limitations](../../docs/ios-app.md). iOS native compilation and real-phone validation require macOS/Xcode.
