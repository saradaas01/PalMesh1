import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { DtnEngine } from '../src/features/dtn/application/DtnEngine';
import type { AcceptResult, DtnEvent, LocationFix, OutgoingMessage, StoredMessage } from '../src/features/dtn/domain/types';
import { createMessage } from '../src/features/dtn/domain/validation';
import { SqliteDtnStore } from '../src/features/dtn/infrastructure/sqlite/SqliteDtnStore';
import { LocationService } from '../src/features/maps/application/LocationService';
import type { LocationEngine, LocationRepository, LocationSource, OfflineMapSource } from '../src/features/maps/domain/ports';
import type { GpsResult, OfflineMapDescriptor } from '../src/features/maps/domain/types';
import { SqliteLocationRepository } from '../src/features/maps/infrastructure/SqliteLocationRepository';
import { deferred, stored, until } from './helpers/chat';
import { TestSqliteDatabase } from './helpers/sqlite';

const fix = (timestamp = 100_000, latitude = 31.5): LocationFix => ({ latitude, longitude: 34.4, timestamp });

class ControlledLocationEngine implements LocationEngine {
  readonly deviceId = 'alice';
  readonly listeners = new Set<(event: DtnEvent) => void>();
  readonly publications: OutgoingMessage[] = [];
  records: StoredMessage[] = [];
  readHistory: () => Promise<readonly StoredMessage[]> = async () => this.records;
  publishNext: ((input: OutgoingMessage) => Promise<Exclude<AcceptResult, { status: 'duplicate' }>>) | undefined;

  subscribe(listener: (event: DtnEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  history(): Promise<readonly StoredMessage[]> { return this.readHistory(); }
  async publish(input: OutgoingMessage): Promise<Exclude<AcceptResult, { status: 'duplicate' }>> {
    this.publications.push(input);
    if (this.publishNext) return this.publishNext(input);
    const record = stored(input, this.deviceId, 100_000);
    this.records.push(record);
    this.emit({ type: 'accepted', record, local: true });
    return { status: 'accepted', record };
  }
  emit(event: DtnEvent): void { for (const listener of [...this.listeners]) listener(event); }
  incoming(location: LocationFix, source = 'bob', receivedAt = 100_000, kind: 'location' | 'sos' = 'location'): StoredMessage {
    const record = stored(kind === 'location'
      ? { kind, payload: { location } }
      : { kind, payload: { text: 'Help', location } }, source, receivedAt);
    this.records.push(record);
    this.emit({ type: 'accepted', record, local: false });
    return record;
  }
}

class ControlledLocationSource implements LocationSource {
  readonly signals: AbortSignal[] = [];
  result: GpsResult = { status: 'fix', location: fix() };
  readNext: ((signal: AbortSignal) => Promise<GpsResult>) | undefined;
  read(signal: AbortSignal): Promise<GpsResult> {
    this.signals.push(signal);
    return this.readNext ? this.readNext(signal) : Promise.resolve(this.result);
  }
}

function wrapRepository(repository: LocationRepository, overrides: Partial<LocationRepository>): LocationRepository {
  return {
    initialize: id => repository.initialize(id),
    saveLocal: location => repository.saveLocal(location),
    upsertPeers: peers => repository.upsertPeers(peers),
    read: () => repository.read(),
    ...overrides,
  };
}

function fixture(t: TestContext, options: {
  engine?: ControlledLocationEngine;
  source?: ControlledLocationSource;
  wrap?: (repository: LocationRepository) => LocationRepository;
  mapSource?: OfflineMapSource;
} = {}) {
  const database = new TestSqliteDatabase();
  const archive = new SqliteLocationRepository(database);
  const engine = options.engine ?? new ControlledLocationEngine();
  const source = options.source ?? new ControlledLocationSource();
  const time = { value: 100_000 };
  const service = new LocationService({
    engine, source, repository: options.wrap?.(archive) ?? archive,
    clock: { now: () => time.value },
    ...(options.mapSource ? { mapSource: options.mapSource } : {}),
  });
  t.after(async () => { await service.stop(); database.close(); });
  return { service, archive, database, engine, source, time };
}

async function settle(): Promise<void> {
  for (let iteration = 0; iteration < 8; iteration += 1) await new Promise<void>(resolve => setImmediate(resolve));
}

test('recovers local and relayed peer fixes from SQLite after the routing queue expires and the app restarts', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'palmesh-maps-'));
  const path = join(directory, 'offline.sqlite');
  const time = { value: 100_000 };
  let database = new TestSqliteDatabase(path);
  const source = new ControlledLocationSource();
  const runtime = () => {
    const engine = new DtnEngine({
      deviceId: 'alice', store: new SqliteDtnStore(database), ids: { next: randomUUID },
      clock: { now: () => time.value }, transport: { async send() {} },
    });
    const service = new LocationService({ engine, source, repository: new SqliteLocationRepository(database), clock: { now: () => time.value } });
    return { engine, service };
  };
  let { engine, service } = runtime();
  t.after(async () => { await service.stop(); await engine.stop(); database.close(); rmSync(directory, { recursive: true, force: true }); });
  await engine.start(); await service.start();
  assert.deepEqual(await service.refreshLocal(), { status: 'updated' });
  const packet = createMessage({ kind: 'location', payload: { location: fix(99_000, 31.7) } }, randomUUID(), 'bob', 99_000);
  assert.equal((await engine.receive('carrier', packet)).status, 'accepted');
  await until(() => service.getSnapshot().peers.length === 1, 'durable peer location');
  assert.equal(service.getSnapshot().peers[0]?.deviceId, 'bob');
  assert.equal(service.getSnapshot().peers[0]?.origin, 'location');
  assert.equal((await engine.history()).length, 1, 'local GPS refresh must not silently broadcast');
  await service.stop(); await engine.stop(); database.close();
  time.value += 2 * 24 * 60 * 60 * 1_000;
  database = new TestSqliteDatabase(path);
  ({ engine, service } = runtime());
  await engine.start(); await service.start();
  assert.equal((await engine.history()).length, 0, 'routing retention has expired');
  assert.deepEqual(service.getSnapshot().localLocation, fix());
  assert.deepEqual(service.getSnapshot().peers.map(peer => [peer.deviceId, peer.location, peer.receivedAt]), [['bob', fix(99_000, 31.7), 100_000]]);
  assert.equal(service.getSnapshot().sharing, false);
});

