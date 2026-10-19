import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SqliteDtnStore, type SynchronousSqliteDatabase, type SqliteValue } from '../src/features/dtn/infrastructure/sqlite/SqliteDtnStore';
import { OpSqliteDatabase, type OpSqliteSyncConnection, type OpSqliteScalar } from '../src/features/dtn/infrastructure/sqlite/OpSqliteDatabase';
import type { StorageLimits, StoredMessage } from '../src/features/dtn/domain/types';
import { TestSqliteDatabase } from './helpers/sqlite';

const LIMITS: StorageLimits = {
  maxMessages: 20, reservedEmergencyMessages: 2,
  maxSeenIds: 100, reservedEmergencySeenIds: 5, maxPeersPerMessage: 16,
};

function record(id: string, kind: 'chat' | 'sos' = 'chat', options: Partial<Omit<StoredMessage, 'message'>> = {}): StoredMessage {
  const envelope = { version: 1 as const, id, source: 'origin', destination: '*', createdAt: 100, ttl: 10 };
  return {
    message: kind === 'sos' ? { ...envelope, kind, payload: { text: 'Help' } } : { ...envelope, kind, payload: { text: 'Hello' } },
    receivedAt: 100, expiresAt: 10_000, dedupExpiresAt: 20_000, forwardable: true,
    ...options,
  };
}

async function memoryStore(): Promise<{ database: TestSqliteDatabase; store: SqliteDtnStore }> {
  const database = new TestSqliteDatabase();
  const store = new SqliteDtnStore(database);
  await store.initialize();
  return { database, store };
}

test('SQLite atomically accepts UUIDs and stores previous-hop receipts for new and duplicate packets', async (t) => {
  const { store, database } = await memoryStore();
  t.after(() => database.close());
  const input = record('atomic');
  const results = await Promise.all([
    store.accept(input, 'first-hop', LIMITS, 100),
    store.accept(input, 'duplicate-hop', LIMITS, 100),
  ]);
  assert.deepEqual(results.map((result) => result.status), ['accepted', 'duplicate']);
  assert.equal((await store.listHistory(10)).length, 1);
  assert.equal(await store.getNextDelivery(['origin', 'first-hop', 'duplicate-hop'], 100, false, 16), null);
  assert.equal((await store.getNextDelivery(['fresh-peer'], 100, false, 16))?.record.message.id, 'atomic');
});

test('SQLite rolls back message, UUID and receipt together if acceptance fails', async (t) => {
  const database = new TestSqliteDatabase();
  t.after(() => database.close());
  let failReceipt = true;
  const driver: SynchronousSqliteDatabase = {
    execute(sql, parameters: readonly SqliteValue[] = []) {
      if (failReceipt && sql.includes('INSERT INTO palmesh_dtn_deliveries')) throw new Error('simulated storage failure');
      return database.execute(sql, parameters);
    },
  };
  const store = new SqliteDtnStore(driver);
  await store.initialize();
  await assert.rejects(store.accept(record('rolled-back'), 'peer', LIMITS, 100), /simulated storage failure/);
  assert.equal(await store.getMessage('rolled-back'), null);
  assert.equal(database.execute('SELECT COUNT(*) AS count FROM palmesh_dtn_seen').rows[0]?.count, 0);
  failReceipt = false;
  assert.equal((await store.accept(record('rolled-back'), 'peer', LIMITS, 100)).status, 'accepted');
});

test('SQLite preserves accepted packet snapshots and binds arbitrary packet text and peer IDs', async (t) => {
  const { store, database } = await memoryStore();
  t.after(() => database.close());
  const input = record("uuid'; DROP TABLE palmesh_dtn_messages; --");
  const accepted = await store.accept(input, "peer'); DELETE FROM palmesh_dtn_seen; --", LIMITS, 100);
  assert.equal(accepted.status, 'accepted');
  if (accepted.status !== 'accepted') return;
  (input.message.payload as { text: string }).text = 'mutated input';
  (accepted.record.message.payload as { text: string }).text = 'mutated return';
  const stored = await store.getMessage(input.message.id);
  assert.ok(stored && stored.message.kind === 'chat');
  assert.equal(stored.message.payload.text, 'Hello');
  assert.equal((await store.listHistory(1)).length, 1);
});

