import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { DtnEngine, type DtnEngineOptions } from '../src/features/dtn/application/DtnEngine';
import { forNextHop } from '../src/features/dtn/domain/routing';
import { createMessage } from '../src/features/dtn/domain/validation';
import type { MeshTransport } from '../src/features/dtn/domain/ports';
import type { DtnEvent, MeshMessage } from '../src/features/dtn/domain/types';
import { createTestStore } from './helpers/sqlite';

interface SentPacket { readonly peerId: string; readonly packet: MeshMessage }

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t: TestContext, options: Partial<Omit<DtnEngineOptions, 'store'>> = {}) {
  const database = createTestStore();
  const sent: SentPacket[] = [];
  const events: DtnEvent[] = [];
  const time = { value: 1_000 };
  const transport: MeshTransport = {
    async send(peerId, packet) { sent.push({ peerId, packet }); },
  };
  const engine = new DtnEngine({
    deviceId: 'alice', store: database.store, transport,
    clock: { now: () => time.value }, ids: { next: randomUUID }, ...options,
  });
  engine.subscribe(event => { events.push(event); });
  t.after(async () => { await engine.stop(); database.close(); });
  await engine.start();
  return { engine, store: database.store, sent, events, time };
}

test('offline publish survives stop/start and sends the same one-hop decrement to every new peer', async t => {
  const { engine, store, sent } = await fixture(t);
  const result = await engine.publish({ kind: 'chat', destination: 'recipient', payload: { text: 'Offline hello' } });
  assert.equal(result.status, 'accepted');
  if (result.status !== 'accepted') return;
  assert.equal(result.record.message.ttl, 10);
  assert.equal(sent.length, 0);
  await engine.stop();
  engine.setConnectedPeers(['bob', 'carol', 'alice', 'bob']);
  await engine.start();
  await engine.flush();
  assert.deepEqual(sent.map(item => [item.peerId, item.packet.ttl]), [['bob', 9], ['carol', 9]]);
  assert.equal((await store.getMessage(result.record.message.id))?.message.ttl, 10);
  engine.setConnectedPeers([]);
  engine.setConnectedPeers(['bob', 'carol', 'david']);
  await engine.flush();
  assert.deepEqual(sent.map(item => item.peerId), ['bob', 'carol', 'david']);
});

test('an SOS jumps ahead of queued chat immediately after the current transmission', async t => {
  const began = deferred();
  const release = deferred();
  const sent: MeshMessage[] = [];
  const { engine } = await fixture(t, {
    transport: {
      async send(_peerId, packet) {
        sent.push(packet);
        if (sent.length === 1) { began.resolve(); await release.promise; }
      },
    },
  });
  t.after(() => release.resolve());
  engine.setConnectedPeers(['bob']);
  await engine.publish({ kind: 'chat', destination: 'bob', payload: { text: 'in flight' } });
  await began.promise;
  await engine.publish({ kind: 'chat', destination: 'bob', payload: { text: 'waiting' } });
  await engine.publish({ kind: 'sos', payload: { text: 'I need help' } });
  release.resolve();
  await engine.flush();
  assert.deepEqual(sent.map(packet => [packet.kind, packet.ttl]), [['chat', 9], ['sos', 14], ['chat', 9]]);
});

test('conserve mode pauses ordinary traffic and continues SOS delivery', async t => {
  const { engine, sent } = await fixture(t);
  await engine.publish({ kind: 'chat', destination: 'bob', payload: { text: 'Wait for battery' } });
  await engine.publish({ kind: 'location', payload: { location: { latitude: 31.5, longitude: 34.4, timestamp: 900 } } });
  await engine.publish({ kind: 'sos', payload: { text: 'Help', location: { latitude: 31.5, longitude: 34.4, timestamp: 900 } } });
  engine.setPowerMode('conserve');
  engine.setConnectedPeers(['bob']);
  await engine.flush();
  assert.deepEqual(sent.map(item => item.packet.kind), ['sos']);
  engine.setPowerMode('normal');
  await engine.flush();
  assert.deepEqual(sent.map(item => item.packet.kind), ['sos', 'chat', 'location']);
});

