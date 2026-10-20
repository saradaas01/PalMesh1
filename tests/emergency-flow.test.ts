import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createMessage, parseMessage } from '../src/features/dtn/domain/validation';
import type { OutgoingMessage, RoutingHistoryEntry, StoredMessage } from '../src/features/dtn/domain/types';
import { SqliteDtnStore } from '../src/features/dtn/infrastructure/sqlite/SqliteDtnStore';
import { projectEntry } from '../src/features/chat/domain/messages';
import { EmergencyService, SqliteEmergencyRepository } from '../src/features/emergency';
import { ControlledChatEngine, deferred, stored, until } from './helpers/chat';
import { TestSqliteDatabase } from './helpers/sqlite';

const NOW = 2_000;
function entry(record: StoredMessage): RoutingHistoryEntry { return { ...record, peerStored: false }; }
function sos(source = 'bob', time = 1_000): StoredMessage { return stored({ kind: 'sos', payload: { text: 'I need help' } }, source, time); }
function response(sosId: string, source = 'bob', destination = 'alice'): StoredMessage {
  return stored({ kind: 'sos-response', destination, payload: { sosId, status: 'responding' } }, source, NOW);
}
async function fixture(t: TestContext, records: RoutingHistoryEntry[] = []) {
  const database = new TestSqliteDatabase();
  const repository = new SqliteEmergencyRepository(database);
  const engine = new ControlledChatEngine(); engine.records = records;
  const notifications: string[] = []; const cancellations: string[] = [];
  const service = new EmergencyService({ engine, repository, clock: { now: () => NOW }, alerts: {
    notifyIncoming: async value => { notifications.push(value.id); }, cancel: async id => { cancellations.push(id); },
  } });
  t.after(async () => { await service.stop(); database.close(); });
  await service.start();
  return { database, repository, engine, service, notifications, cancellations };
}

test('SOS response is direct, bounded, UUID-linked, prioritized and hidden from chat', () => {
  const original = sos('alice'); const packet = response(original.message.id).message;
  assert.equal(packet.ttl, 15); assert.equal(packet.destination, 'alice');
  assert.equal(parseMessage({ ...packet, destination: '*' }).ok, false);
  assert.equal(parseMessage({ ...packet, payload: { sosId: 'fake', status: 'responding' } }).ok, false);
  assert.equal(parseMessage({ ...packet, payload: { sosId: original.message.id, status: 'arrived' } }).ok, false);
  assert.equal(parseMessage({ ...packet, payload: { ...packet.payload, location: { latitude: 0, longitude: 0, timestamp: 0 } } }).ok, false);
  assert.equal(parseMessage({ ...packet, ttl: 16 }).ok, false);
  assert.equal(projectEntry(entry({ ...response(original.message.id) }), 'alice'), null);
  assert.throws(() => createMessage({ kind: 'sos-response', payload: { sosId: original.message.id, status: 'responding' } } as unknown as OutgoingMessage,
    packet.id, 'bob', NOW));
});

test('incoming SOS creates reactive urgent inbox and one notification attempt despite duplicates', async t => {
  const { engine, service, notifications } = await fixture(t);
  let updates = 0; const unsubscribe = service.subscribe(() => { updates += 1; });
  const incoming = sos(); engine.emit({ type: 'accepted', record: incoming, local: false });
  await until(() => service.getSnapshot().entries.length === 1 && notifications.length === 1);
  assert.equal(service.getSnapshot().urgent?.id, incoming.message.id);
  engine.emit({ type: 'accepted', record: incoming, local: false });
  await service.refresh();
  assert.equal(service.getSnapshot().entries.length, 1); assert.equal(notifications.length, 1);
  assert.ok(updates > 0); unsubscribe();
});

test('radio custody, wrong recipients, unknown originals and self claims cannot fabricate responder acceptance', async t => {
  const outgoing = sos('alice'); const { engine, service } = await fixture(t, [entry(outgoing)]);
  engine.emit({ type: 'hop-acknowledged', messageId: outgoing.message.id, peerId: 'relay' });
  for (const packet of [response(outgoing.message.id, 'mallory', 'carol'), response(sos().message.id), response(outgoing.message.id, 'alice')]) {
    engine.emit({ type: 'accepted', record: packet, local: false });
  }
  await service.refresh();
  assert.equal(service.getSnapshot().entries[0]?.responses.length, 0);
  const human = response(outgoing.message.id);
  engine.emit({ type: 'accepted', record: human, local: false });
  await until(() => service.getSnapshot().entries[0]?.responses.length === 1);
  assert.equal(service.getSnapshot().entries[0]?.responses[0]?.responder, 'bob');
  assert.equal(service.getSnapshot().entries[0]?.responses[0]?.status, 'responding');
  engine.emit({ type: 'accepted', record: response(outgoing.message.id), local: false });
  await service.refresh();
  assert.equal(service.getSnapshot().entries[0]?.responses.length, 1);
});