test('SQLite schedules due SOS before FIFO normal traffic, future retries by earliest deadline', async (t) => {
  const { store, database } = await memoryStore();
  t.after(() => database.close());
  await store.accept(record('normal-1'), null, LIMITS, 100);
  await store.accept(record('normal-2'), null, LIMITS, 100);
  await store.accept(record('sos-later', 'sos', { receivedAt: 110 }), null, LIMITS, 110);
  assert.equal((await store.getNextDelivery(['peer'], 120, false, 16))?.record.message.id, 'sos-later');
  await store.markFailed({ messageId: 'sos-later', peerId: 'peer', attempts: 1, nextAttemptAt: 500, now: 120 });
  assert.equal((await store.getNextDelivery(['peer'], 120, false, 16))?.record.message.id, 'normal-1');
  await store.markFailed({ messageId: 'normal-1', peerId: 'peer', attempts: 1, nextAttemptAt: 300, now: 120 });
  assert.equal((await store.getNextDelivery(['peer'], 120, false, 16))?.record.message.id, 'normal-2');
  await store.markFailed({ messageId: 'normal-2', peerId: 'peer', attempts: 1, nextAttemptAt: 400, now: 120 });
  const future = await store.getNextDelivery(['peer'], 120, false, 16);
  assert.equal(future?.record.message.id, 'normal-1');
  assert.equal(future?.nextAttemptAt, 300);
  assert.equal(future?.attempts, 1);
  assert.equal((await store.getNextDelivery(['peer'], 120, true, 16))?.record.message.id, 'sos-later');
});

test('SQLite selects earliest connected retry and FIFO ties despite earlier disconnected retries', async (t) => {
  const { store, database } = await memoryStore();
  t.after(() => database.close());
  const limits = { ...LIMITS, maxPeersPerMessage: 3 };
  const packets = [record('old-normal'), record('older-sos', 'sos', { receivedAt: 101 }), record('new-normal', 'chat', { receivedAt: 102 })];
  for (const packet of packets) {
    await store.accept(packet, null, limits, 102);
    await store.markFailed({ messageId: packet.message.id, peerId: 'disconnected', attempts: 2, nextAttemptAt: 200, now: 102 });
    await store.markFailed({ messageId: packet.message.id, peerId: 'connected-a', attempts: 1, nextAttemptAt: packet.message.id === 'old-normal' ? 600 : 500, now: 102 });
    await store.markFailed({ messageId: packet.message.id, peerId: 'connected-b', attempts: 1, nextAttemptAt: 700, now: 102 });
  }
  const next = await store.getNextDelivery(['connected-b', 'connected-a'], 300, false, 3);
  assert.equal(next?.record.message.id, 'older-sos');
  assert.equal(next?.peerId, 'connected-a');
  assert.equal(next?.nextAttemptAt, 500);
  await store.markAcknowledged('older-sos', 'connected-a', 300);
  assert.equal((await store.getNextDelivery(['connected-b', 'connected-a'], 300, false, 3))?.record.message.id, 'new-normal');
});

test('SQLite excludes terminal, zero-TTL, source, acknowledged and expired destinations', async (t) => {
  const { store, database } = await memoryStore();
  t.after(() => database.close());
  await store.accept(record('terminal', 'chat', { forwardable: false }), null, LIMITS, 100);
  const zeroTtl = record('zero-ttl');
  await store.accept({ ...zeroTtl, message: { ...zeroTtl.message, ttl: 0 } }, null, LIMITS, 100);
  await store.accept(record('expired', 'chat', { expiresAt: 150 }), null, LIMITS, 100);
  await store.accept(record('acked'), null, LIMITS, 100);
  await store.markAcknowledged('acked', 'peer', 100);
  assert.equal(await store.getNextDelivery(['peer'], 200, false, 16), null);
  assert.equal(await store.getNextDelivery(['origin'], 100, false, 16), null);
});