test('failed peers back off without blocking others, and retries do not spend additional TTL', async t => {
  const sent: SentPacket[] = [];
  let failures = 1;
  const { engine, store, time, events } = await fixture(t, {
    transport: { async send(peerId, packet) {
      sent.push({ peerId, packet });
      if (peerId === 'bob' && failures-- > 0) throw new Error('radio dropped');
    } },
  });
  await engine.publish({ kind: 'chat', destination: '*', payload: { text: 'Carry me' } });
  engine.setConnectedPeers(['bob', 'carol']);
  await engine.flush();
  assert.deepEqual(sent.map(item => item.peerId), ['bob', 'carol']);
  const pending = await store.getNextDelivery(['bob'], time.value, false, 256);
  assert.ok(pending);
  assert.equal(pending.attempts, 1);
  assert.ok(pending.nextAttemptAt >= time.value + 1_000);
  await engine.flush();
  assert.equal(sent.length, 2);
  time.value = pending.nextAttemptAt;
  await engine.flush();
  assert.deepEqual(sent.map(item => item.packet.ttl), [9, 9, 9]);
  assert.equal(events.filter(event => event.type === 'retry-scheduled').length, 1);
  assert.equal(events.filter(event => event.type === 'hop-acknowledged').length, 2);
  assert.equal(await store.getNextDelivery(['bob', 'carol'], time.value, false, 256), null);
});

test('lost ACK retries are deduplicated durably at the receiver', async t => {
  const receiver = await fixture(t, { deviceId: 'bob' });
  let ackLost = true;
  const wire: MeshMessage[] = [];
  const sender = await fixture(t, {
    transport: { async send(_peerId, packet) {
      wire.push(packet);
      const result = await receiver.engine.receive('alice', packet);
      assert.ok(result.status === 'accepted' || result.status === 'duplicate');
      if (ackLost) { ackLost = false; throw new Error('ACK lost after durable receipt'); }
    } },
  });
  await sender.engine.publish({ kind: 'chat', destination: 'bob', payload: { text: 'Exactly one history entry' } });
  sender.engine.setConnectedPeers(['bob']);
  await sender.engine.flush();
  const retry = await sender.store.getNextDelivery(['bob'], sender.time.value, false, 256);
  assert.ok(retry);
  sender.time.value = retry.nextAttemptAt;
  await sender.engine.flush();
  assert.deepEqual(wire.map(packet => packet.ttl), [9, 9]);
  assert.equal((await receiver.engine.history()).length, 1);
  assert.equal(receiver.events.filter(event => event.type === 'accepted').length, 1);
  assert.equal(receiver.events.filter(event => event.type === 'duplicate').length, 1);
});

test('duplicate arrivals do not upgrade TTL or re-forward to peers already carrying the UUID', async t => {
  const { engine, sent } = await fixture(t);
  const original = createMessage({ kind: 'chat', destination: '*', payload: { text: 'First copy wins' } }, randomUUID(), 'origin', 1);
  assert.equal((await engine.receive('previous', { ...original, ttl: 5 })).status, 'accepted');
  assert.equal((await engine.receive('duplicate-hop', original)).status, 'duplicate');
  engine.setConnectedPeers(['origin', 'previous', 'duplicate-hop', 'fresh']);
  await engine.flush();
  assert.deepEqual(sent.map(item => [item.peerId, item.packet.ttl]), [['fresh', 4]]);
  assert.equal((await engine.history())[0]?.message.ttl, 5);
});

test('destination and zero-hop packets are stored for local consumption and never relayed', async t => {
  const { engine, sent } = await fixture(t);
  const addressed = createMessage({ kind: 'chat', destination: 'alice', payload: { text: 'For Alice' } }, randomUUID(), 'origin', 1);
  const terminal = createMessage({ kind: 'sos', payload: { text: 'Final hop' } }, randomUUID(), 'origin', 1);
  assert.equal((await engine.receive('previous', addressed)).status, 'accepted');
  assert.equal((await engine.receive('previous', { ...terminal, ttl: 0 })).status, 'accepted');
  engine.setConnectedPeers(['fresh']);
  await engine.flush();
  assert.equal(sent.length, 0);
  assert.equal((await engine.history()).length, 2);
});

test('late-connected chains enforce exactly 10 normal / 15 SOS network edges', async t => {
  const nodes: DtnEngine[] = [];
  for (let index = 0; index < 17; index += 1) {
    const deviceId = `node-${index}`;
    const { engine } = await fixture(t, {
      deviceId,
      transport: { async send(peerId, packet) {
        const target = nodes[Number(peerId.slice(5))];
        assert.ok(target);
        const result = await target.receive(deviceId, packet);
        assert.ok(result.status === 'accepted' || result.status === 'duplicate');
      } },
    });
    nodes.push(engine);
  }
  const first = nodes[0];
  assert.ok(first);
  await first.publish({ kind: 'chat', destination: '*', payload: { text: 'Ten hops' } });
  await first.publish({ kind: 'sos', payload: { text: 'Fifteen hops' } });
  // Each carrier can move the queue on a later contact, with no end-to-end path
  // required at the time of publication.
  for (let index = 0; index < 16; index += 1) {
    const current = nodes[index];
    assert.ok(current);
    current.setConnectedPeers([`node-${index + 1}`]);
    await current.flush();
  }
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    assert.ok(node);
    const history = await node.history();
    assert.equal(history.some(record => record.message.kind === 'chat'), index <= 10, `chat at node ${index}`);
    assert.equal(history.some(record => record.message.kind === 'sos'), index <= 15, `SOS at node ${index}`);
    const chat = history.find(record => record.message.kind === 'chat');
    const sos = history.find(record => record.message.kind === 'sos');
    if (chat) assert.equal(chat.message.ttl, 10 - index);
    if (sos) assert.equal(sos.message.ttl, 15 - index);
  }
});

