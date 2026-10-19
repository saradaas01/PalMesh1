# Mesh Transport & Discovery

The mesh module implements discovery orchestration, stable peer handshakes,
framed byte transport, durable hop acknowledgments and Wi-Fi Direct/BLE fallback.
It connects to the existing DTN engine through `createMeshNode`.

## Included components

```text
src/features/mesh/
  domain/                    Radio/peer ports, protocol types, bounded wire codec
  application/               MeshCoordinator, FrameWriter, createMeshNode
  infrastructure/
    SqlitePeerRegistry.ts    Bounded, persistent last-seen peer records
    radios/                  Native Wi-Fi/BLE-host wrappers and BLE PLX client
native/palmesh-wifi-direct/  Autolinkable Android radio library source
```

`NativeWifiDirectRadio` wraps Android DNS-SD discovery, Wi-Fi P2P negotiation and
local TCP sockets. `BlePlxRadio` uses `react-native-ble-plx` 3.5.1 for the central
role. Android GATT advertising/hosting is supplied by `PalMeshBlePeripheral` and
wrapped by `NativeBlePeripheralRadio`. No central service or Internet discovery
endpoint participates in the protocol.

The repository includes an [Android application host](android-app.md), shared
runtime and permission UI. Discovery runs only in the foreground; no native
foreground service or reliable background-delivery policy is implemented.

## Android host wiring

Use a native React Native app (current stable observed during implementation:
0.88.0). Install/link `react-native-ble-plx`, `@op-engineering/op-sqlite`, a secure
UUID provider, and the local package `native/palmesh-wifi-direct`. Follow the
[native library instructions](../native/palmesh-wifi-direct/README.md) and
[radio contract](mesh-native-contract.md) for manifest/runtime permissions.

```ts
import 'react-native-get-random-values';
import { v4 as uuidv4 } from 'uuid';
import { NativeEventEmitter, NativeModules } from 'react-native';
import { BleManager } from 'react-native-ble-plx';
import { open } from '@op-engineering/op-sqlite';
import { OpSqliteDatabase, SqliteDtnStore } from '../src/features/dtn';
import {
  BlePlxRadio, NativeBlePeripheralRadio, NativeWifiDirectRadio,
  SqlitePeerRegistry, createMeshNode,
} from '../src/features/mesh';

declare const stableDeviceId: string; // Persist a random application identity.
declare function bluetoothPermissionsGranted(): Promise<boolean>;

const wifiModule = NativeModules.PalMeshWifiDirect;
const peripheralModule = NativeModules.PalMeshBlePeripheral;
const wifi = new NativeWifiDirectRadio(
  wifiModule, wifiModule ? new NativeEventEmitter(wifiModule) : undefined,
);
const peripheral = peripheralModule ? new NativeBlePeripheralRadio(
  peripheralModule, new NativeEventEmitter(peripheralModule),
) : undefined;
const manager = new BleManager();
const ble = new BlePlxRadio(manager, {
  permissionsGranted: bluetoothPermissionsGranted,
  ...(peripheral ? { peripheral } : {}),
});

// Separate dedicated handles/files keep store transactions exclusive.
const messages = open({ name: 'palmesh-dtn.sqlite' });
const peers = open({ name: 'palmesh-peers.sqlite' });
const node = createMeshNode({
  deviceId: stableDeviceId,
  ids: { next: uuidv4 },
  store: new SqliteDtnStore(new OpSqliteDatabase(messages, {
    exclusiveConnection: true,
  })),
  registry: new SqlitePeerRegistry(new OpSqliteDatabase(peers, {
    exclusiveConnection: true,
  })),
  radios: [wifi, ble],
});

node.mesh.subscribe(event => {
  // Show permission/power/status failures without claiming disconnected peers
  // are reachable. Do not log packet bodies, locations or radio addresses.
});
await node.start(); // SQLite first, then radio discovery/acceptance.

const result = await node.engine.publish({
  kind: 'sos', payload: { text: 'I need help' },
});
// accepted means locally queued; check full and surface queuing failures.
// hop-acknowledged means a peer stored it, not that help is coming.

// After the user grants permission or enables a radio:
await node.mesh.refreshRadios();

// On disposal; the host decides foreground/background policy:
await node.stop();
manager.destroy();
messages.close();
peers.close();
```

The permission function checks existing grants. Request permissions through the
host UI before discovery; background discovery does not present prompts. With no
available radios, the DTN engine still accepts local offline messages and reports
radio status separately. Missing BLE hosting is explicitly exposed through
`ble.capabilities.fullPhoneToPhone`; two central-only phones cannot connect.

## Session and custody protocol

1. Discovery produces radio endpoint IDs, never DTN identities. An endpoint opens
   an ordered native byte stream; no application peer is published at this point.