test('SQLite reserves emergency capacity and evicts oldest ordinary packet while retaining its UUID', async (t) => {
  const { store, database } = await memoryStore();
  t.after(() => database.close());
  const limits = { ...LIMITS, maxMessages: 3, reservedEmergencyMessages: 1 };
  assert.equal((await store.accept(record('normal-old'), 'old-hop', limits, 100)).status, 'accepted');
  assert.equal((await store.accept(record('normal-new', 'chat', { receivedAt: 101 }), null, limits, 101)).status, 'accepted');
  assert.deepEqual(await store.accept(record('normal-full'), null, limits, 101), { status: 'full', resource: 'messages' });
  await store.accept(record('sos-first', 'sos'), null, limits, 101);
  assert.equal((await store.accept(record('sos-second', 'sos'), null, limits, 101)).status, 'accepted');
  assert.equal(await store.getMessage('normal-old'), null);
  assert.ok(await store.getMessage('normal-new'));
  assert.equal((await store.accept(record('normal-old'), null, limits, 101)).status, 'duplicate');
  assert.equal(database.execute('SELECT COUNT(*) AS count FROM palmesh_dtn_deliveries WHERE message_id = ?', ['normal-old']).rows[0]?.count, 0);
  assert.equal((await store.listHistory(10)).length, 3);
});

test('SQLite never evicts SOS packets or live dedup IDs to accept new traffic', async (t) => {
  const { store, database } = await memoryStore();
  t.after(() => database.close());
  const limits = { ...LIMITS, maxMessages: 1, reservedEmergencyMessages: 1, maxSeenIds: 2, reservedEmergencySeenIds: 1 };
  await store.accept(record('first', 'sos'), null, limits, 100);
  assert.deepEqual(await store.accept(record('second', 'sos'), null, limits, 100), { status: 'full', resource: 'messages' });
  assert.equal((await store.getMessage('first'))?.message.kind, 'sos');
  const dedupLimits = { ...limits, maxMessages: 10, reservedEmergencyMessages: 0 };
  assert.deepEqual(await store.accept(record('normal'), null, dedupLimits, 100), { status: 'full', resource: 'dedup' });
  assert.equal((await store.accept(record('second', 'sos'), null, dedupLimits, 100)).status, 'accepted');
  assert.deepEqual(await store.accept(record('third', 'sos'), null, dedupLimits, 100), { status: 'full', resource: 'dedup' });
  assert.equal(database.execute('SELECT COUNT(*) AS count FROM palmesh_dtn_seen').rows[0]?.count, 2);
});

test('SQLite prunes expired messages and receipts, retaining dedup IDs until their own expiration', async (t) => {
  const { store, database } = await memoryStore();
  t.after(() => database.close());
  const input = record('retained', 'chat', { expiresAt: 200, dedupExpiresAt: 300 });
  await store.accept(input, 'previous', LIMITS, 100);
  await store.prune(200);
  assert.equal(await store.getMessage('retained'), null);
  assert.equal(database.execute('SELECT COUNT(*) AS count FROM palmesh_dtn_deliveries').rows[0]?.count, 0);
  assert.equal((await store.accept(record('retained'), null, LIMITS, 200)).status, 'duplicate');
  await store.prune(300);
  assert.equal((await store.accept(record('retained'), null, LIMITS, 300)).status, 'accepted');
});

test('SQLite pruning preserves a seen ID while its message remains active', async (t) => {
  const { store, database } = await memoryStore();
  t.after(() => database.close());
  await store.accept(record('active', 'chat', { expiresAt: 1000, dedupExpiresAt: 2000 }), null, LIMITS, 100);
  // Exercise the defensive pruning rule against a stale dedup timestamp left
  // by a prior host implementation or a future retention-policy migration.
  database.execute('UPDATE palmesh_dtn_seen SET expires_at = ? WHERE message_id = ?', [150, 'active']);
  await store.prune(200);
  assert.equal((await store.accept(record('active'), null, LIMITS, 200)).status, 'duplicate');
  await store.prune(1000);
  assert.equal((await store.accept(record('active'), null, LIMITS, 1000)).status, 'accepted');
});