test('a response sends only explicit intent to original source, is single-flight, and does not expose responder location', async t => {
  const incoming = sos(); const { engine, service } = await fixture(t, [entry(incoming)]);
  const gate = deferred<Exclude<Awaited<ReturnType<ControlledChatEngine['publish']>>, { status: 'duplicate' }>>();
  engine.publishNext = () => gate.promise;
  const first = service.respond(incoming.message.id);
  assert.deepEqual(await service.respond(incoming.message.id), { status: 'rejected', reason: 'busy' });
  assert.deepEqual(engine.publications, [{ kind: 'sos-response', destination: 'bob', payload: { sosId: incoming.message.id, status: 'responding' } }]);
  const result = response(incoming.message.id, 'alice', 'bob'); gate.resolve({ status: 'accepted', record: result });
  assert.deepEqual(await first, { status: 'queued', messageId: result.message.id });
  assert.deepEqual(await service.respond(incoming.message.id), { status: 'queued', messageId: result.message.id });
  assert.equal(engine.publications.length, 1); assert.equal(service.getSnapshot().entries[0]?.responseId, result.message.id);
});

test('expired or own SOS cannot be responded to; full queues preserve the SOS and expose a retryable failure', async t => {
  const incoming = sos(); const expired = { ...sos('carol'), expiresAt: NOW };
  const own = sos('alice'); const { engine, service } = await fixture(t, [entry(incoming), entry(expired), entry(own)]);
  assert.deepEqual(await service.respond(expired.message.id), { status: 'rejected', reason: 'expired' });
  assert.deepEqual(await service.respond(own.message.id), { status: 'rejected', reason: 'invalid' });
  engine.publishNext = async () => ({ status: 'full', resource: 'messages' });
  assert.deepEqual(await service.respond(incoming.message.id), { status: 'rejected', reason: 'capacity' });
  assert.equal(service.getSnapshot().issue, 'queue-full'); assert.equal(service.getSnapshot().entries.length, 3);
  assert.deepEqual(service.getSnapshot().pendingResponseIds, []);
});

test('dismissal persists and a denied notification never removes or resolves an SOS', async t => {
  const database = new TestSqliteDatabase(); const repository = new SqliteEmergencyRepository(database);
  const engine = new ControlledChatEngine(); const incoming = sos(); engine.records = [entry(incoming)]; let attempts = 0;
  const service = new EmergencyService({ engine, repository, clock: { now: () => NOW }, alerts: {
    notifyIncoming: async () => { attempts += 1; throw new Error('Notifications denied'); }, cancel: async () => undefined,
  } });
  t.after(async () => { await service.stop(); database.close(); }); await service.start();
  assert.equal(service.getSnapshot().issue, 'notification-unavailable'); assert.equal(service.getSnapshot().urgent?.id, incoming.message.id);
  await service.refresh(); assert.equal(attempts, 1);
  await service.dismiss(incoming.message.id); assert.equal(service.getSnapshot().urgent, null);
  assert.equal(service.getSnapshot().entries[0]?.dismissed, true);
  await service.stop(); await service.start();
  assert.equal(service.getSnapshot().urgent, null); assert.equal(attempts, 1);
});

test('real SQLite reopen preserves local response, reviewed status and notification claim', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'palmesh-emergency-')); const path = join(directory, 'sos.sqlite');
  let database = new TestSqliteDatabase(path); let repository = new SqliteEmergencyRepository(database);
  t.after(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });
  const incoming = sos(); const ownResponse = response(incoming.message.id, 'alice', 'bob');
  await repository.initialize('alice'); await repository.ingest([entry(ownResponse), entry(incoming)]);
  assert.equal(await repository.claimNotification(incoming.message.id), true); await repository.dismiss(incoming.message.id);
  database.close(); database = new TestSqliteDatabase(path); repository = new SqliteEmergencyRepository(database); await repository.initialize('alice');
  const restored = (await repository.read())[0]!;
  assert.equal(restored.responseId, ownResponse.message.id); assert.equal(restored.dismissed, true);
  assert.equal(await repository.claimNotification(incoming.message.id), false);
  await assert.rejects(new SqliteEmergencyRepository(database).initialize('other'), /another device identity/);
});