test('never reads GPS or broadcasts by default, and refreshing a fix remains local until explicitly shared', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const { service, source, engine, time } = fixture(t);
  await service.start();
  time.value += 180_000; t.mock.timers.tick(180_000); await settle();
  assert.equal(source.signals.length, 0);
  assert.equal(engine.publications.length, 0);
  assert.equal(service.getSnapshot().sharing, false);
  assert.deepEqual(await service.refreshLocal(), { status: 'updated' });
  assert.equal(source.signals.length, 1);
  assert.equal(engine.publications.length, 0);
  assert.deepEqual(service.getSnapshot().localLocation, fix());
  assert.equal(service.getSnapshot().notice, null);
  const result = await service.shareOnce();
  assert.equal(result.status, 'queued');
  assert.deepEqual(engine.publications, [{ kind: 'location', payload: { location: fix() } }]);
  assert.equal(engine.records[0]?.message.ttl, 10);
  assert.equal(service.getSnapshot().notice, 'location-queued');
  assert.deepEqual(service.getSnapshot().peers, [], 'the local broadcast is not a peer marker');
});

for (const result of ['denied', 'unavailable'] as const) {
  test(`surfaces ${result} GPS without publishing an invented or stale fix`, async t => {
    const { service, source, engine } = fixture(t);
    await service.start(); await service.refreshLocal();
    source.result = { status: result };
    assert.deepEqual(await service.shareOnce(), { status: 'rejected', reason: 'no-location' });
    assert.equal(service.getSnapshot().issue, result === 'denied' ? 'gps-denied' : 'gps-unavailable');
    assert.equal(service.getSnapshot().locating, false);
    assert.equal(service.getSnapshot().notice, null);
    assert.equal(engine.publications.length, 0);
    assert.deepEqual(service.getSnapshot().localLocation, fix(), 'last-known fix stays visible with its timestamp');
  });
}

