import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { createPriorityClassifier, PriorityClassifier } from '../src/features/ai';
import { trainPriorityModel } from '../src/features/ai/domain/training';
import type { MessageClassifier } from '../src/features/ai/domain/types';
import { PRIORITY_MODEL } from '../src/features/ai/model/priorityModel';
import { ChatService } from '../src/features/chat/application/ChatService';
import { SqliteChatRepository } from '../src/features/chat/infrastructure/SqliteChatRepository';
import { priorityRank } from '../src/features/dtn/domain/routing';
import type { MeshMessage, OutgoingMessage, StorageLimits, StoredMessage } from '../src/features/dtn/domain/types';
import { createMessage, parseMessage } from '../src/features/dtn/domain/validation';
import { SqliteDtnStore } from '../src/features/dtn/infrastructure/sqlite/SqliteDtnStore';
import { loadCorpus } from '../scripts/ai/train-priority-model';
import { ControlledChatEngine, stored, until } from './helpers/chat';
import { TestSqliteDatabase } from './helpers/sqlite';

const classifier = createPriorityClassifier();
const LIMITS: StorageLimits = {
  maxMessages: 6, reservedEmergencyMessages: 1, maxSeenIds: 100, reservedEmergencySeenIds: 5,
  maxPeersPerMessage: 8, maxElevatedPerSource: 2,
};

function packet(input: OutgoingMessage, source = 'origin'): MeshMessage {
  return createMessage(input, randomUUID(), source, 100);
}
function chat(priority?: 'critical' | 'high' | 'normal' | 'low', source = 'origin', text = 'Hello'): MeshMessage {
  return packet({ kind: 'chat', destination: '*', payload: { text }, ...(priority ? { priority } : {}) }, source);
}
function record(message: MeshMessage, receivedAt = 100): StoredMessage {
  return { message, receivedAt, expiresAt: 10_000, dedupExpiresAt: 20_000, forwardable: true };
}
async function memoryStore(t: TestContext): Promise<{ database: TestSqliteDatabase; store: SqliteDtnStore }> {
  const database = new TestSqliteDatabase();
  const store = new SqliteDtnStore(database);
  await store.initialize();
  t.after(() => database.close());
  return { database, store };
}
function text(message: MeshMessage): string {
  return message.kind === 'chat' || message.kind === 'sos' ? message.payload.text : message.kind;
}

test('chat priority is an optional signed-envelope field with one canonical encoding', () => {
  const urgent = chat('critical');
  assert.equal(urgent.kind === 'chat' && urgent.priority, 'critical');
  assert.equal(Object.hasOwn(chat('normal'), 'priority'), false, 'normal is omitted on the wire');
  assert.equal(Object.hasOwn(chat(), 'priority'), false);
  assert.ok(parseMessage(JSON.parse(JSON.stringify(urgent))).ok);
  for (const priority of ['normal', 'urgent', 1, null]) {
    assert.equal(parseMessage({ ...urgent, priority }).ok, false, String(priority));
  }
  const sos = packet({ kind: 'sos', payload: { text: 'Help' } });
  assert.equal(parseMessage({ ...sos, priority: 'critical' }).ok, false, 'SOS keeps its own tier');
  assert.throws(() => createMessage({ kind: 'sos', payload: { text: 'Help' }, priority: 'low' } as unknown as OutgoingMessage, randomUUID(), 'origin', 1));
  assert.throws(() => createMessage({ kind: 'chat', destination: '*', payload: { text: 'x' }, priority: 'max' } as unknown as OutgoingMessage, randomUUID(), 'origin', 1));
  assert.deepEqual([packet({ kind: 'sos', payload: { text: 'Help' } }), chat('critical'), chat('high'), chat(), chat('low')]
    .map(priorityRank), [0, 1, 2, 3, 4]);
});

