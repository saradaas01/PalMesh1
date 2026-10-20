import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { ChatService } from '../src/features/chat/application/ChatService';
import type { ChatRepository } from '../src/features/chat/domain/ports';
import { deliveryState } from '../src/features/chat/domain/messages';
import { SqliteChatRepository } from '../src/features/chat/infrastructure/SqliteChatRepository';
import { DtnEngine } from '../src/features/dtn/application/DtnEngine';
import type { AcceptResult } from '../src/features/dtn/domain/types';
import { SqliteDtnStore } from '../src/features/dtn/infrastructure/sqlite/SqliteDtnStore';
import { ControlledChatEngine, ControlledChatMesh, deferred, stored, until, wrapRepository } from './helpers/chat';
import { TestSqliteDatabase } from './helpers/sqlite';

function fixture(t: TestContext, options: {
  engine?: ControlledChatEngine;
  wrap?: (repository: ChatRepository) => ChatRepository;
  mesh?: ControlledChatMesh;
  pageSize?: number;
} = {}) {
  const database = new TestSqliteDatabase();
  const archive = new SqliteChatRepository(database);
  const repository = options.wrap?.(archive) ?? archive;
  const engine = options.engine ?? new ControlledChatEngine();
  const time = { value: 1_000 };
  const service = new ChatService({
    engine, repository, clock: { now: () => time.value },
    ...(options.mesh ? { mesh: options.mesh } : {}),
    ...(options.pageSize ? { pageSize: options.pageSize } : {}),
  });
  t.after(async () => { await service.stop(); database.close(); });
  return { service, archive, engine, time };
}

function texts(service: ChatService): readonly string[] { return service.getSnapshot().messages.map(message => message.text); }

// This race models the routing database finishing its snapshot after a new
// receive and a custody ACK have already reached the subscribed application.
test('subscribes before rehydration and does not lose intervening messages or downgrade custody', { timeout: 5_000 }, async t => {
  const engine = new ControlledChatEngine();
  const original = stored({ kind: 'chat', destination: 'bob', payload: { text: 'Before snapshot' } });
  const entered = deferred();
  const release = deferred();
  engine.records = [{ ...original, peerStored: false }];
  engine.readHistory = async () => { entered.resolve(); await release.promise; return [{ ...original, peerStored: false }]; };
  t.after(() => release.resolve());
  const { service } = fixture(t, { engine });
  const starting = service.start();
  await entered.promise;
  assert.equal(engine.listeners.size, 1);
  engine.incoming('During snapshot');
  engine.emit({ type: 'hop-acknowledged', messageId: original.message.id, peerId: 'carrier' });
  release.resolve();
  await starting;
  await until(() => service.getSnapshot().conversations.length === 1, 'conversation rehydration');
  await service.openConversation('bob');
  assert.deepEqual(texts(service), ['Before snapshot', 'During snapshot']);
  assert.equal(service.getSnapshot().messages[0]?.peerStored, true);
  // An older repeat routing snapshot must preserve the archive's known ACK.
  await service.refresh();
  assert.equal(service.getSnapshot().messages[0]?.peerStored, true);
});

test('keeps forwarded unicast for others and standalone location packets out of chat', async t => {
  const { service, engine } = fixture(t);
  await service.start();
  engine.incoming('For another device', 'bob', 'carol');
  const location = stored({ kind: 'location', payload: { location: { latitude: 31.5, longitude: 34.4, timestamp: 1_000 } } }, 'bob');
  engine.emit({ type: 'accepted', record: location, local: false });
  engine.incoming('For this device', 'bob');
  engine.incoming('Nearby broadcast', 'carol', '*');
  await until(() => service.getSnapshot().conversations.length === 2);
  await service.openConversation('bob');
  assert.deepEqual(texts(service), ['For this device']);
  await service.openConversation('*');
  assert.deepEqual(texts(service), ['Nearby broadcast']);
  assert.equal(service.getSnapshot().conversations.some(conversation => conversation.id === 'carol'), false);
});