test('queue capacity and routing exceptions never produce a successful location-sharing notice', async t => {
  const { service, source, engine, archive } = fixture(t);
  await service.start();
  engine.publishNext = async () => ({ status: 'full', resource: 'messages' });
  assert.deepEqual(await service.shareOnce(), { status: 'rejected', reason: 'capacity' });
  assert.equal(service.getSnapshot().issue, 'queue-full');
  assert.equal(service.getSnapshot().notice, null);
  assert.deepEqual((await archive.read()).localLocation, fix(), 'a full routing queue must not discard a captured local fix');
  source.result = { status: 'fix', location: fix(100_001) };
  engine.publishNext = async () => { throw new Error('Routing database unavailable'); };
  assert.deepEqual(await service.shareOnce(), { status: 'rejected', reason: 'unavailable' });
  assert.equal(service.getSnapshot().issue, 'broadcast-unavailable');
  assert.equal(service.getSnapshot().notice, null);
  assert.equal(service.getSnapshot().locating, false);
});

test('automatic sharing requires opt-in, pauses in background and conserve mode, and leaves explicit foreground sharing available', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const { service, engine, source, time } = fixture(t);
  await service.start(); await service.setSharing(true);
  assert.equal(engine.publications.length, 1, 'opting in captures and shares immediately');
  assert.equal(service.getSnapshot().sharing, true);
  time.value += 60_000; t.mock.timers.tick(60_000); await settle();
  assert.equal(engine.publications.length, 2);
  service.setVisible(false);
  const hiddenReads = source.signals.length;
  time.value += 180_000; t.mock.timers.tick(180_000); await settle();
  assert.equal(source.signals.length, hiddenReads);
  assert.equal(engine.publications.length, 2);
  assert.deepEqual(await service.shareOnce(), { status: 'rejected', reason: 'unavailable' });
  assert.equal(source.signals.length, hiddenReads, 'explicit sharing also requires a foreground screen');
  service.setPowerMode('conserve'); service.setVisible(true); await settle();
  time.value += 120_000; t.mock.timers.tick(120_000); await settle();
  assert.equal(engine.publications.length, 2);
  assert.equal((await service.shareOnce()).status, 'queued', 'an explicit foreground action can override automatic battery conservation');
  service.setPowerMode('normal'); await settle();
  const beforeInterval = engine.publications.length;
  time.value += 60_000; t.mock.timers.tick(60_000); await settle();
  assert.equal(engine.publications.length, beforeInterval + 1);
  await service.setSharing(false);
  const disabledReads = source.signals.length;
  time.value += 120_000; t.mock.timers.tick(120_000); await settle();
  assert.equal(source.signals.length, disabledReads);
  await service.stop(); await service.start();
  assert.equal(service.getSnapshot().sharing, false, 'sharing consent does not silently survive a stopped session');
});

test('stopping aborts an active GPS request and ignores a noncooperative source that returns a late fix', { timeout: 5_000 }, async t => {
  const release = deferred<GpsResult>();
  t.after(() => release.resolve({ status: 'cancelled' }));
  const { service, source, engine, archive } = fixture(t);
  source.readNext = () => release.promise;
  await service.start();
  const locating = service.shareOnce();
  await until(() => source.signals.length === 1);
  assert.equal(service.getSnapshot().locating, true);
  await service.stop();
  assert.equal(source.signals[0]?.aborted, true);
  assert.equal(service.getSnapshot().locating, false);
  release.resolve({ status: 'fix', location: fix() });
  assert.equal((await locating).status, 'rejected');
  assert.equal(engine.publications.length, 0);
  assert.equal((await archive.read()).localLocation, null);
  await service.start();
  assert.equal(service.getSnapshot().localLocation, null);
});

test('backgrounding aborts GPS so its late result cannot publish after the screen is hidden', { timeout: 5_000 }, async t => {
  const release = deferred<GpsResult>();
  t.after(() => release.resolve({ status: 'cancelled' }));
  const { service, source, engine } = fixture(t);
  source.readNext = () => release.promise;
  await service.start();
  const locating = service.shareOnce();
  await until(() => source.signals.length === 1);
  service.setVisible(false);
  assert.equal(source.signals[0]?.aborted, true);
  release.resolve({ status: 'fix', location: fix() });
  assert.equal((await locating).status, 'rejected');
  assert.equal(engine.publications.length, 0);
  assert.equal(service.getSnapshot().localLocation, null);
});