test('a disconnected or unresponsive peer is cancelled, and ready peers still receive packets', async t => {
  let interrupted: AbortSignal | undefined;
  const delivered: string[] = [];
  const { engine, events } = await fixture(t, {
    config: { sendTimeoutMs: 20 },
    transport: { async send(peerId, _packet, signal) {
      if (peerId === 'unresponsive') {
        interrupted = signal;
        await new Promise<void>(() => { /* Simulate even a broken native wrapper. */ });
      } else delivered.push(peerId);
    } },
  });
  await engine.publish({ kind: 'chat', destination: '*', payload: { text: 'Do not block everyone' } });
  engine.setConnectedPeers(['unresponsive', 'ready']);
  await engine.flush();
  assert.equal(interrupted?.aborted, true);
  assert.deepEqual(delivered, ['ready']);
  assert.equal(events.filter(event => event.type === 'retry-scheduled').length, 1);
});

test('stop interrupts active sends without deleting their durable work and restart resumes them', async t => {
  const began = deferred();
  let firstAttempt = true;
  let signal: AbortSignal | undefined;
  let successful = 0;
  const { engine, store } = await fixture(t, {
    transport: { async send(_peerId, _packet, cancellation) {
      if (firstAttempt) {
        firstAttempt = false;
        signal = cancellation;
        began.resolve();
        await new Promise<void>(() => {});
      } else successful += 1;
    } },
  });
  await engine.publish({ kind: 'sos', payload: { text: 'Resume me' } });
  engine.setConnectedPeers(['bob']);
  await began.promise;
  await engine.stop();
  assert.equal(signal?.aborted, true);
  assert.ok(await store.getNextDelivery(['bob'], 1_000, false, 256));
  await Promise.all([engine.start(), engine.start()]);
  await engine.flush();
  assert.equal(successful, 1);
});

test('storage errors are surfaced and never treated as hop ACKs', async t => {
  const { engine, store, sent, events } = await fixture(t);
  const acknowledge = store.markAcknowledged.bind(store);
  let fail = true;
  store.markAcknowledged = async (...args) => {
    if (fail) { fail = false; throw new Error('disk write failed'); }
    await acknowledge(...args);
  };
  engine.subscribe(() => { throw new Error('broken UI observer'); });
  engine.subscribe(async () => { throw new Error('broken asynchronous UI observer'); });
  await engine.publish({ kind: 'chat', destination: '*', payload: { text: 'Persist ACK' } });
  engine.setConnectedPeers(['bob']);
  await engine.flush();
  assert.equal(sent.length, 1);
  assert.equal(events.filter(event => event.type === 'error').length, 1);
  assert.equal(events.filter(event => event.type === 'hop-acknowledged').length, 0);
  await engine.flush();
  assert.equal(sent.length, 2);
  assert.equal(events.filter(event => event.type === 'hop-acknowledged').length, 1);
});

test('expired queues do not send, dedup remains live, and sender clock skew cannot prolong retention', async t => {
  const { engine, time, sent } = await fixture(t, {
    config: { messageRetentionMs: 100, dedupRetentionMs: 200, maintenanceIntervalMs: 50 },
  });
  const message = createMessage({ kind: 'sos', payload: { text: 'Skewed sender clock' } }, randomUUID(), 'origin', 9_000_000);
  await engine.receive('previous', message);
  time.value = 1_100;
  engine.setConnectedPeers(['fresh']);
  await engine.flush();
  assert.equal(sent.length, 0);
  assert.equal((await engine.history()).length, 0);
  assert.equal((await engine.receive('previous', message)).status, 'duplicate');
  time.value = 1_200;
  assert.equal((await engine.receive('previous', message)).status, 'accepted');
});

test('malformed packets and capacity rejection are explicit and do not emit accepted events', async t => {
  const { engine, events } = await fixture(t, {
    config: { maxMessages: 2, reservedEmergencyMessages: 1 },
  });
  assert.equal((await engine.receive('previous', { ttl: 15 })).status, 'invalid');
  const message = createMessage({ kind: 'chat', destination: '*', payload: { text: 'Loop' } }, randomUUID(), 'alice', 1);
  assert.equal((await engine.receive('alice', message)).status, 'invalid');
  assert.equal((await engine.receive('previous', message)).status, 'invalid');
  assert.equal((await engine.publish({ kind: 'chat', destination: '*', payload: { text: 'First' } })).status, 'accepted');
  assert.deepEqual(await engine.publish({ kind: 'chat', destination: '*', payload: { text: 'Full' } }), { status: 'full', resource: 'messages' });
  assert.equal((await engine.publish({ kind: 'sos', payload: { text: 'Reserved slot' } })).status, 'accepted');
  assert.equal(events.filter(event => event.type === 'accepted').length, 2);
  assert.equal(events.filter(event => event.type === 'rejected').length, 4);
  assert.throws(() => engine.setConnectedPeers(['bad peer']), /Invalid peer/);
  assert.throws(() => engine.setConnectedPeers(Array.from({ length: 65 }, (_, index) => `peer-${index}`)), /Too many/);
});