test('queues offline chat and 15-hop SOS durably, reopens history, and reports custody honestly', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'palmesh-chat-'));
  const path = join(directory, 'offline.sqlite');
  const time = { value: 1_000 };
  let database = new TestSqliteDatabase(path);
  const createRuntime = () => {
    const engine = new DtnEngine({
      deviceId: 'alice', store: new SqliteDtnStore(database), ids: { next: randomUUID },
      clock: { now: () => time.value }, transport: { async send() {} },
    });
    const service = new ChatService({ engine, repository: new SqliteChatRepository(database), clock: { now: () => time.value } });
    return { engine, service };
  };
  let { engine, service } = createRuntime();
  t.after(async () => { await service.stop(); await engine.stop(); database.close(); rmSync(directory, { recursive: true, force: true }); });
  await engine.start();
  await service.start();
  await service.openConversation('bob');
  service.setDraft('Queued without a connection');
  assert.equal((await service.send()).status, 'queued');
  assert.equal((await service.sendSos()).status, 'queued');
  await until(() => service.getSnapshot().conversations.length === 2);
  assert.equal(deliveryState(service.getSnapshot().messages[0]!, 'alice', time.value), 'queued');
  assert.equal((await engine.history()).find(record => record.message.kind === 'sos')?.message.ttl, 15);
  await service.stop(); await engine.stop(); database.close();

  database = new TestSqliteDatabase(path);
  ({ engine, service } = createRuntime());
  await engine.start(); await service.start(); await service.openConversation('bob');
  assert.deepEqual(texts(service), ['Queued without a connection']);
  assert.equal(deliveryState(service.getSnapshot().messages[0]!, 'alice', time.value), 'queued');
  engine.setConnectedPeers(['carrier']);
  await engine.flush();
  await until(() => service.getSnapshot().messages[0]?.peerStored === true, 'durable peer custody');
  assert.equal(deliveryState(service.getSnapshot().messages[0]!, 'alice', time.value), 'peer-stored');
  await service.openConversation('*');
  assert.equal(service.getSnapshot().messages[0]?.kind, 'sos');
  assert.equal(service.getSnapshot().notice, null);
});

test('retains drafts on a full routing queue and engine error', async t => {
  const { service, engine } = fixture(t);
  await service.start(); await service.openConversation('bob');
  service.setDraft('Do not lose this');
  engine.publishNext = async () => ({ status: 'full', resource: 'messages' });
  assert.deepEqual(await service.send(), { status: 'rejected', reason: 'capacity' });
  assert.equal(service.getSnapshot().draft, 'Do not lose this');
  assert.equal(service.getSnapshot().issue, 'queue-full');
  engine.publishNext = async () => { throw new Error('SQLite unavailable'); };
  assert.deepEqual(await service.send(), { status: 'rejected', reason: 'unavailable' });
  assert.equal(service.getSnapshot().draft, 'Do not lose this');
  assert.equal(service.getSnapshot().issue, 'send-unavailable');
  assert.equal(service.getSnapshot().pendingSend, false);
});

test('a completed send preserves newer typing and drafts in a later conversation', { timeout: 5_000 }, async t => {
  const commit = deferred<Exclude<AcceptResult, { status: 'duplicate' }>>();
  t.after(() => commit.resolve({ status: 'full', resource: 'messages' }));
  const { service, engine } = fixture(t);
  engine.publishNext = () => commit.promise;
  await service.start(); await service.openConversation('bob');
  service.setDraft('First draft');
  const sending = service.send();
  service.setDraft('New typing');
  await service.openConversation('carol');
  service.setDraft('Carol draft');
  commit.resolve({ status: 'accepted', record: stored({ kind: 'chat', destination: 'bob', payload: { text: 'First draft' } }) });
  assert.equal((await sending).status, 'queued');
  assert.equal(service.getSnapshot().draft, 'Carol draft');
  await service.openConversation('bob');
  assert.equal(service.getSnapshot().draft, 'New typing');
  assert.deepEqual(texts(service), ['First draft']);
});