test('SQLite bounded peer ledger permits retry and ACK updates to existing peers at capacity', async (t) => {
  const { store, database } = await memoryStore();
  t.after(() => database.close());
  const limits = { ...LIMITS, maxPeersPerMessage: 2 };
  await store.accept(record('bounded'), 'previous', limits, 100);
  await store.markFailed({ messageId: 'bounded', peerId: 'retry', attempts: 1, nextAttemptAt: 200, now: 100 });
  await store.accept(record('bounded'), 'too-many', limits, 100);
  await store.markAcknowledged('bounded', 'too-many', 100);
  await store.markFailed({ messageId: 'bounded', peerId: 'too-many', attempts: 1, nextAttemptAt: 200, now: 100 });
  assert.equal(database.execute('SELECT COUNT(*) AS count FROM palmesh_dtn_deliveries').rows[0]?.count, 2);
  assert.equal(await store.getNextDelivery(['new-peer'], 100, false, 2), null);
  assert.equal((await store.getNextDelivery(['retry'], 200, false, 2))?.attempts, 1);
  await store.markFailed({ messageId: 'bounded', peerId: 'retry', attempts: 2, nextAttemptAt: 300, now: 200 });
  assert.equal((await store.getNextDelivery(['retry'], 300, false, 2))?.attempts, 2);
  await store.markAcknowledged('bounded', 'retry', 300);
  await store.markFailed({ messageId: 'bounded', peerId: 'retry', attempts: 3, nextAttemptAt: 400, now: 300 });
  assert.equal(await store.getNextDelivery(['retry'], 400, false, 2), null);
});