2. Each endpoint sends a v1 `hello` with its stable device ID and fresh UUID nonce.
   The peer echoes that nonce in `hello-ack` while supplying its own identity and
   nonce. Conflicting identities, self-connections and stale echoes close the link.
   Up to three hello attempts share the same nonce within the handshake deadline,
   allowing recovery when an initial complete notification was missed.
3. Once both hello and nonce echo agree, the local peer becomes ready. A `ready`
   frame confirms that publication remotely. Deterministic duplicate-link
   retirement waits for that confirmation, avoiding false peer loss when old
   disconnect events overtake a new stream's handshake.
4. A `packet` frame carries a fresh transfer UUID and the intended receiver's
   session nonce. The receiver calls `DtnEngine.receive`. Only a committed
   `accepted` or `duplicate` result produces an `ack`. Capacity/validation/storage
   failures produce a `nack` and never success custody.
5. The sender matches the receiving link, local session nonce, transfer UUID and
   message UUID. Native socket/GATT write completion does not acknowledge custody.

Wi-Fi is preferred for a ready peer. Write failure, link loss or ACK timeout can
retry the same packet over an already-ready BLE link. UUID deduplication protects
the lost-ACK case. A remote storage-full/invalid response is propagated rather
than repeatedly sending the same rejected packet over every radio. Local queue
capacity failures preserve healthy links and earlier pending transfers.

`createMeshNode` sizes the DTN send deadline to include each radio's whole-frame
write and ACK deadlines plus a margin. The defaults allow 27 seconds for two
radios. A custom shorter DTN deadline is rejected. A default-MTU BLE transfer can
be slow; tune packet sizes/deadlines only with device measurements.

Frames use a four-byte big-endian length prefix plus strict UTF-8 JSON. The
decoder handles arbitrary socket/BLE splits and coalescing without assuming
notification boundaries are message boundaries. A whole frame is written before
the next frame starts. Control frames have reserved queue capacity and priority
between whole frames; bytes from two frames are never interleaved.

## Bounds, reconnects and retention

Defaults bound 16 peers, 32 physical sessions, 128 discovered endpoints, two
simultaneous connection attempts, four pending/incoming transfers per link,
32 incoming transfers globally, and 16 queued frames per link with four control
slots. The body limit is 20 KiB, the embedded DTN packet limit is 16 KiB, and raw
native chunks are at most 8 KiB (BLE additionally uses MTU-3, capped at 512 bytes).
Malformed/oversized inputs fail before unbounded allocation.

Connections use bounded exponential retry and discovery expiry. A live endpoint's
age is refreshed at disconnect so a scan that reported it only once can still
reconnect. Generation guards ignore old events and late storage completions after
stop/restart. Native cancellation that interrupts a frame closes its stream;
the receiver cannot safely resume an unknown partial frame.

The registry stores only stable peer IDs, last-seen time and observed radio
kinds. It defaults to 256 entries, merges capabilities, prevents last-seen clock
regression and evicts the oldest entry at capacity. Activity updates are throttled
to 30 seconds and records older than seven days are pruned. Session nonces,
transfer UUIDs and radio/MAC addresses are not persisted there.

Receiver backpressure slots remain occupied until their storage call actually
finishes, including across a radio restart. A hung custom storage adapter must
be recovered; resetting counters would allow unlimited unresolved writes.

## Platforms, validation and remaining work

Android Wi-Fi Direct operates in groups; a device cannot maintain arbitrary
simultaneous Wi-Fi Direct links. DTN carries packets between later contacts, and
BLE provides a separate possible path. Wi-Fi Direct is unsupported on iOS; the
BLE protocol/adapter can be reused there, but an iOS `CBPeripheralManager` hosting
bridge and its permission/background handling remain to be implemented.

`npm run check` exercises TypeScript contracts, codecs, cancellation, native
wrappers with test doubles, discovery/handshake/fallback scenarios and real
SQLite custody/persistence. Android source validation is reported separately;
simulated adapters cannot establish hardware interoperability. There are no
physical-device radio results yet. Native signature compilation was blocked when
the official React Native AAR download redirected to `repo.reactnative.dev` and
returned HTTP 403. Native Java syntax/manifest checks are not a successful Android
build. Build the host and test two or more phones
with Internet/cellular disabled, permission/power changes, group role changes,
lost connections, duplicate discovery, radio fallback, restart and background
suspension before relying on this module.

Handshakes provide protocol/session agreement, **not cryptographic identity or
encryption**. This protocol still carries plaintext. Native Wi-Fi link security
does not fix application identity spoofing, device capture or untrusted relays.
Reviewed authentication, key management, encrypted payload/storage and a native
background execution design remain required for high-risk deployment.
