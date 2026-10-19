import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { LocationFix } from '../src/features/dtn/domain/types';
import { SqliteDtnStore, type SynchronousSqliteDatabase } from '../src/features/dtn/infrastructure/sqlite/SqliteDtnStore';
import { SqliteChatRepository } from '../src/features/chat/infrastructure/SqliteChatRepository';
import { SqliteLocationRepository } from '../src/features/maps/infrastructure/SqliteLocationRepository';
import type { PeerLocation } from '../src/features/maps/domain/types';
import { TestSqliteDatabase } from './helpers/sqlite';

const FIX: LocationFix = { latitude: 31.5, longitude: 34.4, timestamp: 1_000 };
function peer(deviceId = 'bob', timestamp = 1_000, receivedAt = 2_000): PeerLocation {
  return { deviceId, location: { ...FIX, timestamp }, receivedAt, messageId: randomUUID(), origin: 'location' };
}
async function fixture(t: TestContext, maxPeers?: number) {
  const database = new TestSqliteDatabase();
  t.after(() => database.close());
  const repository = new SqliteLocationRepository(database, maxPeers === undefined ? {} : { maxPeers });
  await repository.initialize('alice');
  return { database, repository };
}

test('requires initialization, validates configuration and identity, and starts with an immutable empty registry', async t => {
  const database = new TestSqliteDatabase(); t.after(() => database.close());
  const repository = new SqliteLocationRepository(database);
  assert.equal(repository.maxPeers, 1_000);
  await assert.rejects(repository.read(), /Initialize/);
  await assert.rejects(repository.saveLocal(FIX), /Initialize/);
  await assert.rejects(repository.upsertPeers([]), /Initialize/);
  await assert.rejects(repository.initialize('invalid identity'), TypeError);
  for (const maxPeers of [0, -1, 1.5, 20_001, NaN]) assert.throws(() => new SqliteLocationRepository(database, { maxPeers }), RangeError);
  await repository.initialize('alice');
  const state = await repository.read();
  assert.deepEqual(state, { localLocation: null, peers: [] });
  assert.equal(Object.isFrozen(state), true); assert.equal(Object.isFrozen(state.peers), true);
});

test('persists own GPS separately from peers and restores both after a real SQLite reopen', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'palmesh-location-'));
  const path = join(directory, 'locations.sqlite');
  let database = new TestSqliteDatabase(path);
  t.after(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });
  let repository = new SqliteLocationRepository(database);
  await repository.initialize('alice'); await repository.saveLocal(FIX);
  const bob = peer();
  await repository.upsertPeers([bob, peer('alice')]);
  database.close(); database = new TestSqliteDatabase(path);
  repository = new SqliteLocationRepository(database); await repository.initialize('alice');
  assert.deepEqual(await repository.read(), { localLocation: FIX, peers: [bob] });
});

test('binds the database to one identity and refuses unknown schema versions without changing stored fixes', async t => {
  const { database, repository } = await fixture(t);
  await repository.saveLocal(FIX); await repository.upsertPeers([peer()]);
  await assert.rejects(repository.initialize('mallory'), /another device identity/);
  await assert.rejects(new SqliteLocationRepository(database).initialize('mallory'), /another device identity/);
  assert.equal((await repository.read()).peers.length, 1);
  database.execute('UPDATE palmesh_location_schema SET version = 2 WHERE singleton = 1');
  await assert.rejects(new SqliteLocationRepository(database).initialize('alice'), /Unsupported/);
  assert.equal(database.execute('SELECT fix_timestamp FROM palmesh_local_location').rows[0]?.fix_timestamp, 1_000);
});

test('updates local fixes only for a strictly newer timestamp and never stores malformed coordinates', async t => {
  const { repository } = await fixture(t);
  await repository.saveLocal(FIX);
  await repository.saveLocal({ ...FIX, latitude: 0 });
  await repository.saveLocal({ ...FIX, latitude: 1, timestamp: 999 });
  assert.deepEqual((await repository.read()).localLocation, FIX);
  await repository.saveLocal({ ...FIX, latitude: 32, timestamp: 2_000 });
  await assert.rejects(repository.saveLocal({ ...FIX, longitude: 181, timestamp: 3_000 }), TypeError);
  assert.deepEqual((await repository.read()).localLocation, { ...FIX, latitude: 32, timestamp: 2_000 });
});

test('does not refresh peer receipt age for repeated, same-time, or older fixes', async t => {
  const { repository } = await fixture(t);
  const first = peer(); await repository.upsertPeers([first]);
  await repository.upsertPeers([{ ...first, receivedAt: 9_000 }]);
  await repository.upsertPeers([{ ...peer('bob', 1_000, 10_000), location: { ...FIX, latitude: 0 } }]);
  await repository.upsertPeers([peer('bob', 999, 11_000)]);
  // A UUID names one immutable packet. Even a caller attempting to reuse its
  // current UUID with a changed fix cannot make that duplicate look newer.
  await repository.upsertPeers([{ ...first, location: { ...FIX, timestamp: 2_000 }, receivedAt: 12_000 }]);
  assert.deepEqual((await repository.read()).peers, [first]);
  const newer = { ...peer('bob', 2_000, 3_000), origin: 'sos' as const };
  await repository.upsertPeers([newer]);
  assert.deepEqual((await repository.read()).peers, [newer]);
});