test('the queue forwards SOS, then critical, high, normal and low chat, FIFO within a tier', async t => {
  const { store } = await memoryStore(t);
  const limits = { ...LIMITS, maxMessages: 20, maxElevatedPerSource: 20 };
  const inputs: [MeshMessage, string][] = [
    [chat('low', 'a', 'low'), 'low'], [chat(undefined, 'a', 'normal-1'), 'normal-1'], [chat('high', 'a', 'high'), 'high'],
    [chat(undefined, 'a', 'normal-2'), 'normal-2'], [chat('critical', 'a', 'critical'), 'critical'],
    [packet({ kind: 'sos', payload: { text: 'sos' } }, 'a'), 'sos'],
  ];
  for (const [index, [message]] of inputs.entries()) await store.accept(record(message, 100 + index), null, limits, 100);
  const order: string[] = [];
  for (;;) {
    const next = await store.getNextDelivery(['peer'], 200, false, 8);
    if (!next) break;
    order.push(text(next.record.message));
    await store.markAcknowledged(next.record.message.id, 'peer', 200);
  }
  assert.deepEqual(order, ['sos', 'critical', 'high', 'normal-1', 'normal-2', 'low']);
  const conserve = await store.getNextDelivery(['other'], 200, true, 8);
  assert.equal(conserve && text(conserve.record.message), 'sos', 'conserve mode still forwards only SOS');
});

test('relays rank a source normal after it queues its elevated budget, without changing the signed packet', async t => {
  const { store, database } = await memoryStore(t);
  const limits = { ...LIMITS, maxMessages: 20 };
  for (const label of ['first', 'second', 'third']) await store.accept(record(chat('critical', 'noisy', label)), null, limits, 100);
  await store.accept(record(chat('high', 'calm', 'calm'), 101), null, limits, 100);
  const ranks = database.execute('SELECT source, priority_rank, packet FROM palmesh_dtn_messages ORDER BY sequence').rows;
  assert.deepEqual(ranks.map(row => row.priority_rank), [1, 1, 3, 2]);
  assert.match(String(ranks[2]!.packet), /"priority":"critical"/, 'the stored packet keeps its signed priority');
  const next = await store.getNextDelivery(['peer'], 200, false, 8);
  assert.equal(next && text(next.record.message), 'first');
});

test('a full queue evicts the lowest-priority oldest chat and never displaces equal or higher priority', async t => {
  const { store } = await memoryStore(t);
  // Ordinary traffic may use maxMessages - reserved = 5 slots.
  for (const [index, priority] of (['normal', 'low', 'high', 'low', 'normal'] as const).entries()) {
    assert.equal((await store.accept(record(chat(priority, `s${index}`, `${priority}-${index}`), 100 + index), null, LIMITS, 100)).status, 'accepted');
  }
  assert.deepEqual(await store.accept(record(chat('low', 'x', 'late-low'), 120), null, LIMITS, 100), { status: 'full', resource: 'messages' });
  assert.equal((await store.accept(record(chat(undefined, 'y', 'late-normal'), 121), null, LIMITS, 100)).status, 'accepted');
  assert.equal((await store.accept(record(chat('critical', 'z', 'late-critical'), 122), null, LIMITS, 100)).status, 'accepted');
  const remaining = async () => (await store.listHistory(20)).map(entry => text(entry.message)).sort();
  assert.deepEqual(await remaining(), ['high-2', 'late-critical', 'late-normal', 'normal-0', 'normal-4']);
  assert.deepEqual(await store.accept(record(chat(undefined, 'w', 'blocked'), 123), null, LIMITS, 100), { status: 'full', resource: 'messages' });
  // SOS may use the reserved slot, then displaces the lowest-priority oldest chat.
  for (const label of ['sos-1', 'sos-2']) {
    assert.equal((await store.accept(record(packet({ kind: 'sos', payload: { text: label } }, label), 130), null, LIMITS, 100)).status, 'accepted');
  }
  assert.deepEqual(await remaining(), ['high-2', 'late-critical', 'late-normal', 'normal-4', 'sos-1', 'sos-2']);
});

