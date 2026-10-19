# PalMesh

An offline-first emergency communication app. Implemented modules include the
**DTN engine**, **Mesh Transport & Discovery**, **Chat & Messaging**, and
**Offline Maps & Location**: durable
store-and-forward routing, handshaken radio sessions, Wi-Fi/BLE fallback and
reactive React Native conversations, persistent location reports and a local
MBTiles map bridge. Their application/domain cores can be tested
independently of the mobile runtime.

## Develop and verify

Use Node.js 24+ for development tests (they use Node's real SQLite implementation).

```sh
npm ci
npm run check
```

`check` runs strict TypeScript checks, domain/engine/SQLite tests, React Native
interaction tests and a declaration build. Core APIs do not load React Native;
chat screens/hooks are imported separately. `dist/` is generated
and ignored. Android native radio library sources are included; a React Native
Android application shell is included under `android/`; native compilation and
physical-device validation remain outstanding.

## Android application

The app joins Messages and Map tabs around one persistent runtime, explicit
nearby-radio permissions and one shared SOS action with cached GPS attachment.
See [Android app setup](docs/android-app.md) for build prerequisites and current
validation limits.

```sh
npm start
# In a second terminal with an Android device attached:
adb reverse tcp:8081 tcp:8081
npm run android
```

`npm run bundle:android` validates the production JavaScript bundle without an
Android SDK and writes it to `dist/android/`. It does not produce an APK.

See [Mesh integration](docs/mesh.md) for the Android-first discovery/transport
module, native library wiring, BLE hosting and platform limitations.

See [Chat integration](docs/chat.md) for persistent conversations, live updates,
offline drafts, peer-custody labels and the one-tap SOS control.

See [Offline maps integration](docs/maps.md) for MapLibre, Android MBTiles
hosting, GPS permissions and opt-in location broadcasts. The real Palestine
MBTiles asset must be supplied; it is not included in this repository.

## Module layout

```text
src/features/dtn/
  domain/                   Packets, validation, TTL rules, storage/transport ports
  application/DtnEngine.ts   Publish/receive use cases, forwarding worker, events
  infrastructure/sqlite/    Transactional store and native executeSync bridge
  index.ts                  Public API
tests/                      Real SQLite and multi-device simulations
```

The domain has zero external dependencies. Application logic depends on its
ports; React Native hooks/screens can subscribe to engine events and invoke its
use cases. Discovery supplies stable peer IDs; radios implement `MeshTransport`.

## Routing contract

- Originating chat/location messages have `ttl: 10`; SOS has `ttl: 15`.
  Each sender transmits `ttl - 1`, preserving its stored copy. A recipient with
  `ttl: 0` stores the message and cannot forward it. Retries and fan-out never
  spend additional hops from the stored copy.
- Packets have a UUID v4, version, source, destination, timestamp, kind and typed
  payload. `destination: '*'` means broadcast. Unicast relays carry packets even
  without a current route; the destination consumes them without relaying.
- SQLite atomically commits the packet, dedup ID and previous-hop receipt.
  Duplicate UUIDs keep the first packet and TTL; they cannot upgrade priority,
  payload, retention or hop allowance. A duplicate's previous hop is also recorded
  as already carrying that packet.
- Ready SOS packets precede ordinary traffic. Within a priority, packets are FIFO.
  An in-flight packet finishes or times out; the next selection checks priority
  again. Backed-off peers do not block other ready deliveries.
- Hop ACKs and failed attempts persist per peer. Acknowledged peers are not sent
  the packet again on reconnect; new peers can receive retained packets. A
  broadcast is not removed after one peer acknowledges it.
- Retries use capped exponential backoff with jitter. Send timeout, peer removal
  and `stop()` abort I/O. Bounded batches yield to the JavaScript event loop.
  `conserve` mode pauses ordinary forwarding while allowing SOS.

Deduplication deliberately has persistent, bounded state. A stateless cache cannot
remember UUIDs across process death. After dedup retention expires, an old UUID
can be accepted again. Hop TTL is a hop count, not a time limit or authentication.

## React Native integration

Install/link SQLite in the host app. `OpSqliteDatabase` wraps the documented
synchronous API of `@op-engineering/op-sqlite` 18.2.5 without importing that package
into the core. It verifies WAL (or a durable rollback journal) and
`synchronous=FULL`. Keep the database connection/file exclusive to the store;
an asynchronous bridge needs its own transaction-aware `DtnStore` adapter.
Operations on this adapter run synchronously. Dense idle-queue scans can still
take tens of milliseconds; tune capacity/peer limits and profile SOS/UI
responsiveness on physical devices. The storage port permits a native asynchronous
implementation when needed without changing routing rules.

Example host wiring, after installing native SQLite and a secure UUID provider
(`react-native-get-random-values` and `uuid` in this example):

```ts
import 'react-native-get-random-values';
import { v4 as uuidv4 } from 'uuid';
import { open } from '@op-engineering/op-sqlite';
import {
  DtnEngine, OpSqliteDatabase, SqliteDtnStore, isForLocal,
  type MeshTransport,
} from './src/features/dtn';

declare const meshTransport: MeshTransport; // Real Wi-Fi/BLE adapter.
declare const persistedDeviceId: string;    // Stable across app restarts/radios.

const connection = open({ name: 'palmesh-dtn.sqlite' });
const store = new SqliteDtnStore(new OpSqliteDatabase(connection, {
  exclusiveConnection: true,
}));
const engine = new DtnEngine({
  deviceId: persistedDeviceId,
  store,
  transport: meshTransport,
  ids: { next: uuidv4 }, // Never use Math.random for UUIDs.
});

await engine.start();
engine.setConnectedPeers(['peer-device-id']); // Refresh on connect/drop/reconnect.

const unsubscribe = engine.subscribe(event => {
  if (event.type === 'accepted' && isForLocal(event.record.message, engine.deviceId)) {
    // Refresh chat/SOS state from SQLite.
  }
  if (event.type === 'error') {
    // Surface storage/worker failures without logging message bodies.
  }
});

const result = await engine.publish({
  kind: 'sos',
  payload: { text: 'I need help' },
});
if (result.status === 'full') {
  // Report failure to queue; do not show an unsaved SOS as sent.
}

// When disposing the runtime:
unsubscribe();
await engine.stop();
connection.close();
```

Use a persistent random application device ID, not a hardware MAC or transient
session ID. Wi-Fi/BLE sessions for the same device must resolve to the same ID.
The engine requires a secure UUID v4 generator and has no insecure fallback.

For each inbound packet, call `await engine.receive(previousHopDeviceId, packet)`.
Send a UUID ACK **only** for `accepted` or `duplicate`. `full`/`invalid` require a
NACK or no ACK; storage exceptions require no success ACK. Native `send()` must
resolve after that durable receiver ACK, not after a socket/BLE write. Native
wrappers must honor `AbortSignal` and release pending operations.

An ACK proves custody at one hop. It does not prove delivery to a final recipient,
that a person read a message, or that help is coming. End-to-end receipts need a
separate protocol feature.

`history(limit)` exposes routing history, including relayed unicast packets;
UI code must filter with `isForLocal`. Subscribe before reading initial history
and refresh on events. `flush()` waits for ready work across bounded batches,
without waiting for disconnected peers or future retries. One engine owns each
store. After foreground/restart, call `start()` and refresh connected peers.
Native background execution is a host responsibility; JavaScript timers cannot
guarantee it.

## Resource and retention policy

Override defaults through the constructor's `config`:

| Setting | Default |
| --- | --- |
| Retained messages (queue and recent history) | 1,000 |
| Message slots reserved for SOS | 100 |
| Retained dedup IDs | 10,000 |
| Dedup slots reserved for SOS | 1,000 |
| Message / dedup retention | 24 hours / 7 days |
| Tracked peers per message, over its lifetime | 256 |
| Simultaneous connected peers | 64 |
| Serialized packet / text bound | 16 KiB / 4,096 UTF-16 code units |
| Hop ACK timeout | 10 seconds |
| Retry delay | 1–60 seconds, including capped jitter |
| Transmissions per event-loop turn | 32 |

Ordinary traffic may fill only `capacity - reserved` total slots. SOS may use
the full capacity and evict the oldest ordinary message if the message table is
full. Eviction removes queue/history and receipts but retains the dedup ID.
Live dedup IDs and existing SOS packets are never evicted. A full SOS/dedup
budget can still reject an SOS; callers must handle that result. At the peer
tracking limit, existing retries continue but no new peers are scheduled.

Expiration uses local first receipt, independently of sender timestamps. Local
clock rollback is clamped within an engine session. Clock changes across restarts
still affect time retention; hop limits remain independent. History expires with
its packet; permanent conversation archival is a separate concern.

Apply raw frame-size bounds and inbound backpressure **before** JSON decoding in
the native transport. It also owns BLE fragmentation/reassembly, connection
handshakes, peer admission, and link fallback. The engine bounds accepted packets,
queues, dedup IDs, peer ledgers and worker batches.

## Verification and remaining integration

Tests cover packet validation, UTF-8 limits, exact hop counts in a 17-device chain,
SOS ordering, battery conservation, automatic retries, lost ACKs, cancellation,
duplicate suppression, capacity/eviction, transaction rollback and SQLite
close/reopen persistence. Native adapter tests use real SQLite through an
`executeSync` bridge; Android/iOS native bindings and radios need device tests.

Packets currently have plaintext payloads and unauthenticated source IDs. Before
high-risk deployment, the app needs reviewed identity/key management,
authenticated encryption, encrypted storage, native background/permission
handling and physical-device interruption tests. This engine alone is not a
validated emergency communication system.

Next work includes supplying a reviewed Palestine map pack, native compilation
and device validation, iOS hosting and security hardening. Chat and maps include direct
SOS controls; queuing does not imply that a recipient or responder received the
emergency.