test('configuration rejects unsafe limits and lifecycle rejects work before start', async () => {
  const database = createTestStore();
  const options = { deviceId: 'alice', store: database.store, transport: { async send() {} }, ids: { next: randomUUID } };
  try {
    assert.throws(() => new DtnEngine({ ...options, config: { dedupRetentionMs: 1 } }), /Inconsistent/);
    assert.throws(() => new DtnEngine({ ...options, config: { maxPeersPerMessage: 4_097 } }), /Inconsistent/);
    assert.throws(() => new DtnEngine({ ...options, config: { maxSendsPerTurn: 0 } }), /Invalid/);
    const engine = new DtnEngine(options);
    await assert.rejects(engine.publish({ kind: 'sos', payload: { text: 'Not started' } }), /Start/);
    const incoming = createMessage({ kind: 'sos', payload: { text: 'Not started' } }, randomUUID(), 'bob', 1);
    await assert.rejects(engine.receive('bob', forNextHop(incoming)), /Start/);
    await engine.stop();
  } finally { database.close(); }
});

test('bounded batches yield the JS thread and flush still waits for all ready deliveries', async t => {
  const { engine, sent } = await fixture(t, { config: { maxSendsPerTurn: 1 } });
  await engine.publish({ kind: 'sos', payload: { text: 'Everyone in bounded batches' } });
  engine.setConnectedPeers(['one', 'two', 'three']);
  let timerRan = false;
  setTimeout(() => { timerRan = true; }, 0);
  await engine.flush();
  assert.deepEqual(sent.map(item => item.peerId), ['one', 'two', 'three']);
  assert.equal(timerRan, true);
});

test('backoff automatically wakes and retries without another peer or message event', { timeout: 2_000 }, async t => {
  const acknowledged = deferred();
  let attempts = 0;
  // Use real wall time to exercise the actual scheduling path (other tests
  // advance a fake clock and flush explicitly for deterministic boundary checks).
  const { engine } = await fixture(t, {
    clock: { now: () => Date.now() },
    config: { retryBaseMs: 10, retryMaxMs: 100 },
    transport: { async send() {
      attempts += 1;
      if (attempts === 1) throw new Error('temporary disconnect');
    } },
  });
  engine.subscribe(event => { if (event.type === 'hop-acknowledged') acknowledged.resolve(); });
  await engine.publish({ kind: 'sos', payload: { text: 'Automatic retry' } });
  engine.setConnectedPeers(['bob']);
  await acknowledged.promise;
  assert.equal(attempts, 2);
});

test('a cyclic mesh converges to one stored UUID per device without packet loops', async t => {
  const nodes = new Map<string, DtnEngine>();
  let transmissions = 0;
  for (const deviceId of ['alice', 'bob', 'carol', 'david']) {
    const node = await fixture(t, {
      deviceId,
      transport: { async send(peerId, packet) {
        transmissions += 1;
        const receiver = nodes.get(peerId);
        assert.ok(receiver);
        const result = await receiver.receive(deviceId, packet);
        assert.ok(result.status === 'accepted' || result.status === 'duplicate');
      } },
    });
    nodes.set(deviceId, node.engine);
  }
  for (const node of nodes.values()) node.setConnectedPeers([...nodes.keys()]);
  const origin = nodes.get('alice');
  assert.ok(origin);
  await origin.publish({ kind: 'sos', payload: { text: 'Dense cyclic network' } });
  // Each asynchronous receive can wake another engine after its previous flush.
  for (let round = 0; round < nodes.size; round += 1) {
    await Promise.all([...nodes.values()].map(node => node.flush()));
  }
  for (const node of nodes.values()) assert.equal((await node.history()).length, 1);
  // Four devices, excluding origin echoes: each directed edge at most once.
  assert.ok(transmissions >= 3 && transmissions <= 9, `unexpected transmissions: ${transmissions}`);
  const settled = transmissions;
  for (const node of nodes.values()) {
    node.setConnectedPeers([]);
    node.setConnectedPeers([...nodes.keys()]);
  }
  await Promise.all([...nodes.values()].map(node => node.flush()));
  assert.equal(transmissions, settled);
});
