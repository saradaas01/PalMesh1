# DTN routing engine

The engine depends on domain ports and has no React Native imports. The application
composes it with SQLite, radio sessions and the security boundary. Tests may use
the dependency-free engine without cryptography; the native app requires the
security service. See [application security](security.md) for signed hop budgets
and encrypted direct chat.

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

## Verification

Core tests cover packet validation, exact hop counts in a 17-device chain, SOS
ordering, power conservation, automatic retries, lost ACKs, cancellation, capacity
and real SQLite transaction/reopen behavior. Simulations do not verify phone
radios, OS scheduling or physical-device storage behavior.