test('schema version two upgrades in place, ranking retained SOS ahead of chat', async t => {
  const database = new TestSqliteDatabase();
  t.after(() => database.close());
  database.execute('CREATE TABLE palmesh_dtn_schema (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), version INTEGER NOT NULL)');
  database.execute(`CREATE TABLE palmesh_dtn_messages (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('chat', 'sos', 'sos-response', 'location')), ttl INTEGER NOT NULL,
    packet TEXT NOT NULL, received_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, dedup_expires_at INTEGER NOT NULL,
    forwardable INTEGER NOT NULL CHECK (forwardable IN (0, 1)), peer_limit INTEGER NOT NULL CHECK (peer_limit BETWEEN 1 AND 4096))`);
  database.execute('CREATE TABLE palmesh_dtn_seen (message_id TEXT PRIMARY KEY NOT NULL, expires_at INTEGER NOT NULL, emergency INTEGER NOT NULL)');
  database.execute(`CREATE TABLE palmesh_dtn_deliveries (message_id TEXT NOT NULL, peer_id TEXT NOT NULL, acknowledged INTEGER NOT NULL,
    attempts INTEGER NOT NULL, next_attempt_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (message_id, peer_id))`);
  database.execute(`CREATE INDEX palmesh_dtn_messages_priority ON palmesh_dtn_messages
    ((CASE WHEN kind IN ('sos', 'sos-response') THEN 0 ELSE 1 END), received_at, sequence)`);
  database.execute('CREATE INDEX palmesh_dtn_messages_fifo ON palmesh_dtn_messages (received_at, sequence)');
  database.execute('CREATE INDEX palmesh_dtn_deliveries_retry ON palmesh_dtn_deliveries (peer_id, acknowledged, next_attempt_at)');
  database.execute('CREATE INDEX palmesh_dtn_deliveries_pending ON palmesh_dtn_deliveries (message_id, acknowledged, next_attempt_at)');
  database.execute('INSERT INTO palmesh_dtn_schema VALUES (1, 2)');
  const old = chat(undefined, 'a', 'old chat');
  const sos = packet({ kind: 'sos', payload: { text: 'old sos' } }, 'b');
  for (const [index, message] of [old, sos].entries()) {
    database.execute(`INSERT INTO palmesh_dtn_messages (id, source, kind, ttl, packet, received_at, expires_at, dedup_expires_at, forwardable, peer_limit)
      VALUES (?, ?, ?, ?, ?, ?, 10000, 20000, 1, 8)`, [message.id, message.source, message.kind, message.ttl, JSON.stringify(message), 100 + index]);
  }
  const store = new SqliteDtnStore(database);
  await store.initialize();
  assert.equal(database.execute('SELECT version FROM palmesh_dtn_schema').rows[0]?.version, 3);
  await store.accept(record(chat('critical', 'c', 'new critical'), 150), null, { ...LIMITS, maxMessages: 20 }, 100);
  const order: string[] = [];
  for (let next = await store.getNextDelivery(['peer'], 200, false, 8); next; next = await store.getNextDelivery(['peer'], 200, false, 8)) {
    order.push(text(next.record.message));
    await store.markAcknowledged(next.record.message.id, 'peer', 200);
  }
  assert.deepEqual(order, ['old sos', 'new critical', 'old chat']);
});

