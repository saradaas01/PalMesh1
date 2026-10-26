import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { createMessage } from '../src/features/dtn/domain/validation';
import type { IdGenerator } from '../src/features/dtn/domain/ports';
import type { ReceiveResult } from '../src/features/dtn/domain/types';
import { MeshCoordinator, type MeshConfig } from '../src/features/mesh/application/MeshCoordinator';
import { createMeshNode } from '../src/features/mesh/application/createMeshNode';
import { encodeFrame, FrameDecoder } from '../src/features/mesh/domain/wire';
import type { MeshEvent, MeshReceiver, RadioKind, WireFrame } from '../src/features/mesh/domain/types';
import { SqlitePeerRegistry } from '../src/features/mesh/infrastructure/SqlitePeerRegistry';
import { TestRadio } from './helpers/radio';
import { createTestStore, TestSqliteDatabase } from './helpers/sqlite';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function until(predicate: () => boolean, description = 'condition', timeout = 2_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise<void>(resolve => { setTimeout(resolve, 1); });
  }
}

const fastConfig: Partial<MeshConfig> = {
  handshakeTimeoutMs: 250, connectTimeoutMs: 100, writeTimeoutMs: 250,
  ackTimeoutMs: 30, discoveryRetryBaseMs: 100, discoveryRetryMaxMs: 500,
  maintenanceIntervalMs: 50,
};

async function fixture(t: TestContext, deviceId: string, network: Map<string, TestRadio>, options: {
  kinds?: readonly RadioKind[];
  receiver?: MeshReceiver;
  config?: Partial<MeshConfig>;
  ids?: IdGenerator;
  clock?: { now(): number };
} = {}) {
  const database = new TestSqliteDatabase();
  const registry = new SqlitePeerRegistry(database);
  const radios = (options.kinds ?? ['wifi-direct', 'ble']).map(kind => new TestRadio(kind, `address-${deviceId}`, network));
  const events: MeshEvent[] = [];
  const received: { peerId: string; id: string }[] = [];
  const peers: string[][] = [];
  const receiver: MeshReceiver = options.receiver ?? {
    async receive(peerId, packet) { received.push({ peerId, id: packet.id }); return { status: 'duplicate' }; },
    setConnectedPeers(ids) { peers.push([...ids]); },
  };
  const mesh = new MeshCoordinator({
    deviceId, radios, registry, ids: options.ids ?? { next: randomUUID },
    ...(options.clock ? { clock: options.clock } : {}), config: { ...fastConfig, ...options.config },
  });
  mesh.bindReceiver(receiver);
  mesh.subscribe(event => { events.push(event); });
  t.after(async () => { await mesh.stop(); database.close(); });
  await mesh.start();
  return { mesh, radios, registry, received, peers, events };
}

async function connect(a: Awaited<ReturnType<typeof fixture>>, b: Awaited<ReturnType<typeof fixture>>, kinds: readonly RadioKind[] = ['wifi-direct', 'ble']) {
  for (const kind of kinds) a.radios.find(radio => radio.kind === kind)?.discover(b.radios[0]!.address);
  await until(() => kinds.every(kind => a.events.some(event => event.type === 'peer-ready' && event.radio === kind)
    && b.events.some(event => event.type === 'peer-ready' && event.radio === kind)), 'both handshake sides');
}

function packet() {
  return createMessage({ kind: 'chat', destination: 'bob', payload: { text: 'رسالة بلا إنترنت 👋' } }, randomUUID(), 'alice', Date.now());
}

test('discovery handshakes stable device IDs on both radios and prefers Wi-Fi for durable sends', async t => {
  const network = new Map<string, TestRadio>();
  const alice = await fixture(t, 'alice', network);
  const bob = await fixture(t, 'bob', network);
  await connect(alice, bob);
  assert.deepEqual(alice.mesh.connectedPeers(), ['bob']);
  assert.deepEqual(bob.mesh.connectedPeers(), ['alice']);
  assert.equal((await alice.registry.recentPeers(10))[0]?.peerId, 'bob');
  assert.deepEqual((await alice.registry.recentPeers(10))[0]?.radios, ['wifi-direct', 'ble']);
  const ble = alice.radios.find(radio => radio.kind === 'ble')!;
  const bleWritesBeforeSend = ble.writes.length;
  const message = packet();
  await alice.mesh.send('bob', message, new AbortController().signal);
  assert.deepEqual(bob.received, [{ peerId: 'alice', id: message.id }]);
  const wifi = alice.radios.find(radio => radio.kind === 'wifi-direct')!;
  assert.ok(wifi.writes.length > 2);
  assert.equal(ble.writes.length, bleWritesBeforeSend);
});

