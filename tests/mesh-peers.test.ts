import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { SynchronousSqliteDatabase, SqliteValue } from '../src/features/dtn/infrastructure/sqlite/SqliteDtnStore';
import type { RadioKind } from '../src/features/mesh/domain/types';
import { SqlitePeerRegistry } from '../src/features/mesh/infrastructure/SqlitePeerRegistry';
import { TestSqliteDatabase } from './helpers/sqlite';

test('peer registry requires initialization and initialization is idempotent', async (t) => {
  const database = new TestSqliteDatabase();
  t.after(() => database.close());
  const registry = new SqlitePeerRegistry(database);
  await assert.rejects(registry.recordSeen('peer', 'ble', 1), /initialize/);
  await assert.rejects(registry.recentPeers(1), /initialize/);
  await assert.rejects(registry.prune(1), /initialize/);
  await registry.initialize();
  await registry.recordSeen('peer', 'ble', 1);
  await registry.initialize();
  assert.deepEqual(await registry.recentPeers(10), [{ peerId: 'peer', lastSeenAt: 1, radios: ['ble'] }]);
});

test('peer records survive reopening without storing endpoint identifiers or session state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'palmesh-peers-'));
  const path = join(directory, 'peers.sqlite');
  let database = new TestSqliteDatabase(path);
  try {
    let registry = new SqlitePeerRegistry(database);
    await registry.initialize();
    await registry.recordSeen('stable-peer', 'wifi-direct', 100);
    await registry.recordSeen('stable-peer', 'ble', 110);
    database.close();
    database = new TestSqliteDatabase(path);
    registry = new SqlitePeerRegistry(database);
    await registry.initialize();
    assert.deepEqual(await registry.recentPeers(10), [{
      peerId: 'stable-peer', lastSeenAt: 110, radios: ['wifi-direct', 'ble'],
    }]);
    assert.deepEqual(database.execute('PRAGMA table_info(palmesh_peers)').rows.map((row) => row.name), [
      'peer_id', 'last_seen_at', 'wifi_direct', 'ble',
    ]);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('peer observations merge capabilities without regressing last seen when clocks move backward', async (t) => {
  const database = new TestSqliteDatabase();
  t.after(() => database.close());
  const registry = new SqlitePeerRegistry(database);
  await registry.initialize();
  await registry.recordSeen('peer', 'ble', 200);
  await registry.recordSeen('peer', 'wifi-direct', 100);
  await registry.recordSeen('peer', 'ble', 150);
  const records = await registry.recentPeers(1);
  assert.deepEqual(records, [{ peerId: 'peer', lastSeenAt: 200, radios: ['wifi-direct', 'ble'] }]);
  (records[0]?.radios as RadioKind[]).pop();
  assert.deepEqual((await registry.recentPeers(1))[0]?.radios, ['wifi-direct', 'ble']);
});

test('peer registry evicts oldest entries and retains updated identities without consuming slots', async (t) => {
  const database = new TestSqliteDatabase();
  t.after(() => database.close());
  const registry = new SqlitePeerRegistry(database, { maxEntries: 2 });
  await registry.initialize();
  await registry.recordSeen('older', 'ble', 10);
  await registry.recordSeen('newer', 'ble', 20);
  await registry.recordSeen('older', 'wifi-direct', 30);
  await registry.recordSeen('newest', 'ble', 40);
  assert.deepEqual(await registry.recentPeers(10), [
    { peerId: 'newest', lastSeenAt: 40, radios: ['ble'] },
    { peerId: 'older', lastSeenAt: 30, radios: ['wifi-direct', 'ble'] },
  ]);
  // A stale discovery cannot evict a genuinely more recent identity.
  await registry.recordSeen('stale', 'ble', 1);
  assert.deepEqual((await registry.recentPeers(10)).map((peer) => peer.peerId), ['newest', 'older']);
});

test('peer registry has deterministic tie ordering and bounded limits', async (t) => {
  const database = new TestSqliteDatabase();
  t.after(() => database.close());
  const registry = new SqlitePeerRegistry(database, { maxEntries: 2 });
  await registry.initialize();
  await registry.recordSeen('peer-b', 'ble', 10);
  await registry.recordSeen('peer-a', 'ble', 10);
  await registry.recordSeen('peer-c', 'wifi-direct', 10);
  assert.deepEqual((await registry.recentPeers(4096)).map((peer) => peer.peerId), ['peer-c', 'peer-b']);
  assert.deepEqual((await registry.recentPeers(1)).map((peer) => peer.peerId), ['peer-c']);
  assert.deepEqual(await registry.recentPeers(0), []);
});

test('peer registry defaults to 256 entries and applies lower capacity when reopened', async (t) => {
  const database = new TestSqliteDatabase();
  t.after(() => database.close());
  const registry = new SqlitePeerRegistry(database);
  await registry.initialize();
  for (let index = 0; index < 257; index += 1) {
    await registry.recordSeen(`peer-${index}`, 'ble', index);
  }
  assert.equal((await registry.recentPeers(4096)).length, 256);
  assert.equal((await registry.recentPeers(4096)).at(-1)?.peerId, 'peer-1');
  const smaller = new SqlitePeerRegistry(database, { maxEntries: 1 });
  await smaller.initialize();
  assert.deepEqual(await smaller.recentPeers(4096), [{ peerId: 'peer-256', lastSeenAt: 256, radios: ['ble'] }]);
});

test('peer pruning removes observations strictly older than the requested cutoff', async (t) => {
  const database = new TestSqliteDatabase();
  t.after(() => database.close());
  const registry = new SqlitePeerRegistry(database);
  await registry.initialize();
  await registry.recordSeen('old', 'ble', 10);
  await registry.recordSeen('cutoff', 'ble', 20);
  await registry.recordSeen('recent', 'wifi-direct', 30);
  await registry.prune(20);
  assert.deepEqual((await registry.recentPeers(10)).map((peer) => peer.peerId), ['recent', 'cutoff']);
  await registry.prune(0);
  assert.equal((await registry.recentPeers(10)).length, 2);
});

test('peer registry validates peer IDs, radios, timestamps, capacity, and result limits', async (t) => {
  const database = new TestSqliteDatabase();
  t.after(() => database.close());
  for (const maxEntries of [0, -1, 4097, 0.5, NaN, Infinity]) {
    assert.throws(() => new SqlitePeerRegistry(database, { maxEntries }), /maxEntries/);
  }
  assert.doesNotThrow(() => new SqlitePeerRegistry(database, { maxEntries: 4096 }));
  const registry = new SqlitePeerRegistry(database);
  await registry.initialize();
  for (const peer of ['', '*', 'peer\n', 'peer id', "peer'); DROP TABLE palmesh_peers; --", 'p'.repeat(129)]) {
    await assert.rejects(registry.recordSeen(peer, 'ble', 1), /peerId/);
  }
  await assert.rejects(registry.recordSeen('peer', 'unknown' as RadioKind, 1), /radio/);
  for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(registry.recordSeen('peer', 'ble', value), /now/);
    await assert.rejects(registry.prune(value), /before/);
  }
  for (const limit of [-1, 0.5, 4097, NaN, Infinity]) {
    await assert.rejects(registry.recentPeers(limit), /limit/);
  }
  assert.deepEqual(await registry.recentPeers(4096), []);
  await registry.recordSeen('peer-a._:9', 'ble', Number.MAX_SAFE_INTEGER);
  assert.equal((await registry.recentPeers(1))[0]?.lastSeenAt, Number.MAX_SAFE_INTEGER);
});

test('failed peer eviction rolls back new observation and preserves prior capacity', async (t) => {
  const database = new TestSqliteDatabase();
  t.after(() => database.close());
  let failTrim = false;
  const driver: SynchronousSqliteDatabase = {
    execute(sql, parameters: readonly SqliteValue[] = []) {
      const result = database.execute(sql, parameters);
      if (failTrim && sql.includes('DELETE FROM palmesh_peers WHERE peer_id IN')) {
        throw new Error('simulated trim failure');
      }
      return result;
    },
  };
  const registry = new SqlitePeerRegistry(driver, { maxEntries: 1 });
  await registry.initialize();
  await registry.recordSeen('existing', 'ble', 10);
  failTrim = true;
  await assert.rejects(registry.recordSeen('new', 'wifi-direct', 20), /simulated trim failure/);
  assert.deepEqual(await registry.recentPeers(10), [{ peerId: 'existing', lastSeenAt: 10, radios: ['ble'] }]);
  await assert.rejects(registry.recordSeen('existing', 'wifi-direct', 30), /simulated trim failure/);
  assert.deepEqual(await registry.recentPeers(10), [{ peerId: 'existing', lastSeenAt: 10, radios: ['ble'] }]);
  failTrim = false;
  await registry.recordSeen('new', 'wifi-direct', 20);
  assert.deepEqual(await registry.recentPeers(10), [{ peerId: 'new', lastSeenAt: 20, radios: ['wifi-direct'] }]);
});

test('failed peer schema initialization rolls back and can retry after storage recovers', async (t) => {
  const database = new TestSqliteDatabase();
  t.after(() => database.close());
  let failMigration = true;
  const driver: SynchronousSqliteDatabase = {
    execute(sql, parameters: readonly SqliteValue[] = []) {
      if (failMigration && sql.includes('INSERT INTO palmesh_peers_schema')) throw new Error('simulated migration failure');
      return database.execute(sql, parameters);
    },
  };
  const registry = new SqlitePeerRegistry(driver);
  await assert.rejects(registry.initialize(), /simulated migration failure/);
  assert.equal(database.execute("SELECT COUNT(*) AS count FROM sqlite_master WHERE name LIKE 'palmesh_peers%'").rows[0]?.count, 0);
  await assert.rejects(registry.recentPeers(1), /initialize/);
  failMigration = false;
  await registry.initialize();
  await registry.recordSeen('peer', 'ble', 10);
  assert.equal((await registry.recentPeers(1))[0]?.peerId, 'peer');
});

test('newer peer schema is rejected without touching unrelated DTN schema or user version', async (t) => {
  const database = new TestSqliteDatabase();
  t.after(() => database.close());
  database.execute('PRAGMA user_version = 42');
  database.execute('CREATE TABLE palmesh_dtn_schema (singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL)');
  database.execute('INSERT INTO palmesh_dtn_schema VALUES (1, 1)');
  database.execute('CREATE TABLE palmesh_peers_schema (singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL)');
  database.execute('INSERT INTO palmesh_peers_schema VALUES (1, 2)');
  await assert.rejects(new SqlitePeerRegistry(database).initialize(), /Unsupported PalMesh peer schema version: 2/);
  assert.equal(database.execute('PRAGMA user_version').rows[0]?.user_version, 42);
  assert.equal(database.execute('SELECT version FROM palmesh_dtn_schema').rows[0]?.version, 1);
  assert.equal(database.execute('SELECT version FROM palmesh_peers_schema').rows[0]?.version, 2);
});