test('disabling automatic sharing aborts an in-flight opt-in capture without publishing its late fix', { timeout: 5_000 }, async t => {
  const release = deferred<GpsResult>();
  t.after(() => release.resolve({ status: 'cancelled' }));
  const { service, source, engine } = fixture(t);
  source.readNext = () => release.promise;
  await service.start();
  const enabling = service.setSharing(true);
  await until(() => source.signals.length === 1);
  assert.equal(service.getSnapshot().sharing, true);
  await service.setSharing(false);
  assert.equal(source.signals[0]?.aborted, true);
  release.resolve({ status: 'fix', location: fix() });
  await enabling;
  assert.equal(engine.publications.length, 0);
  assert.equal(service.getSnapshot().sharing, false);
  assert.equal(service.getSnapshot().localLocation, null);
  assert.equal(service.getSnapshot().locating, false);
});

test('a malformed or excessively future GPS result cannot enter local storage or a broadcast', async t => {
  const { service, source, engine, archive } = fixture(t);
  await service.start();
  for (const location of [fix(500_001), fix(100_000, Number.NaN), { ...fix(), longitude: 181 }]) {
    source.result = { status: 'fix', location };
    assert.deepEqual(await service.shareOnce(), { status: 'rejected', reason: 'no-location' });
    assert.equal(service.getSnapshot().issue, 'gps-unavailable');
    assert.equal(service.getSnapshot().locating, false);
  }
  assert.equal(engine.publications.length, 0);
  assert.equal((await archive.read()).localLocation, null);
});

test('subscribes before routing history resolves and retains strictly newest fixes across duplicate and older packets', { timeout: 5_000 }, async t => {
  const engine = new ControlledLocationEngine();
  const old = engine.incoming(fix(90_000), 'bob', 91_000);
  const entered = deferred(); const release = deferred();
  engine.readHistory = async () => { entered.resolve(); await release.promise; return [old]; };
  t.after(() => release.resolve());
  const { service, archive } = fixture(t, { engine });
  const starting = service.start(); await entered.promise;
  assert.equal(engine.listeners.size, 1);
  const newest = engine.incoming(fix(99_000, 31.9), 'bob', 100_001, 'sos');
  engine.emit({ type: 'accepted', record: newest, local: false });
  engine.incoming(fix(95_000, 31.8), 'bob', 100_002);
  engine.incoming(fix(99_000, 32), 'bob', 100_003);
  engine.incoming(fix(98_000), 'carol', 100_004);
  release.resolve(); await starting;
  await until(() => service.getSnapshot().peers.length === 2 && service.getSnapshot().peers.some(peer => peer.deviceId === 'bob' && peer.location.timestamp === 99_000));
  const bob = service.getSnapshot().peers.find(peer => peer.deviceId === 'bob');
  assert.deepEqual(bob?.location, fix(99_000, 31.9));
  assert.equal(bob?.receivedAt, 100_001, 'duplicates cannot make a stale report look newly seen');
  assert.equal(bob?.origin, 'sos');
  assert.equal(bob?.messageId, newest.message.id);
  await service.refresh();
  assert.deepEqual((await archive.read()).peers.find(peer => peer.deviceId === 'bob'), bob);
  assert.equal(service.getSnapshot().peers.find(peer => peer.deviceId === 'bob')?.receivedAt, 100_001);
});

test('coalesces a dense peer-location burst without dropping newer fixes or duplicating device markers', async t => {
  const { service, engine, archive } = fixture(t);
  await service.start();
  for (let index = 0; index < 275; index += 1) {
    const record = engine.incoming(fix(99_000 + index), `peer-${index}`, 100_000 + index);
    engine.emit({ type: 'accepted', record, local: false });
  }
  engine.incoming(fix(100_000, 31.9), 'peer-150', 100_500, 'sos');
  engine.incoming(fix(99_100), 'peer-150', 100_501);
  await until(() => service.getSnapshot().peers.length === 275, 'all bounded location batches');
  const peers = (await archive.read()).peers;
  assert.equal(new Set(peers.map(peer => peer.deviceId)).size, 275);
  assert.deepEqual(peers.find(peer => peer.deviceId === 'peer-150')?.location, fix(100_000, 31.9));
  assert.equal(peers.find(peer => peer.deviceId === 'peer-150')?.receivedAt, 100_500);
});