test('the on-device model classifies Arabic and English urgency and explains its estimate', () => {
  const cases: [string, string][] = [
    ['ابني بنزف وفاقد الوعي الحقونا', 'critical'],
    ['We are trapped under the rubble with 3 kids', 'critical'],
    ['The roof fell on my dad, he can’t breathe', 'critical'],
    ['خلص الدوا تبع امي السكري', 'high'],
    ['Need water and diapers for the baby', 'high'],
    ['وين بدنا نلتقي بكرا؟', 'normal'],
    ['شكرا كتير', 'low'],
    ['thanks!', 'low'],
  ];
  for (const [input, expected] of cases) assert.equal(classifier.classify(input).priority, expected, input);
  const emergency = classifier.classify('الحقونا في ناس عالقين تحت الركام');
  assert.equal(emergency.suggestSos, true);
  assert.ok(emergency.signals.includes('تحت الركام'), emergency.signals.join());
  assert.ok(!emergency.signals.includes('ركام'), 'a matching phrase subsumes its words');
  assert.ok(Math.abs(Object.values(emergency.scores).reduce((sum, value) => sum + value, 0) - 1) < 0.01);
  assert.equal(classifier.classify('Need water for the shelter').suggestSos, false);
  assert.deepEqual(classifier.classify('   ').priority, 'normal');
  assert.equal(classifier.classify('  !!  ').confidence, 0);
  // Diacritics, elongation and Arabic-Indic digits normalize to the same evidence.
  assert.equal(classifier.classify('ساعدووووني، أخي يَنزِفُ ٣ ساعات').priority, 'critical');
});

test('the bundled model is exactly reproducible from the committed corpus', () => {
  assert.deepEqual(trainPriorityModel(loadCorpus()), PRIORITY_MODEL);
  assert.throws(() => new PriorityClassifier({ ...PRIORITY_MODEL, classes: ['critical', 'high', 'normal'], priors: [0, 0, 0] }), /lacks class low/);
});

test('the archive keeps priority and lists conversations with urgent unread messages first', async t => {
  const database = new TestSqliteDatabase();
  t.after(() => database.close());
  const repository = new SqliteChatRepository(database);
  await repository.initialize();
  const entry = (message: MeshMessage, receivedAt: number) => ({ ...record(message, receivedAt), peerStored: false });
  await repository.upsert([
    entry(packet({ kind: 'chat', destination: 'alice', payload: { text: 'urgent' }, priority: 'high' }, 'bob'), 100),
    entry(packet({ kind: 'chat', destination: 'alice', payload: { text: 'later routine' } }, 'carol'), 200),
    entry(packet({ kind: 'chat', destination: 'dave', payload: { text: 'outgoing critical' }, priority: 'critical' }, 'alice'), 300),
  ], 'alice');
  let conversations = await repository.listConversations();
  assert.deepEqual(conversations.map(item => [item.id, item.unreadUrgency]), [['bob', 'high'], ['dave', undefined], ['carol', undefined]]);
  assert.equal((await repository.listMessages('dave', 10))[0]?.priority, 'critical');
  const [bobMessage] = await repository.listMessages('bob', 10);
  await repository.markRead('bob', bobMessage!.sequence);
  conversations = await repository.listConversations();
  assert.deepEqual(conversations.map(item => item.id), ['dave', 'carol', 'bob'], 'read urgency no longer jumps the list');
});

test('a version-one chat archive gains a normal priority column without losing history', async t => {
  const database = new TestSqliteDatabase();
  t.after(() => database.close());
  database.execute('CREATE TABLE palmesh_chat_schema (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), version INTEGER NOT NULL, local_device_id TEXT)');
  database.execute(`CREATE TABLE palmesh_chat_messages (sequence INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL UNIQUE,
    conversation_id TEXT NOT NULL, source TEXT NOT NULL, destination TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('chat', 'sos')),
    text TEXT NOT NULL, created_at INTEGER NOT NULL, received_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    outgoing INTEGER NOT NULL, peer_stored INTEGER NOT NULL, is_read INTEGER NOT NULL, location TEXT)`);
  database.execute('CREATE TABLE palmesh_chat_seen (sequence INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL UNIQUE)');
  database.execute("INSERT INTO palmesh_chat_schema VALUES (1, 1, 'alice')");
  const id = randomUUID();
  database.execute(`INSERT INTO palmesh_chat_messages (message_id, conversation_id, source, destination, kind, text, created_at,
    received_at, expires_at, outgoing, peer_stored, is_read) VALUES (?, 'bob', 'bob', 'alice', 'chat', 'kept', 1, 1, 2, 0, 0, 0)`, [id]);
  database.execute('INSERT INTO palmesh_chat_seen (message_id) VALUES (?)', [id]);
  const repository = new SqliteChatRepository(database);
  await repository.initialize();
  await repository.upsert([], 'alice');
  const [message] = await repository.listMessages('bob', 10);
  assert.equal(message?.text, 'kept');
  assert.equal(message?.priority, 'normal');
});