test('socket writes never resolve a send before the receiving store commits', async t => {
  const network = new Map<string, TestRadio>();
  const commit = deferred<ReceiveResult>();
  let entered = false;
  const bob = await fixture(t, 'bob', network, {
    kinds: ['wifi-direct'],
    receiver: { async receive() { entered = true; return commit.promise; }, setConnectedPeers() {} },
  });
  const alice = await fixture(t, 'alice', network, { kinds: ['wifi-direct'], config: { ackTimeoutMs: 250 } });
  await connect(alice, bob, ['wifi-direct']);
  let settled = false;
  const delivery = alice.mesh.send('bob', packet(), new AbortController().signal).then(() => { settled = true; });
  await until(() => entered, 'receive before commit');
  assert.equal(settled, false);
  commit.resolve({ status: 'duplicate' });
  await delivery;
  assert.equal(settled, true);
});

test('a lost Wi-Fi ACK falls back over BLE using the same message UUID', async t => {
  const network = new Map<string, TestRadio>();
  const alice = await fixture(t, 'alice', network);
  const bob = await fixture(t, 'bob', network);
  await connect(alice, bob);
  bob.radios.find(radio => radio.kind === 'wifi-direct')!.dropWrites = true;
  const message = packet();
  await alice.mesh.send('bob', message, new AbortController().signal);
  assert.deepEqual(bob.received.map(entry => entry.id), [message.id, message.id]);
  assert.ok(alice.events.some(event => event.type === 'fallback' && event.from === 'wifi-direct' && event.to === 'ble'));
  assert.deepEqual(alice.mesh.connectedPeers(), ['bob']);
});

test('storage capacity and exceptions produce a negative response instead of custody ACK', async t => {
  for (const mode of ['full', 'throws'] as const) {
    const network = new Map<string, TestRadio>();
    const bob = await fixture(t, `bob-${mode}`, network, {
      kinds: ['wifi-direct'],
      receiver: {
        async receive() {
          if (mode === 'throws') throw new Error('storage unavailable');
          return { status: 'full', resource: 'messages' };
        },
        setConnectedPeers() {},
      },
    });
    const alice = await fixture(t, `alice-${mode}`, network, { kinds: ['wifi-direct'] });
    await connect(alice, bob, ['wifi-direct']);
    await assert.rejects(alice.mesh.send(`bob-${mode}`, packet(), new AbortController().signal), /did not accept packet/);
    assert.deepEqual(alice.mesh.connectedPeers(), [`bob-${mode}`]);
    assert.equal(alice.events.some(event => event.type === 'fallback'), false);
  }
});

test('BLE framing reassembles arbitrary fragmented Arabic and emoji bytes', async t => {
  const network = new Map<string, TestRadio>();
  const alice = await fixture(t, 'alice', network, { kinds: ['ble'] });
  const bob = await fixture(t, 'bob', network, { kinds: ['ble'] });
  alice.radios[0]!.fragmentBytes = 1;
  bob.radios[0]!.fragmentBytes = 3;
  await connect(alice, bob, ['ble']);
  const message = packet();
  await alice.mesh.send('bob', message, new AbortController().signal);
  assert.equal(bob.received[0]?.id, message.id);
  assert.ok(alice.radios[0]!.writes.every(write => write.bytes.length <= 64));
});

test('pre-handshake packets and malformed length prefixes never reach DTN', async t => {
  const network = new Map<string, TestRadio>();
  const node = await fixture(t, 'alice', network, { kinds: ['wifi-direct'] });
  const radio = node.radios[0]!;
  radio.emit({ type: 'connected', link: { id: 'malicious', endpointId: 'unknown', maxChunkBytes: 4_096 } });
  radio.emit({ type: 'data', linkId: 'malicious', bytes: encodeFrame({
    v: 1, type: 'packet', session: randomUUID(), transferId: randomUUID(), packet: packet(),
  }) });
  assert.equal(node.received.length, 0);
  assert.deepEqual(node.mesh.connectedPeers(), []);
  radio.emit({ type: 'connected', link: { id: 'oversized', endpointId: 'unknown', maxChunkBytes: 4_096 } });
  radio.emit({ type: 'data', linkId: 'oversized', bytes: Uint8Array.of(127, 255, 255, 255) });
  assert.equal(node.received.length, 0);
});