test('SOS floods with a cached timestamped fix and never requests GPS before publishing', async t => {
  const { service, source, engine, time } = fixture(t);
  await service.start(); await service.refreshLocal();
  time.value += 24 * 60 * 60 * 1_000;
  source.readNext = async () => { throw new Error('SOS must not wait for a fresh GPS fix'); };
  assert.equal((await service.sendSos()).status, 'queued');
  assert.equal(source.signals.length, 1);
  assert.deepEqual(engine.publications[0], { kind: 'sos', payload: { text: 'I need help', location: fix() } });
  assert.equal(engine.records[0]?.message.ttl, 15);
  assert.equal(service.getSnapshot().notice, 'sos-queued');
});

test('SOS queues immediately during an in-flight GPS capture and overlapping GPS actions do not start another request', { timeout: 5_000 }, async t => {
  const release = deferred<GpsResult>();
  t.after(() => release.resolve({ status: 'cancelled' }));
  const { service, source, engine } = fixture(t);
  source.readNext = () => release.promise;
  await service.start();
  const sharing = service.shareOnce();
  await until(() => source.signals.length === 1);
  assert.deepEqual(await service.refreshLocal(), { status: 'rejected', reason: 'busy' });
  assert.deepEqual(await service.shareOnce(), { status: 'rejected', reason: 'busy' });
  assert.equal((await service.sendSos()).status, 'queued');
  assert.deepEqual(engine.publications, [{ kind: 'sos', payload: { text: 'I need help' } }]);
  assert.equal(source.signals.length, 1);
  release.resolve({ status: 'fix', location: fix() });
  assert.equal((await sharing).status, 'queued');
  assert.equal(engine.publications[1]?.kind, 'location');
});

test('SOS remains immediate when archive initialization or peer writes are stalled, and unavailable history cannot suppress it', { timeout: 5_000 }, async t => {
  const initializeEntered = deferred(); const initializeRelease = deferred();
  const writeEntered = deferred(); const writeRelease = deferred();
  let blockWrite = false;
  t.after(() => { initializeRelease.resolve(); writeRelease.resolve(); });
  const { service, engine, source } = fixture(t, { wrap: repository => wrapRepository(repository, {
    async initialize(id) { initializeEntered.resolve(); await initializeRelease.promise; await repository.initialize(id); },
    async upsertPeers(peers) { if (blockWrite) { writeEntered.resolve(); await writeRelease.promise; } await repository.upsertPeers(peers); },
  }) });
  const starting = service.start(); await initializeEntered.promise;
  assert.equal((await service.sendSos()).status, 'queued');
  assert.deepEqual(engine.publications[0], { kind: 'sos', payload: { text: 'I need help' } });
  assert.equal(source.signals.length, 0);
  initializeRelease.resolve(); await starting;
  blockWrite = true; engine.incoming(fix(), 'bob'); await writeEntered.promise;
  assert.equal((await service.sendSos()).status, 'queued');
  assert.equal(engine.publications.length, 2);
  writeRelease.resolve();
  await until(() => service.getSnapshot().peers.length === 1);
});

test('SOS stays available after a storage failure and rejects capacity without an incorrect success notice', async t => {
  const { service, engine } = fixture(t, { wrap: repository => wrapRepository(repository, {
    async initialize() { throw new Error('Maps database unavailable'); },
  }) });
  await service.start();
  assert.equal(service.getSnapshot().issue, 'storage-unavailable');
  assert.equal((await service.sendSos()).status, 'queued');
  assert.equal(service.getSnapshot().notice, 'sos-queued');
  service.dismissNotice();
  engine.publishNext = async () => ({ status: 'full', resource: 'dedup' });
  assert.deepEqual(await service.sendSos(), { status: 'rejected', reason: 'capacity' });
  assert.equal(service.getSnapshot().issue, 'queue-full');
  assert.equal(service.getSnapshot().notice, null);
  assert.equal(service.getSnapshot().pendingSos, false);
});