test('busy guards prevent duplicate publication while chat and SOS commits are pending', { timeout: 5_000 }, async t => {
  const chatCommit = deferred<Exclude<AcceptResult, { status: 'duplicate' }>>();
  const sosCommit = deferred<Exclude<AcceptResult, { status: 'duplicate' }>>();
  t.after(() => { chatCommit.resolve({ status: 'full', resource: 'messages' }); sosCommit.resolve({ status: 'full', resource: 'messages' }); });
  const { service, engine } = fixture(t);
  await service.start(); await service.openConversation('bob'); service.setDraft('Only once');
  engine.publishNext = input => input.kind === 'sos' ? sosCommit.promise : chatCommit.promise;
  const sending = service.send();
  assert.deepEqual(await service.send(), { status: 'rejected', reason: 'busy' });
  const sos = service.sendSos();
  assert.deepEqual(await service.sendSos(), { status: 'rejected', reason: 'busy' });
  assert.equal(engine.publications.length, 2);
  chatCommit.resolve({ status: 'accepted', record: stored({ kind: 'chat', destination: 'bob', payload: { text: 'Only once' } }) });
  sosCommit.resolve({ status: 'accepted', record: stored({ kind: 'sos', payload: { text: 'I need help' } }) });
  await Promise.all([sending, sos]);
  assert.equal(service.getSnapshot().pendingSend, false);
  assert.equal(service.getSnapshot().pendingSos, false);
});

test('SOS remains available after chat archive initialization fails', async t => {
  const { service, engine } = fixture(t, { wrap: repository => wrapRepository(repository, {
    async initialize() { throw new Error('Archive database failed'); },
  }) });
  await service.start();
  assert.equal(service.getSnapshot().status, 'error');
  const result = await service.sendSos();
  assert.equal(result.status, 'queued');
  assert.equal(engine.publications[0]?.kind, 'sos');
  assert.equal(service.getSnapshot().notice?.kind, 'sos-queued');
});

test('SOS publication never waits for stalled archive initialization or pending archive writes', { timeout: 5_000 }, async t => {
  const initializeEntered = deferred(); const initializeRelease = deferred();
  const writeEntered = deferred(); const writeRelease = deferred();
  let blockWrite = false;
  t.after(() => { initializeRelease.resolve(); writeRelease.resolve(); });
  const { service, engine } = fixture(t, { wrap: repository => wrapRepository(repository, {
    async initialize() { initializeEntered.resolve(); await initializeRelease.promise; await repository.initialize(); },
    async upsert(entries, localId) { if (blockWrite) { writeEntered.resolve(); await writeRelease.promise; } await repository.upsert(entries, localId); },
  }) });
  const starting = service.start(); await initializeEntered.promise;
  assert.equal((await service.sendSos()).status, 'queued');
  assert.equal(engine.publications.length, 1);
  initializeRelease.resolve(); await starting; await service.refresh();
  blockWrite = true; engine.incoming('Stalled archive write'); await writeEntered.promise;
  assert.equal((await service.sendSos()).status, 'queued');
  assert.equal(engine.publications.length, 2);
  writeRelease.resolve();
  await until(() => service.getSnapshot().conversations.some(item => item.id === 'bob'));
});

test('refresh recovers archive errors and reconstructs messages from the routing authority', async t => {
  let fail = true;
  const { service, engine } = fixture(t, { wrap: repository => wrapRepository(repository, {
    async initialize() { if (fail) throw new Error('Temporary unavailable'); await repository.initialize(); },
  }) });
  engine.records = [{ ...stored({ kind: 'chat', destination: 'alice', payload: { text: 'Recovered' } }, 'bob'), peerStored: true }];
  await service.start();
  assert.equal(service.getSnapshot().issue, 'history-unavailable');
  fail = false; await service.refresh(); await service.openConversation('bob');
  assert.equal(service.getSnapshot().status, 'ready');
  assert.equal(service.getSnapshot().issue, null);
  assert.deepEqual(texts(service), ['Recovered']);
});

test('reacts to peer changes and detaches transport subscriptions when stopped', async t => {
  const mesh = new ControlledChatMesh();
  mesh.peers = ['bob'];
  const { service, engine } = fixture(t, { mesh });
  await service.start(); assert.deepEqual(service.getSnapshot().connectedPeers, ['bob']);
  mesh.update(['carol', 'carol', 'invalid peer']);
  assert.deepEqual(service.getSnapshot().connectedPeers, ['carol']);
  await service.stop(); assert.equal(mesh.listeners.size, 0); assert.equal(engine.listeners.size, 0);
  mesh.update(['david']); assert.deepEqual(service.getSnapshot().connectedPeers, ['carol']);
  await service.start(); assert.deepEqual(service.getSnapshot().connectedPeers, ['david']);
  assert.equal(mesh.listeners.size, 1); assert.equal(engine.listeners.size, 1);
});