test('archive bounds retained SOS and responder counts, ignores relays and preserves first payload', async t => {
  const database = new TestSqliteDatabase(); t.after(() => database.close());
  const repository = new SqliteEmergencyRepository(database, { maxEntries: 2, maxResponsesPerSos: 2 }); await repository.initialize('alice');
  const first = sos('alice'); const second = sos('bob', 1_100); const newest = sos('carol', 1_200);
  const relay = { ...sos('david'), message: { ...sos('david').message, destination: 'eve' } };
  await repository.ingest([entry(first), entry(second), entry(relay)]);
  await repository.ingest([entry(response(first.message.id, 'bob')), entry(response(first.message.id, 'carol')), entry(response(first.message.id, 'david'))]);
  assert.equal((await repository.read()).find(value => value.id === first.message.id)?.responses.length, 2);
  await repository.ingest([entry(newest), entry({ ...second, message: { ...second.message, kind: 'sos', payload: { text: 'mutated' } } })]);
  const result = await repository.read(); assert.equal(result.length, 2); assert.equal(result[1]?.text, 'I need help');
  assert.equal(database.execute('SELECT COUNT(*) AS count FROM palmesh_emergency_responses').rows[0]?.count, 0);
});

test('DTN schema migration preserves version-one queue and receipts, then schedules SOS response in conserve mode', async t => {
  const database = new TestSqliteDatabase(); t.after(() => database.close());
  const store = new SqliteDtnStore(database); await store.initialize();
  const limits = { maxMessages: 10, reservedEmergencyMessages: 2, maxSeenIds: 20, reservedEmergencySeenIds: 2, maxPeersPerMessage: 4 };
  const old = stored({ kind: 'chat', destination: 'bob', payload: { text: 'Retained' } }, 'alice');
  await store.accept(old, null, limits, 1_000); await store.markAcknowledged(old.message.id, 'relay', 1_000);
  // Recreate the original v1 CHECK constraint, then perform the real migration.
  database.execute('ALTER TABLE palmesh_dtn_messages RENAME TO v2_messages');
  database.execute(`CREATE TABLE palmesh_dtn_messages (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('chat','sos','location')), ttl INTEGER NOT NULL, packet TEXT NOT NULL,
    received_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, dedup_expires_at INTEGER NOT NULL, forwardable INTEGER NOT NULL, peer_limit INTEGER NOT NULL)`);
  database.execute('INSERT INTO palmesh_dtn_messages SELECT * FROM v2_messages'); database.execute('DROP TABLE v2_messages');
  database.execute('UPDATE palmesh_dtn_schema SET version = 1');
  const migrated = new SqliteDtnStore(database); await migrated.initialize();
  assert.equal((await migrated.getMessage(old.message.id))?.message.payload && (await migrated.listHistoryWithCustody(10))[0]?.peerStored, true);
  const control = response(sos('bob').message.id, 'alice', 'bob'); await migrated.accept(control, null, limits, NOW);
  assert.equal((await migrated.getNextDelivery(['bob'], NOW, true, 4))?.record.message.kind, 'sos-response');
  assert.equal(database.execute('SELECT version FROM palmesh_dtn_schema').rows[0]?.version, 2);
});

test('SOS arriving while initial history is loading is retained and presented after recovery', async t => {
  const database = new TestSqliteDatabase(); const repository = new SqliteEmergencyRepository(database);
  const engine = new ControlledChatEngine(); const history = deferred<readonly RoutingHistoryEntry[]>();
  engine.readHistory = () => history.promise;
  const service = new EmergencyService({ engine, repository, clock: { now: () => NOW } });
  t.after(async () => { await service.stop(); database.close(); });
  const starting = service.start(); await until(() => engine.listeners.size === 1);
  const incoming = sos(); engine.emit({ type: 'accepted', record: incoming, local: false });
  history.resolve([]); await starting;
  await until(() => service.getSnapshot().urgent?.id === incoming.message.id);
});

test('history recovery bounds native notification work while retaining every SOS in the inbox', async t => {
  const originals = Array.from({ length: 12 }, (_, index) => sos(`peer-${index}`, 1_000 + index));
  const { service, notifications } = await fixture(t, originals.map(entry));
  assert.equal(service.getSnapshot().entries.length, 12); assert.equal(notifications.length, 4);
  await service.refresh(); assert.equal(notifications.length, 4);
  await service.stop(); await service.start(); assert.equal(notifications.length, 4);
});