test('refresh recovers a temporary archive failure and live routing errors remain visible while peer updates continue', async t => {
  let fail = true;
  const { service, engine } = fixture(t, { wrap: repository => wrapRepository(repository, {
    async initialize(id) { if (fail) throw new Error('Maps database temporarily unavailable'); await repository.initialize(id); },
  }) });
  await service.start();
  assert.equal(service.getSnapshot().status, 'error');
  engine.incoming(fix(99_000));
  fail = false; await service.refresh();
  await until(() => service.getSnapshot().peers.length === 1);
  assert.equal(service.getSnapshot().status, 'ready');
  assert.equal(service.getSnapshot().issue, null);
  engine.emit({ type: 'error', operation: 'forwarding', error: new Error('Radio disconnected') });
  engine.incoming(fix(), 'carol');
  await until(() => service.getSnapshot().peers.length === 2);
  assert.equal(service.getSnapshot().issue, 'routing-error');
  service.dismissIssue();
  assert.equal(service.getSnapshot().issue, null);
});

test('SOS busy guard prevents duplicate taps while the routing commit is pending', { timeout: 5_000 }, async t => {
  const commit = deferred<Exclude<AcceptResult, { status: 'duplicate' }>>();
  t.after(() => commit.resolve({ status: 'full', resource: 'messages' }));
  const { service, engine } = fixture(t);
  await service.start();
  engine.publishNext = () => commit.promise;
  const sending = service.sendSos();
  assert.deepEqual(await service.sendSos(), { status: 'rejected', reason: 'busy' });
  assert.equal(engine.publications.length, 1);
  assert.equal(service.getSnapshot().pendingSos, true);
  commit.resolve({ status: 'accepted', record: stored({ kind: 'sos', payload: { text: 'I need help' } }) });
  assert.equal((await sending).status, 'queued');
  assert.equal(service.getSnapshot().pendingSos, false);
});

test('offline tile failure preserves peer-list operation and stop closes only the maps source', async t => {
  let opens = 0; let closes = 0;
  const mapSource: OfflineMapSource = {
    async open() { opens += 1; throw new Error('No local MBTiles installed'); },
    async close() { closes += 1; },
  };
  const { service, engine } = fixture(t, { mapSource });
  await service.start();
  await until(() => service.getSnapshot().mapStatus === 'unavailable');
  assert.equal(service.getSnapshot().status, 'ready');
  assert.equal(service.getSnapshot().issue, null);
  engine.incoming(fix());
  await until(() => service.getSnapshot().peers.length === 1);
  assert.equal((await service.sendSos()).status, 'queued');
  await service.stop();
  assert.equal(engine.listeners.size, 0);
  assert.equal(opens, 1);
  assert.equal(closes, 1);
});

test('stopping cancels a pending map open and cannot install a late map descriptor in a restarted session', { timeout: 5_000 }, async t => {
  const release = deferred<OfflineMapDescriptor>();
  const signals: AbortSignal[] = [];
  const descriptor: OfflineMapDescriptor = {
    tileUrlTemplate: 'http://127.0.0.1:1234/token/{z}/{x}/{y}.pbf', bounds: [34, 31, 36, 33],
    minZoom: 0, maxZoom: 14, sourceLayers: ['transportation'], attribution: 'Offline map',
  };
  let reads = 0;
  const mapSource: OfflineMapSource = {
    async open(signal) { signals.push(signal); reads += 1; if (reads === 1) return release.promise; throw new Error('Map unavailable after restart'); },
    async close() {},
  };
  t.after(() => release.resolve(descriptor));
  const { service } = fixture(t, { mapSource });
  const starting = service.start();
  await until(() => signals.length === 1);
  await service.stop();
  assert.equal(signals[0]?.aborted, true);
  await service.start();
  release.resolve(descriptor); await starting;
  await until(() => service.getSnapshot().mapStatus === 'unavailable');
  assert.equal(service.getSnapshot().map, null);
});