test('counts unread using local sequence even when timestamps match and reads only the open thread', async t => {
  const { service, engine } = fixture(t);
  await service.start();
  engine.incoming('One', 'bob', 'alice', 1_000); engine.incoming('Two', 'bob', 'alice', 1_000);
  engine.incoming('Other thread', 'carol', 'alice', 1_000);
  await until(() => service.getSnapshot().conversations.find(item => item.id === 'bob')?.unreadCount === 2);
  await service.openConversation('bob');
  assert.equal(service.getSnapshot().conversations.find(item => item.id === 'bob')?.unreadCount, 0);
  assert.equal(service.getSnapshot().conversations.find(item => item.id === 'carol')?.unreadCount, 1);
  engine.incoming('While open', 'bob', 'alice', 1_000);
  await until(() => texts(service).length === 3);
  assert.equal(service.getSnapshot().conversations.find(item => item.id === 'bob')?.unreadCount, 0);
  service.closeConversation();
  engine.incoming('While closed', 'bob', 'alice', 1_000);
  await until(() => service.getSnapshot().conversations.find(item => item.id === 'bob')?.unreadCount === 1);
});

test('paginates the latest messages in stable local order and resets the page on navigation', async t => {
  const { service, engine } = fixture(t, { pageSize: 2 });
  for (let index = 1; index <= 5; index += 1) engine.incoming(`Message ${index}`);
  await service.start(); await service.openConversation('bob');
  assert.deepEqual(texts(service), ['Message 4', 'Message 5']);
  assert.equal(service.getSnapshot().hasOlderMessages, true);
  await service.loadOlder(); assert.deepEqual(texts(service), ['Message 2', 'Message 3', 'Message 4', 'Message 5']);
  await service.loadOlder(); assert.deepEqual(texts(service), ['Message 1', 'Message 2', 'Message 3', 'Message 4', 'Message 5']);
  assert.equal(service.getSnapshot().hasOlderMessages, false);
  await service.openConversation('carol'); await service.openConversation('bob');
  assert.deepEqual(texts(service), ['Message 4', 'Message 5']);
});

test('derives forwarding expiry without deleting archived chat or downgrading peer custody', async t => {
  const { service, engine, time } = fixture(t);
  const queued = stored({ kind: 'chat', destination: 'bob', payload: { text: 'Still visible after expiry' } });
  const acknowledged = stored({ kind: 'chat', destination: 'bob', payload: { text: 'Peer accepted custody' } });
  engine.records = [{ ...queued, peerStored: false }, { ...acknowledged, peerStored: true }];
  await service.start(); await service.openConversation('bob');
  const before = service.getSnapshot().messages;
  time.value = queued.expiresAt;
  assert.equal(deliveryState(before[0]!, 'alice', time.value), 'forwarding-ended');
  assert.equal(deliveryState(before[1]!, 'alice', time.value), 'peer-stored');
  assert.equal(before[0]?.peerStored, false);
  await service.refresh();
  assert.equal(service.getSnapshot().messages.length, 2);
});

test('stop followed by restart discards stale async snapshots and installs one fresh subscription', { timeout: 5_000 }, async t => {
  const engine = new ControlledChatEngine();
  const entered = deferred(); const release = deferred();
  const old = { ...stored({ kind: 'chat', destination: 'alice', payload: { text: 'Old snapshot' } }, 'bob'), peerStored: false };
  const fresh = { ...stored({ kind: 'chat', destination: 'alice', payload: { text: 'Fresh snapshot' } }, 'carol'), peerStored: false };
  let reads = 0;
  engine.readHistory = async () => { reads += 1; if (reads === 1) { entered.resolve(); await release.promise; return [old]; } return [fresh]; };
  t.after(() => release.resolve());
  const { service } = fixture(t, { engine });
  const starting = service.start(); await entered.promise;
  const stopping = service.stop(); const restarting = service.start();
  assert.equal(engine.listeners.size, 0);
  release.resolve(); await Promise.all([starting, stopping, restarting]);
  assert.equal(service.getSnapshot().status, 'ready');
  assert.equal(engine.listeners.size, 1);
  assert.deepEqual(service.getSnapshot().conversations.map(item => item.id), ['carol']);
  await service.openConversation('carol'); assert.deepEqual(texts(service), ['Fresh snapshot']);
});