test('bounds peers by oldest local receipt with deterministic ties and stale replay cannot pin a peer', async t => {
  const { repository } = await fixture(t, 2);
  const bob = peer('bob', 1_000, 1_000); const carol = peer('carol', 1_000, 1_000); const david = peer('david', 1_000, 2_000);
  await repository.upsertPeers([bob, carol, david]);
  assert.deepEqual((await repository.read()).peers.map(value => value.deviceId), ['david', 'bob']);
  await repository.upsertPeers([{ ...bob, receivedAt: 99_000 }]);
  await repository.upsertPeers([peer('edward', 1_000, 3_000)]);
  assert.deepEqual((await repository.read()).peers.map(value => value.deviceId), ['edward', 'david']);
});

test('validates an entire peer batch before writing and rejects malformed IDs, origins, coordinates and times', async t => {
  const { repository } = await fixture(t);
  const invalids: readonly unknown[] = [
    { ...peer(), deviceId: 'bad peer' }, { ...peer(), messageId: 'not-a-uuid' }, { ...peer(), origin: 'chat' },
    { ...peer(), receivedAt: -1 }, { ...peer(), receivedAt: Number.MAX_SAFE_INTEGER + 1 },
    { ...peer(), location: { ...FIX, latitude: Infinity } },
  ];
  for (const invalid of invalids) await assert.rejects(repository.upsertPeers([peer('valid'), invalid as PeerLocation]), TypeError);
  assert.deepEqual((await repository.read()).peers, []);
});

test('rolls back the whole peer batch on a SQLite write failure and can retry successfully', async t => {
  const { database, repository } = await fixture(t);
  const original = peer('bob'); await repository.upsertPeers([original]);
  database.execute(`CREATE TRIGGER simulate_peer_failure BEFORE INSERT ON palmesh_peer_locations
    WHEN NEW.device_id = 'carol' BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END`);
  const newer = peer('bob', 2_000, 3_000); const carol = peer('carol', 2_000, 3_000);
  await assert.rejects(repository.upsertPeers([newer, carol]), /simulated storage failure/);
  assert.deepEqual((await repository.read()).peers, [original]);
  database.execute('DROP TRIGGER simulate_peer_failure');
  await repository.upsertPeers([newer, carol]);
  assert.deepEqual((await repository.read()).peers, [newer, carol]);
});

test('rolls back failed schema initialization so a later retry creates a usable registry', async t => {
  const database = new TestSqliteDatabase(); t.after(() => database.close());
  let fail = true;
  const driver: SynchronousSqliteDatabase = { execute(sql, parameters) {
    if (fail && sql.includes('INSERT INTO palmesh_location_schema')) throw new Error('simulated initialization failure');
    return database.execute(sql, parameters);
  } };
  const repository = new SqliteLocationRepository(driver);
  await assert.rejects(repository.initialize('alice'), /simulated initialization failure/);
  assert.equal(database.execute("SELECT name FROM sqlite_master WHERE name LIKE 'palmesh_location_%' OR name IN ('palmesh_local_location', 'palmesh_peer_locations')").rows.length, 0);
  fail = false; await repository.initialize('alice'); await repository.saveLocal(FIX);
  assert.deepEqual((await repository.read()).localLocation, FIX);
});

test('snapshots stored and returned fixes immutably and normalizes message UUID case', async t => {
  const { repository } = await fixture(t);
  const original = peer();
  const mutable = { ...original, location: { ...original.location }, messageId: original.messageId.toUpperCase() };
  await repository.saveLocal(FIX); await repository.upsertPeers([mutable]);
  mutable.location.latitude = 0;
  const snapshot = await repository.read();
  assert.equal(snapshot.peers[0]?.location.latitude, FIX.latitude);
  assert.equal(snapshot.peers[0]?.messageId, original.messageId.toLowerCase());
  assert.equal(Object.isFrozen(snapshot.localLocation), true);
  assert.equal(Object.isFrozen(snapshot.peers[0]), true);
  assert.equal(Object.isFrozen(snapshot.peers[0]?.location), true);
  assert.throws(() => { (snapshot.peers[0]!.location as { latitude: number }).latitude = 0; }, TypeError);
  assert.equal((await repository.read()).peers[0]?.location.latitude, FIX.latitude);
});

test('coexists with routing/chat schemas and preserves SQLite global user_version', async t => {
  const { database, repository } = await fixture(t);
  database.execute('PRAGMA user_version = 42');
  await new SqliteDtnStore(database).initialize();
  const chat = new SqliteChatRepository(database); await chat.initialize(); await chat.upsert([], 'alice');
  await repository.saveLocal(FIX); await repository.upsertPeers([peer()]);
  assert.equal(database.execute('PRAGMA user_version').rows[0]?.user_version, 42);
  assert.equal((await repository.read()).peers.length, 1);
  assert.deepEqual(await chat.listConversations(), []);
});

test('enforces a reduced peer capacity while reopening an existing registry', async t => {
  const { database, repository } = await fixture(t, 3);
  await repository.upsertPeers([peer('bob', 1_000, 1_000), peer('carol', 1_000, 2_000), peer('david', 1_000, 3_000)]);
  const smaller = new SqliteLocationRepository(database, { maxPeers: 2 });
  await smaller.initialize('alice');
  assert.deepEqual((await smaller.read()).peers.map(value => value.deviceId), ['david', 'carol']);
});
