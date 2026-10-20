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
runtime and permission UI. Discovery runs in the foreground unless the user
explicitly opts into Android background connections through the connected-device
foreground service. OS process termination still stops forwarding; see the
[Android lifecycle policy](android-app.md).

## Android host wiring

Use a native React Native app (current stable observed during implementation:
0.88.0). Install/link `react-native-ble-plx`, `@op-engineering/op-sqlite`, a secure
UUID provider, and the local package `native/palmesh-wifi-direct`. Follow the
[native library instructions](../native/palmesh-wifi-direct/README.md) and
[radio contract](mesh-native-contract.md) for manifest/runtime permissions.

The native host's [`createNativeResources`](../src/app/infrastructure/createNativeResources.ts)
initializes device-bound key storage, `SecurityService` and dedicated SQLCipher
handles, then supplies them to `createMeshNode`. The same security instance owns
handshake authentication and packet verification. It lazily constructs the BLE
manager after the platform permission flow; constructing CoreBluetooth early can
prompt unexpectedly on iOS. Reuse this composition root for the complete native
wiring instead of opening plaintext stores or supplying a different random ID.

For domain tests/custom hosts, `createMeshNode` accepts adapter/storage ports
without importing React Native. Its optional security port exists to support
isolated tests and does not make an unsecured custom host deployable. The shipped
native host always supplies the security boundary. See [security](security.md).

The radio permission check reads existing grants. Request permissions through the
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
   The integrated security boundary verifies Ed25519 challenge signatures and the
   self-certifying address/public-key relationship before admission.
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
   message UUID. Authenticated session tags bind control/packet frames to the
   two challenged peers. Native socket/GATT write completion does not acknowledge custody.

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
included CoreBluetooth peripheral bridge and BLE-PLX central adapter provide the
iOS path. See [iOS host limits](ios-app.md) for permission and suspension behavior.

`npm run check` exercises codecs, cancellation, native wrappers with test doubles,
discovery/handshake/fallback scenarios, cryptographic tamper rejection and real
SQLite custody/persistence. An earlier Android development APK compiled using
the supported React Native source fallback. New native changes need a fresh
build; simulated adapters cannot establish radio interoperability.

Run [physical-device acceptance](device-acceptance.md) with at least three phones
and internet/cellular disabled. Include group role changes, permission/power
changes, lost connections, duplicates, BLE fallback, restart and screen-off
operation. No physical-phone radio result or Apple compilation is claimed here.

In the integrated host, cryptographic identities authenticate possession of keys;
they do not identify a human, prevent Sybil identities or establish responder
qualifications. Direct chat is encrypted, while broadcast SOS/location and routing
metadata remain visible to mesh participants. The application protocol requires
independent security review; link security alone cannot protect a captured device.