test('reconstructs acknowledged custody on a fresh archive when the UI missed the live ACK', async t => {
  const engine = new ControlledChatEngine();
  engine.records = [{ ...stored({ kind: 'chat', destination: 'bob', payload: { text: 'Accepted while UI was closed' } }), peerStored: true }];
  const { service } = fixture(t, { engine });
  await service.start(); await service.openConversation('bob');
  assert.equal(service.getSnapshot().messages[0]?.peerStored, true);
  assert.equal(deliveryState(service.getSnapshot().messages[0]!, 'alice', 1_000), 'peer-stored');
});

test('retains a background routing error while unrelated archive reloads complete', async t => {
  const { service, engine } = fixture(t);
  await service.start();
  engine.emit({ type: 'error', operation: 'flush', error: new Error('Native transport disconnected') });
  engine.incoming('Archive remains usable');
  await until(() => service.getSnapshot().conversations.length === 1);
  assert.equal(service.getSnapshot().issue, 'routing-error');
  await service.openConversation('bob');
  assert.deepEqual(texts(service), ['Archive remains usable']);
  assert.equal(service.getSnapshot().issue, 'routing-error');
});


test('archives a dense message burst without duplicates and converges across bounded event batches', async t => {
  const { service, engine } = fixture(t, { pageSize: 500 });
  await service.start();
  for (let index = 0; index < 275; index += 1) {
    const record = engine.incoming(`Burst ${index}`, 'bob', 'alice', 1_000);
    // Engine acceptance can be observed by both publication and subscription;
    // replayed events must not produce an extra chat row or unread count.
    engine.emit({ type: 'accepted', record, local: false });
  }
  await until(() => service.getSnapshot().conversations[0]?.unreadCount === 275, 'all archive batches');
  await service.openConversation('bob');
  assert.equal(service.getSnapshot().messages.length, 275);
  assert.equal(new Set(service.getSnapshot().messages.map(message => message.id)).size, 275);
  assert.equal(service.getSnapshot().conversations[0]?.unreadCount, 0);
  assert.deepEqual(texts(service), Array.from({ length: 275 }, (_, index) => `Burst ${index}`));
});

test('a failed archive write does not turn a durable send into failure and refresh retries pending custody', async t => {
  let fail = false;
  const { service, engine } = fixture(t, { wrap: repository => wrapRepository(repository, {
    async upsert(entries, deviceId) {
      if (fail) throw new Error('Archive disk temporarily busy');
      await repository.upsert(entries, deviceId);
    },
  }) });
  await service.start(); await service.openConversation('bob'); service.setDraft('Routing commit succeeded');
  fail = true;
  const result = await service.send();
  assert.equal(result.status, 'queued');
  assert.equal(service.getSnapshot().draft, '');
  assert.equal(service.getSnapshot().notice?.kind, 'chat-queued');
  await until(() => service.getSnapshot().issue === 'history-unavailable', 'archive failure surfaced');
  if (result.status !== 'queued') return;
  engine.emit({ type: 'hop-acknowledged', messageId: result.messageId, peerId: 'carrier' });
  fail = false;
  await service.refresh();
  await until(() => service.getSnapshot().messages[0]?.peerStored === true, 'pending custody recovered');
  assert.deepEqual(texts(service), ['Routing commit succeeded']);
  assert.equal(service.getSnapshot().issue, null);
});

for (const failingSubscription of ['engine', 'mesh'] as const) {
  test(`a throwing ${failingSubscription} subscription reports failure, allows SOS, and recovers live updates on refresh`, async t => {
    const engine = new ControlledChatEngine();
    const mesh = new ControlledChatMesh();
    let fail = true;
    if (failingSubscription === 'engine') {
      const subscribe = engine.subscribe.bind(engine);
      engine.subscribe = listener => {
        if (fail) throw new Error('Engine event subscription temporarily unavailable');
        return subscribe(listener);
      };
    } else {
      const subscribe = mesh.subscribe.bind(mesh);
      mesh.subscribe = listener => {
        if (fail) throw new Error('Mesh event subscription temporarily unavailable');
        return subscribe(listener);
      };
    }
    const { service } = fixture(t, { engine, mesh });
    await service.start();
    assert.equal(service.getSnapshot().status, 'error');
    assert.equal(service.getSnapshot().issue, 'history-unavailable');
    assert.equal((await service.sendSos()).status, 'queued');
    assert.equal(engine.publications[0]?.kind, 'sos');
    await service.refresh();
    assert.equal(service.getSnapshot().status, 'error');
    assert.equal(service.getSnapshot().issue, 'history-unavailable');
    fail = false;
    await service.refresh();
    assert.equal(service.getSnapshot().status, 'ready');
    assert.equal(engine.listeners.size, 1);
    assert.equal(mesh.listeners.size, 1);
    engine.incoming('Live messages recovered');
    await until(() => service.getSnapshot().conversations.some(conversation => conversation.id === 'bob'));
    await service.openConversation('bob');
    assert.deepEqual(texts(service), ['Live messages recovered']);
    mesh.update(['carrier']);
    assert.deepEqual(service.getSnapshot().connectedPeers, ['carrier']);
  });
}