test('peer loss removes the DTN peer; stop cancels a pending durable ACK and ignores late storage completion', async t => {
  const network = new Map<string, TestRadio>();
  const commit = deferred<ReceiveResult>();
  let entered = false;
  const bob = await fixture(t, 'bob', network, {
    kinds: ['wifi-direct'], receiver: {
      async receive() { entered = true; return commit.promise; }, setConnectedPeers() {},
    },
  });
  const alice = await fixture(t, 'alice', network, { kinds: ['wifi-direct'], config: { ackTimeoutMs: 250 } });
  await connect(alice, bob, ['wifi-direct']);
  const result = alice.mesh.send('bob', packet(), new AbortController().signal);
  const rejected = assert.rejects(result);
  await until(() => entered, 'pending storage');
  await bob.mesh.stop();
  commit.resolve({ status: 'duplicate' });
  await rejected;
  assert.deepEqual(alice.mesh.connectedPeers(), []);
  await bob.mesh.start();
  assert.deepEqual(bob.mesh.connectedPeers(), []);
});

test('unavailable radios retain local queuing and refresh after permissions are granted', async t => {
  const network = new Map<string, TestRadio>();
  const database = new TestSqliteDatabase();
  const registry = new SqlitePeerRegistry(database);
  const radio = new TestRadio('wifi-direct', 'address-alice', network);
  radio.available = { available: false, reason: 'permission-denied' };
  const mesh = new MeshCoordinator({ deviceId: 'alice', radios: [radio], registry, ids: { next: randomUUID }, config: fastConfig });
  mesh.bindReceiver({ async receive() { return { status: 'duplicate' }; }, setConnectedPeers() {} });
  t.after(async () => { await mesh.stop(); database.close(); });
  await mesh.start();
  assert.equal(radio.started, false);
  assert.equal(mesh.radioStatuses().get('wifi-direct')?.reason, 'permission-denied');
  radio.available = { available: true };
  await mesh.refreshRadios();
  assert.equal(radio.started, true);
});

test('DTN + discovery + framing + SQLite custody work end-to-end, including lost ACK fallback', async t => {
  const network = new Map<string, TestRadio>();
  const nodes: ReturnType<typeof createMeshNode>[] = [];
  const radioSets: TestRadio[][] = [];
  for (const deviceId of ['alice', 'bob']) {
    const store = createTestStore();
    const peers = new TestSqliteDatabase();
    const radios = (['wifi-direct', 'ble'] as const).map(kind => new TestRadio(kind, `address-${deviceId}`, network));
    const node = createMeshNode({
      deviceId, store: store.store, registry: new SqlitePeerRegistry(peers), radios,
      ids: { next: randomUUID }, meshConfig: fastConfig,
    });
    nodes.push(node);
    radioSets.push(radios);
    t.after(async () => { await node.stop(); store.close(); peers.close(); });
    await node.start();
  }
  const alice = nodes[0]!;
  const bob = nodes[1]!;
  const queued = await alice.engine.publish({ kind: 'sos', payload: { text: 'أحتاج إلى مساعدة' } });
  assert.equal(queued.status, 'accepted');
  // First establish BLE, so fallback remains possible when Wi-Fi disconnects.
  radioSets[0]![1]!.discover('address-bob');
  await until(() => alice.mesh.connectedPeers().includes('bob'), 'DTN peer readiness');
  await alice.engine.flush();
  await until(() => bob.mesh.connectedPeers().includes('alice'), 'remote readiness');
  assert.equal((await bob.engine.history()).length, 1);
  assert.equal((await bob.engine.history())[0]?.message.ttl, 14);
  radioSets[0]![0]!.discover('address-bob');
  await until(() => radioSets[1]![0]!.writes.length >= 2, 'Wi-Fi handshake');
  // Wait for native handshakes to be processed before dropping Wi-Fi ACKs.
  await new Promise<void>(resolve => { setTimeout(resolve, 5); });
  radioSets[1]![0]!.dropWrites = true;
  await alice.engine.publish({ kind: 'chat', destination: 'bob', payload: { text: 'One stored copy after fallback' } });
  await alice.engine.flush();
  const history = await bob.engine.history();
  assert.equal(history.length, 2);
  assert.equal(history.filter(record => record.message.kind === 'chat').length, 1);
});