function chatFixture(t: TestContext, options: { classifier?: MessageClassifier } = {}) {
  const database = new TestSqliteDatabase();
  const engine = new ControlledChatEngine();
  const service = new ChatService({
    engine, repository: new SqliteChatRepository(database), clock: { now: () => 1_000 },
    classifier: options.classifier ?? classifier,
  });
  t.after(async () => { await service.stop(); database.close(); });
  return { service, engine };
}

test('chat drafts are assessed on the device and sent with the estimated or chosen priority', async t => {
  const { service, engine } = chatFixture(t);
  await service.start();
  await service.openConversation('bob');
  service.setDraft('محتاجين مي وحليب اطفال ضروري');
  assert.equal(service.getSnapshot().draftAssessment?.priority, 'high');
  assert.equal((await service.send()).status, 'queued');
  assert.equal(engine.publications.at(-1)?.kind === 'chat' && engine.publications.at(-1)?.priority, 'high');
  assert.equal(service.getSnapshot().draftAssessment, null, 'a sent draft clears its estimate');

  service.setDraft('see you tomorrow at the bakery');
  service.setPriorityOverride('critical');
  await service.send();
  assert.equal(engine.publications.at(-1)?.kind === 'chat' && engine.publications.at(-1)?.priority, 'critical');
  assert.equal(service.getSnapshot().priorityOverride, null);

  service.setDraft('ok thanks');
  service.setPriorityOverride('normal');
  await service.send();
  assert.equal(Object.hasOwn(engine.publications.at(-1)!, 'priority'), false, 'normal priority is not serialized');
  service.setPriorityOverride('extreme' as never);
  assert.equal(service.getSnapshot().issue, 'invalid-input');
});

test('a draft flagged as life-threatening can be escalated to a public SOS with its own text', async t => {
  const { service, engine } = chatFixture(t);
  await service.start();
  await service.openConversation('bob');
  service.setDraft('My father collapsed and is not breathing');
  assert.equal(service.getSnapshot().draftAssessment?.suggestSos, true);
  assert.deepEqual(await service.sendDraftAsSos(), { status: 'queued', messageId: (await waitForSos(engine)).id });
  assert.deepEqual(engine.publications.at(-1), { kind: 'sos', payload: { text: 'My father collapsed and is not breathing' } });
  assert.equal(service.getSnapshot().draft, '');
  assert.equal(service.getSnapshot().notice?.kind, 'sos-queued');
  assert.deepEqual(await service.sendDraftAsSos(), { status: 'rejected', reason: 'empty' });
});

test('a failing classifier never blocks a chat; it is sent at normal priority', async t => {
  const { service, engine } = chatFixture(t, { classifier: { classify() { throw new Error('model unavailable'); } } });
  await service.start();
  await service.openConversation('bob');
  service.setDraft('Someone is bleeding');
  assert.equal(service.getSnapshot().draftAssessment, null);
  assert.equal((await service.send()).status, 'queued');
  assert.equal(Object.hasOwn(engine.publications.at(-1)!, 'priority'), false);
});

async function waitForSos(engine: ControlledChatEngine): Promise<MeshMessage> {
  await until(() => engine.records.some(entry => entry.message.kind === 'sos'), 'SOS publication');
  return engine.records.find(entry => entry.message.kind === 'sos')!.message;
}

test('stored helper preserves an outgoing priority through the routing record', () => {
  const entry = stored({ kind: 'chat', destination: 'bob', payload: { text: 'x' }, priority: 'low' });
  assert.equal(entry.message.kind === 'chat' && entry.message.priority, 'low');
});