test('preserves custody for a message beyond the current archive batch even when its acceptance is replayed', async t => {
  const { service, engine, archive } = fixture(t, { pageSize: 500 });
  await service.start(); await service.openConversation('bob');
  const records = Array.from({ length: 275 }, (_, index) => stored({
    kind: 'chat', destination: 'bob', payload: { text: `Outbound ${index}` },
  }));
  // Emit synchronously so all accepts and this ACK precede the first bounded
  // archive flush. The ACK belongs to the second body batch, not the first.
  for (const record of records) {
    engine.records.push({ ...record, peerStored: false });
    engine.emit({ type: 'accepted', record, local: true });
  }
  const acknowledged = records[100]!;
  engine.emit({ type: 'hop-acknowledged', messageId: acknowledged.message.id, peerId: 'carrier' });
  // Publication and the engine subscription may both archive the same record.
  // Re-observing the body cannot erase the newer custody fact awaiting storage.
  engine.emit({ type: 'accepted', record: acknowledged, local: true });
  await until(() => service.getSnapshot().messages.length === 275, 'all outgoing body batches');
  const visible = service.getSnapshot().messages.find(message => message.id === acknowledged.message.id)!;
  assert.equal(visible.peerStored, true);
  assert.equal(deliveryState(visible, 'alice', 1_000), 'peer-stored');
  const persisted = (await archive.listMessages('bob', 500)).find(message => message.id === acknowledged.message.id);
  assert.equal(persisted?.peerStored, true);
  assert.equal(engine.records.find(record => record.message.id === acknowledged.message.id)?.peerStored, false);
});

test('background archiving preserves unread messages while custody continues and foreground reads only the selected thread', async t => {
  const { service, engine, archive } = fixture(t);
  engine.incoming('Read while visible', 'bob');
  engine.incoming('Unread in another thread', 'carol');
  const outgoing = stored({ kind: 'chat', destination: 'bob', payload: { text: 'Awaiting custody' } });
  engine.records.push({ ...outgoing, peerStored: false });
  await service.start(); await service.openConversation('bob');
  assert.equal(service.getSnapshot().conversations.find(item => item.id === 'bob')?.unreadCount, 0);
  assert.equal(service.getSnapshot().conversations.find(item => item.id === 'carol')?.unreadCount, 1);
  service.setVisible(false);
  const background = engine.incoming('Received while app is backgrounded', 'bob');
  engine.emit({ type: 'hop-acknowledged', messageId: outgoing.message.id, peerId: 'carrier' });
  await until(() => service.getSnapshot().conversations.find(item => item.id === 'bob')?.unreadCount === 1
    && service.getSnapshot().messages.find(message => message.id === outgoing.message.id)?.peerStored === true,
  'background archive and custody updates');
  assert.equal(service.getSnapshot().messages.find(message => message.id === background.message.id)?.read, false);
  assert.equal((await archive.listMessages('bob', 50)).find(message => message.id === background.message.id)?.read, false);
  assert.equal(service.getSnapshot().conversations.find(item => item.id === 'carol')?.unreadCount, 1);
  service.setVisible(true);
  await until(() => service.getSnapshot().conversations.find(item => item.id === 'bob')?.unreadCount === 0,
    'foreground selected-thread read');
  assert.equal(service.getSnapshot().messages.find(message => message.id === background.message.id)?.read, true);
  assert.equal((await archive.listMessages('bob', 50)).find(message => message.id === background.message.id)?.read, true);
  assert.equal(service.getSnapshot().conversations.find(item => item.id === 'carol')?.unreadCount, 1);
});