test('runtime rejects deadline or packet budgets that cannot support fallback', () => {
  const database = createTestStore();
  const peers = new TestSqliteDatabase();
  try {
    const options = {
      deviceId: 'alice', store: database.store, registry: new SqlitePeerRegistry(peers), ids: { next: randomUUID },
      radios: [new TestRadio('ble', 'address-alice', new Map())],
    };
    assert.throws(() => createMeshNode({ ...options, dtnConfig: { sendTimeoutMs: 1 } }), /cover/);
    assert.throws(() => createMeshNode({ ...options, dtnConfig: { maxPacketBytes: 32_768 } }), /budget/);
  } finally { database.close(); peers.close(); }
});

test('local pending-capacity rejection preserves the healthy link and existing deliveries', async t => {
  const network = new Map<string, TestRadio>();
  const commit = deferred<ReceiveResult>();
  let entered = 0;
  const bob = await fixture(t, 'bob', network, {
    kinds: ['wifi-direct'],
    receiver: { async receive() { entered += 1; return commit.promise; }, setConnectedPeers() {} },
  });
  const alice = await fixture(t, 'alice', network, {
    kinds: ['wifi-direct'], config: { maxPendingPerLink: 2, ackTimeoutMs: 250 },
  });
  await connect(alice, bob, ['wifi-direct']);
  const first = alice.mesh.send('bob', packet(), new AbortController().signal);
  const second = alice.mesh.send('bob', packet(), new AbortController().signal);
  await until(() => entered === 2, 'two retained pending transfers');
  await assert.rejects(alice.mesh.send('bob', packet(), new AbortController().signal), /capacity/);
  assert.deepEqual(alice.mesh.connectedPeers(), ['bob']);
  commit.resolve({ status: 'duplicate' });
  await Promise.all([first, second]);
  assert.deepEqual(alice.mesh.connectedPeers(), ['bob']);
});

test('immediate and mid-start stop cancel startup rather than waiting for a hung native radio', async t => {
  const network = new Map<string, TestRadio>();
  const fixtureNode = await fixture(t, 'alice', network, { kinds: ['wifi-direct'] });
  await fixtureNode.mesh.stop();
  const radio = fixtureNode.radios[0]!;
  let starts = 0;
  radio.start = async () => { starts += 1; await new Promise<void>(() => {}); };
  const immediate = fixtureNode.mesh.start();
  await fixtureNode.mesh.stop();
  await immediate;
  assert.equal(starts, 0);
  const entered = deferred();
  radio.start = async signal => {
    starts += 1;
    entered.resolve();
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => { reject(new Error('native startup aborted')); }, { once: true });
    });
  };
  const pending = fixtureNode.mesh.start();
  await entered.promise;
  await fixtureNode.mesh.stop();
  await pending;
  assert.equal(starts, 1);
});

test('one-shot discovery still reconnects a previously live endpoint after its original advertisement expires', async t => {
  const network = new Map<string, TestRadio>();
  const time = { value: 1_000 };
  const alice = await fixture(t, 'alice', network, {
    kinds: ['wifi-direct'], clock: { now: () => time.value },
    config: { endpointExpiryMs: 100, discoveryRetryBaseMs: 5, maintenanceIntervalMs: 5 },
  });
  const bob = await fixture(t, 'bob', network, { kinds: ['wifi-direct'] });
  await connect(alice, bob, ['wifi-direct']);
  time.value += 1_000;
  await alice.radios[0]!.disconnect(alice.radios[0]!.connected[0]!);
  assert.deepEqual(alice.mesh.connectedPeers(), []);
  time.value += 10;
  await until(() => alice.mesh.connectedPeers().includes('bob'), 'reconnect after one-shot discovery');
  assert.equal(alice.radios[0]!.connectCalls, 2);
});