test('SQLite ACKs, retries, seen IDs and history survive closing and reopening the connection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'palmesh-sqlite-'));
  const path = join(directory, 'dtn.sqlite');
  let database = new TestSqliteDatabase(path);
  try {
    let store = new SqliteDtnStore(database);
    await store.initialize();
    await store.accept(record('durable'), 'previous', LIMITS, 100);
    await store.markAcknowledged('durable', 'delivered', 110);
    await store.markFailed({ messageId: 'durable', peerId: 'retry', attempts: 3, nextAttemptAt: 900, now: 120 });
    database.close();
    database = new TestSqliteDatabase(path);
    store = new SqliteDtnStore(database);
    await store.initialize();
    await store.initialize();
    assert.equal((await store.accept(record('durable'), null, LIMITS, 200)).status, 'duplicate');
    assert.equal(await store.getNextDelivery(['previous', 'delivered'], 200, false, 16), null);
    const retry = await store.getNextDelivery(['retry'], 200, false, 16);
    assert.equal(retry?.attempts, 3);
    assert.equal(retry?.nextAttemptAt, 900);
    assert.equal((await store.listHistory(10))[0]?.message.id, 'durable');
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('SQLite migration rejects newer DTN schema without touching unrelated user_version or tables', async (t) => {
  const database = new TestSqliteDatabase();
  t.after(() => database.close());
  database.execute('PRAGMA user_version = 42');
  database.execute('CREATE TABLE unrelated (value TEXT)');
  database.execute('INSERT INTO unrelated VALUES (?)', ['keep me']);
  database.execute('CREATE TABLE palmesh_dtn_schema (singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL)');
  database.execute('INSERT INTO palmesh_dtn_schema VALUES (1, 99)');
  await assert.rejects(new SqliteDtnStore(database).initialize(), /Unsupported PalMesh DTN schema version: 99/);
  assert.equal(database.execute('PRAGMA user_version').rows[0]?.user_version, 42);
  assert.equal(database.execute('SELECT value FROM unrelated').rows[0]?.value, 'keep me');
  assert.equal(database.execute('SELECT version FROM palmesh_dtn_schema').rows[0]?.version, 99);
});

test('SQLite validates storage and peer bounds before running queries', async (t) => {
  const { store, database } = await memoryStore();
  t.after(() => database.close());
  await assert.rejects(store.accept(record('bad'), null, { ...LIMITS, maxPeersPerMessage: 0 }, 100), /maxPeersPerMessage/);
  await assert.rejects(store.accept(record('bad'), null, { ...LIMITS, reservedEmergencyMessages: 21 }, 100), /reservedEmergencyMessages/);
  await assert.rejects(store.getNextDelivery(['peer'], 100, false, 4097), /maxPeersPerMessage/);
  await assert.rejects(store.getNextDelivery(Array.from({ length: 65 }, (_, index) => `peer-${index}`), 100, false, 16), /At most 64/);
  await assert.rejects(store.listHistory(-1), /limit/);
  assert.equal((await store.listHistory(0)).length, 0);
});

test('native executeSync adapter configures durable on-disk WAL and drives the real store', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'palmesh-native-adapter-'));
  const database = new TestSqliteDatabase(join(directory, 'dtn.sqlite'));
  const nativeConnection: OpSqliteSyncConnection = {
    executeSync(sql, parameters = []) {
      return database.execute(sql, parameters as SqliteValue[]);
    },
  };
  try {
    const adapter = new OpSqliteDatabase(nativeConnection, { exclusiveConnection: true });
    assert.equal(adapter.journalMode, 'wal');
    assert.equal(database.execute('PRAGMA synchronous').rows[0]?.synchronous, 2);
    const store = new SqliteDtnStore(adapter);
    await store.initialize();
    assert.equal((await store.accept(record('native-bridge'), 'previous', LIMITS, 100)).status, 'accepted');
    assert.equal((await store.getMessage('native-bridge'))?.message.id, 'native-bridge');
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('native executeSync adapter requires explicit in-memory opt-in and rejects nondurable settings', (t) => {
  const database = new TestSqliteDatabase();
  t.after(() => database.close());
  const nativeConnection: OpSqliteSyncConnection = {
    executeSync(sql, parameters = []) { return database.execute(sql, parameters as SqliteValue[]); },
  };
  assert.throws(() => new OpSqliteDatabase(nativeConnection, { exclusiveConnection: true }), /durable SQLite journal/);
  assert.equal(new OpSqliteDatabase(nativeConnection, { exclusiveConnection: true, allowInMemory: true }).journalMode, 'memory');
  const incompatible: OpSqliteSyncConnection = {
    executeSync(sql) {
      return { rows: sql.includes('journal_mode') ? [{ journal_mode: 'wal' }] : [{ synchronous: 0 }], rowsAffected: 0 };
    },
  };
  assert.throws(() => new OpSqliteDatabase(incompatible, { exclusiveConnection: true }), /synchronous=FULL/);
});

test('native executeSync adapter normalizes native booleans/blobs while preserving bound values', () => {
  let captured: OpSqliteScalar[] = [];
  const nativeConnection: OpSqliteSyncConnection = {
    executeSync(sql, parameters = []) {
      if (sql.includes('journal_mode')) return { rows: [{ journal_mode: 'delete' }], rowsAffected: 0 };
      if (sql.includes('synchronous')) return { rows: [{ synchronous: 2 }], rowsAffected: 0 };
      captured = parameters;
      return { rows: [{ enabled: true, bytes: new Uint8Array([1, 2]).buffer, view: new DataView(new Uint8Array([3, 4]).buffer) }], rowsAffected: 1 };
    },
  };
  const adapter = new OpSqliteDatabase(nativeConnection, { exclusiveConnection: true });
  assert.equal(adapter.journalMode, 'delete');
  const value = "untrusted'); DROP TABLE palmesh_dtn_messages; --";
  const result = adapter.execute('SELECT ?', [value]);
  assert.deepEqual(captured, [value]);
  assert.equal(result.rows[0]?.enabled, 1);
  assert.deepEqual(result.rows[0]?.bytes, new Uint8Array([1, 2]));
  assert.deepEqual(result.rows[0]?.view, new Uint8Array([3, 4]));
  assert.equal(result.rowsAffected, 1);
});