test('replacing a duplicate radio session never publishes a false peer loss', async t => {
  const network = new Map<string, TestRadio>();
  const decreasingIds = (start: number): IdGenerator => ({ next: () => `00000000-0000-4000-8000-${(start--).toString(16).padStart(12, '0')}` });
  const alice = await fixture(t, 'alice', network, { kinds: ['wifi-direct'], ids: decreasingIds(1_000) });
  const bob = await fixture(t, 'bob', network, { kinds: ['wifi-direct'], ids: decreasingIds(2_000) });
  await connect(alice, bob, ['wifi-direct']);
  await alice.radios[0]!.connect('address-bob', new AbortController().signal);
  await until(() => alice.events.filter(event => event.type === 'peer-ready').length === 2, 'preferred replacement session');
  assert.deepEqual(alice.peers, [['bob']]);
  assert.deepEqual(bob.peers, [['alice']]);
});

test('ACK correlation requires matching session, transfer UUID, and message UUID', async t => {
  const network = new Map<string, TestRadio>();
  const alice = await fixture(t, 'alice', network, { kinds: ['wifi-direct'], config: { ackTimeoutMs: 250 } });
  const remote = new TestRadio('wifi-direct', 'address-remote', network);
  await remote.start(new AbortController().signal);
  t.after(() => remote.stop());
  alice.radios[0]!.discover('address-remote');
  const decodeWrites = (): readonly WireFrame[] => {
    const decoder = new FrameDecoder();
    return alice.radios[0]!.writes.flatMap(write => [...decoder.push(write.bytes)]);
  };
  await until(() => decodeWrites().some(frame => frame.type === 'hello'), 'local hello');
  const hello = decodeWrites().find(frame => frame.type === 'hello');
  assert.ok(hello?.type === 'hello');
  const remoteNonce = randomUUID();
  const reply = (frame: WireFrame) => remote.write(remote.connected[0]!, encodeFrame(frame), new AbortController().signal);
  await reply({ v: 1, type: 'hello', peerId: 'bob', nonce: remoteNonce });
  await reply({ v: 1, type: 'hello-ack', peerId: 'bob', nonce: remoteNonce, echo: hello.nonce });
  await reply({ v: 1, type: 'ready', session: hello.nonce });
  await until(() => alice.mesh.connectedPeers().includes('bob'), 'manual handshake');
  let complete = false;
  const delivery = alice.mesh.send('bob', packet(), new AbortController().signal).then(() => { complete = true; });
  await until(() => decodeWrites().some(frame => frame.type === 'packet'), 'outbound transfer');
  const transfer = decodeWrites().find(frame => frame.type === 'packet');
  assert.ok(transfer?.type === 'packet');
  await reply({ v: 1, type: 'ack', session: hello.nonce, transferId: transfer.transferId, messageId: randomUUID() });
  await reply({ v: 1, type: 'ack', session: hello.nonce, transferId: randomUUID(), messageId: transfer.packet.id });
  assert.equal(complete, false);
  await reply({ v: 1, type: 'ack', session: hello.nonce, transferId: transfer.transferId, messageId: transfer.packet.id });
  await delivery;
  assert.equal(complete, true);
});

test('node runtime stop invalidates queued startup and aborts an active native startup', async t => {
  const messages = createTestStore();
  const peers = new TestSqliteDatabase();
  const radio = new TestRadio('wifi-direct', 'address-alice', new Map());
  let nativeStarts = 0;
  const entered = deferred();
  radio.start = async signal => {
    nativeStarts += 1;
    entered.resolve();
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => { reject(new Error('native startup cancelled')); }, { once: true });
    });
  };
  const node = createMeshNode({
    deviceId: 'alice', store: messages.store, registry: new SqlitePeerRegistry(peers),
    radios: [radio], ids: { next: randomUUID }, meshConfig: fastConfig,
  });
  t.after(async () => { await node.stop(); messages.close(); peers.close(); });
  const queued = node.start();
  await node.stop();
  await queued;
  assert.equal(nativeStarts, 0);
  const starting = node.start();
  await entered.promise;
  await node.stop();
  await starting;
  assert.equal(nativeStarts, 1);
  await assert.rejects(node.engine.publish({ kind: 'sos', payload: { text: 'Stopped runtime' } }), /Start/);
});

test('a bounded hello retransmission recovers a fully lost initial handshake frame', async t => {
  const network = new Map<string, TestRadio>();
  const alice = await fixture(t, 'alice', network, {
    kinds: ['ble'], config: { handshakeRetryMs: 5, maxHelloAttempts: 3, handshakeTimeoutMs: 100 },
  });
  const bob = await fixture(t, 'bob', network, {
    kinds: ['ble'], config: { handshakeRetryMs: 5, maxHelloAttempts: 3, handshakeTimeoutMs: 100 },
  });
  // Drop the entire hello, reproducing a notification sent before a platform's
  // monitor was ready. Reliable-stream byte corruption instead closes the link.
  const radio = alice.radios[0]!;
  const originalWrite = radio.write.bind(radio);
  let bytesToDrop: number | undefined;
  radio.write = async (linkId, bytes, signal) => {
    if (bytesToDrop === undefined) {
      bytesToDrop = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false) + 4;
    }
    if (bytesToDrop > 0) { bytesToDrop -= bytes.length; return; }
    await originalWrite(linkId, bytes, signal);
  };
  await connect(alice, bob, ['ble']);
  assert.deepEqual(alice.mesh.connectedPeers(), ['bob']);
  await alice.mesh.send('bob', packet(), new AbortController().signal);
  assert.equal(bob.received.length, 1);
});

test('inactive radio power recovery reconnects without resume and preserves the healthy BLE path', async t => {
  const network = new Map<string, TestRadio>();
  const alice = await fixture(t, 'alice', network, { config: { discoveryRetryBaseMs: 15, discoveryRetryMaxMs: 60, maintenanceIntervalMs: 5 } });
  const bob = await fixture(t, 'bob', network, { config: { discoveryRetryBaseMs: 15, discoveryRetryMaxMs: 60, maintenanceIntervalMs: 5 } });
  await connect(alice, bob);
  const wifi = alice.radios.find(radio => radio.kind === 'wifi-direct')!;
  const ble = alice.radios.find(radio => radio.kind === 'ble')!;
  const start = wifi.start.bind(wifi); let starts = 0;
  wifi.start = async signal => { starts++; await start(signal); };
  wifi.available = { available: false, reason: 'powered-off' };
  wifi.emit({ type: 'status', status: wifi.available });
  await wifi.stop();
  await alice.mesh.send('bob', packet(), new AbortController().signal);
  assert.ok(ble.started);
  assert.deepEqual(alice.mesh.connectedPeers(), ['bob']);
  wifi.available = { available: true }; // No event: native teardown removed its listener.
  await until(() => starts === 1 && wifi.started, 'automatic radio restart');
  await until(() => alice.events.filter(event => event.type === 'peer-ready' && event.radio === 'wifi-direct').length >= 2, 'Wi-Fi handshake after recovery');
  assert.deepEqual(alice.mesh.connectedPeers(), ['bob']);
  const before = bob.received.length;
  await alice.mesh.send('bob', packet(), new AbortController().signal);
  assert.equal(bob.received.length, before + 1);
});

test('inactive radio polling backs off, coalesces slow starts and stops after shutdown', async t => {
  const network = new Map<string, TestRadio>();
  const database = new TestSqliteDatabase();
  const radio = new TestRadio('wifi-direct', 'address-alice', network);
  let checks = 0; let starts = 0;
  radio.available = { available: false, reason: 'permission-denied' };
  const getStatus = radio.getStatus.bind(radio);
  radio.getStatus = async () => { checks++; return getStatus(); };
  const mesh = new MeshCoordinator({ deviceId: 'alice', radios: [radio], registry: new SqlitePeerRegistry(database), ids: { next: randomUUID },
    config: { ...fastConfig, discoveryRetryBaseMs: 20, discoveryRetryMaxMs: 80, maintenanceIntervalMs: 5 } });
  mesh.bindReceiver({ async receive() { return { status: 'duplicate' }; }, setConnectedPeers() {} });
  const gate = deferred();
  radio.start = async signal => { starts++; await gate.promise; if (!signal.aborted) radio.started = true; };
  t.after(async () => { gate.resolve(); await mesh.stop(); database.close(); });
  await mesh.start();
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.ok(checks >= 2 && checks <= 4, `bounded checks: ${checks}`);
  radio.available = { available: true };
  await until(() => starts === 1, 'delayed radio start');
  const refresh = mesh.refreshRadios();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(starts, 1);
  gate.resolve(); await refresh;
  assert.equal(radio.started, true);
  await mesh.stop();
  const stoppedChecks = checks;
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(checks, stoppedChecks);
  assert.equal(radio.started, false);
});
