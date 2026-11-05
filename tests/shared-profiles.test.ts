import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { SharedProfileService } from '../src/features/contacts/SharedProfileService';
import { parseProfileAnnouncement } from '../src/features/contacts/profilePayload';
import { DtnEngine, type DtnConfig } from '../src/features/dtn/application/DtnEngine';
import type { AcceptResult, DtnEvent, MeshMessage, OutgoingMessage, StoredMessage } from '../src/features/dtn/domain/types';
import { createMessage } from '../src/features/dtn/domain/validation';
import { SecurityService } from '../src/features/security/application/SecurityService';
import type { SecurityVault } from '../src/features/security/domain/types';
import { createTestStore } from './helpers/sqlite';
import { until } from './helpers/chat';

const RECORD = 'profile-sharing-v1';
const NOW = 1_000_000;
type Time = { value: number };

class Vault implements SecurityVault {
  readonly records = new Map<string, string>();
  readonly writes: { key: string; value: string }[] = [];
  failRead = false;
  failWrite = false;
  beforeWrite: ((key: string, value: string) => Promise<void>) | undefined;
  async read(key: string): Promise<string | null> {
    if (key === RECORD && this.failRead) throw new Error('profile vault locked');
    return this.records.get(key) ?? null;
  }
  async write(key: string, value: string): Promise<void> {
    if (key === RECORD && this.failWrite) throw new Error('profile write failed');
    await this.beforeWrite?.(key, value);
    this.writes.push({ key, value });
    this.records.set(key, value);
  }
  async randomBytes(length: number): Promise<Uint8Array> { return randomBytes(length); }
}

function announcement(revision: number, name: string): string {
  return JSON.stringify({ type: 'palmesh-profile', version: 1, revision, name });
}

async function identity(vault = new Vault(), time: Time = { value: NOW }) {
  const security = new SecurityService(vault, { now: () => time.value });
  await security.initialize();
  return { vault, security, time };
}

async function packet(security: SecurityService, revision: number, name: string, createdAt = NOW,
  options: { destination?: string; text?: string; priority?: 'high' } = {}): Promise<MeshMessage> {
  return security.seal(createMessage({ kind: 'chat', destination: options.destination ?? '*',
    payload: { text: options.text ?? announcement(revision, name) },
    ...(options.priority ? { priority: options.priority } : {}),
  }, randomUUID(), security.deviceId, createdAt));
}

function retained(message: MeshMessage, receivedAt = NOW): StoredMessage {
  return { message, receivedAt, expiresAt: receivedAt + 86_400_000,
    dedupExpiresAt: receivedAt + 7 * 86_400_000, forwardable: true };
}

/** Only failure/race cases use this boundary. All packets still use real signing
 * and projection; ordinary integration cases use SQLite and the real engine. */
class EventEngine implements Pick<DtnEngine, 'deviceId' | 'publish' | 'history' | 'subscribe'> {
  readonly deviceId: string;
  readonly listeners = new Set<(event: DtnEvent) => void | Promise<void>>();
  readonly publications: OutgoingMessage[] = [];
  records: StoredMessage[] = [];
  publishNext: ((input: OutgoingMessage) => Promise<Exclude<AcceptResult, { status: 'duplicate' }>>) | undefined;
  historyNext: (() => Promise<readonly StoredMessage[]>) | undefined;
  constructor(readonly security: SecurityService, readonly time: Time) { this.deviceId = security.deviceId; }
  subscribe(listener: (event: DtnEvent) => void | Promise<void>): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  history(): Promise<readonly StoredMessage[]> { return this.historyNext?.() ?? Promise.resolve(this.records); }
  async publish(input: OutgoingMessage): Promise<Exclude<AcceptResult, { status: 'duplicate' }>> {
    this.publications.push(input);
    if (this.publishNext) return this.publishNext(input);
    const message = await this.security.seal(createMessage(input, randomUUID(), this.deviceId, this.time.value));
    const record = retained(message, this.time.value);
    this.records.push(record);
    this.emit({ type: 'accepted', record, local: true });
    return { status: 'accepted', record };
  }
  emit(event: DtnEvent): void {
    for (const listener of this.listeners) void Promise.resolve(listener(event)).catch(() => undefined);
  }
  incoming(message: MeshMessage): void {
    const record = retained(message, this.time.value);
    this.records.push(record);
    this.emit({ type: 'accepted', record, local: false });
  }
}

async function fixture(t: TestContext, options: { vault?: Vault; time?: Time; config?: Partial<DtnConfig> } = {}) {
  const local = await identity(options.vault, options.time);
  const database = createTestStore();
  const engine = new DtnEngine({ deviceId: local.security.deviceId, security: local.security,
    store: database.store, ids: { next: randomUUID }, clock: { now: () => local.time.value },
    transport: { async send() {} }, ...(options.config ? { config: options.config } : {}) });
  const name = { value: 'ليلى 👋' };
  const service = new SharedProfileService({ engine, security: local.security, vault: local.vault,
    getName: () => name.value, clock: { now: () => local.time.value } });
  await engine.start();
  t.after(async () => { await service.stop(); await engine.stop(); database.close(); });
  await service.start();
  return { ...local, engine, service, name };
}

async function eventFixture(t: TestContext, options: { vault?: Vault; time?: Time } = {}) {
  const local = await identity(options.vault, options.time);
  const engine = new EventEngine(local.security, local.time);
  const name = { value: 'ليلى' };
  const service = new SharedProfileService({ engine, security: local.security, vault: local.vault,
    getName: () => name.value, clock: { now: () => local.time.value } });
  t.after(async () => { await service.stop(); });
  await service.start();
  return { ...local, engine, service, name };
}

function profile(service: SharedProfileService, id: string) {
  return service.getSnapshot().peers.find(peer => peer.id === id);
}

test('profile payload accepts only bounded exact flat JSON with canonical names and positive revisions', () => {
  assert.deepEqual(parseProfileAnnouncement(announcement(1, 'ليلى 👋')),
    { type: 'palmesh-profile', version: 1, revision: 1, name: 'ليلى 👋' });
  assert.equal(parseProfileAnnouncement(announcement(2, ''))?.name, '', 'empty name is an explicit withdrawal');
  for (const invalid of [null, {}, 'ordinary nearby chat', '[]', 'null',
    '{"type":"palmesh-profile","version":1,"revision":1,"name":"A","name":"B"}',
    '{"type":"palmesh-profile","version":1,"revision":1,"name":"A","\\u006eame":"B"}',
    JSON.stringify({ type: 'palmesh-profile', version: 1, revision: 1, name: 'A', source: 'other' }),
    JSON.stringify({ type: 'palmesh-profile', version: 2, revision: 1, name: 'A' }),
    JSON.stringify({ type: 'other', version: 1, revision: 1, name: 'A' }),
    ...[0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, '1'].map(revision => JSON.stringify({ type: 'palmesh-profile', version: 1, revision, name: 'A' })),
    ...['e\u0301', ' A', 'A ', 'A\nB', 'A\u202e', 'x'.repeat(81), '\ud800'].map(name => announcement(1, name)),
    ' '.repeat(1024) + announcement(1, 'A'),
  ]) assert.equal(parseProfileAnnouncement(invalid), null, String(invalid));
  assert.equal(parseProfileAnnouncement(announcement(Number.MAX_SAFE_INTEGER, 'é'))?.revision, Number.MAX_SAFE_INTEGER);
});

test('sharing is OFF by default and start/refresh/restart never announce a profile automatically', async t => {
  const local = await fixture(t);
  assert.equal(local.service.getSnapshot().loaded, true);
  assert.equal(local.service.getSnapshot().sharingEnabled, false);
  await local.service.refresh();
  await local.service.shareCurrent().catch(() => undefined);
  assert.deepEqual(await local.engine.history(), []);
  await local.service.stop();
  await local.service.start();
  assert.deepEqual(await local.engine.history(), []);
  assert.equal(local.service.getSnapshot().sharingEnabled, false);
});

test('explicit opt-in queues an existing signed normal public chat after durably reserving consent and revision', async t => {
  const local = await eventFixture(t);
  const original = local.vault.records.get('identity-v1');
  let checked = false;
  const publish = local.engine.publish.bind(local.engine);
  local.engine.publish = async input => {
    const metadata = JSON.parse(local.vault.records.get(RECORD)!);
    assert.equal(metadata.owner, local.security.deviceId);
    assert.equal(metadata.sharingEnabled, true);
    assert.equal(metadata.nextRevision, 2, 'revision is reserved before the queue can fail');
    assert.deepEqual(metadata.publications, [NOW]);
    checked = true;
    return publish(input);
  };
  await local.service.setSharing(true);
  assert.equal(checked, true);
  assert.deepEqual(local.engine.publications, [{ kind: 'chat', destination: '*',
    payload: { text: announcement(1, local.name.value) } }]);
  const wire = local.engine.records[0]!.message;
  assert.ok(wire.security);
  assert.equal(wire.destination, '*');
  assert.equal(wire.ttl, 10);
  assert.equal('priority' in wire, false);
  assert.equal(local.service.getSnapshot().sharingEnabled, true);
  assert.equal(local.service.getSnapshot().error, false);
  assert.deepEqual(local.service.getSnapshot().peers, []);
  assert.equal(local.vault.records.get('identity-v1'), original);
  assert.equal(local.vault.records.has('peer-directory-v1'), false);
});

test('delayed store-and-forward binds a name to the original verified key holder, not its carrier or receipt time', async t => {
  const time = { value: NOW };
  const alice = await fixture(t, { time });
  const relay = await fixture(t, { time });
  const bob = await fixture(t, { time });
  await alice.service.setSharing(true);
  const original = (await alice.engine.history())[0]!.message;
  time.value += 25 * 60_000;
  assert.equal((await relay.engine.receive(alice.security.deviceId, alice.security.forNextHop(original)!)).status, 'accepted');
  const carried = (await relay.engine.history())[0]!.message;
  assert.equal((await bob.engine.receive(relay.security.deviceId, relay.security.forNextHop(carried)!)).status, 'accepted');
  await bob.service.refresh();
  assert.deepEqual(profile(bob.service, alice.security.deviceId), {
    id: alice.security.deviceId, name: alice.name.value, revision: 1,
    messageId: original.id, createdAt: NOW,
  });
  assert.equal(profile(bob.service, relay.security.deviceId), undefined);
  assert.deepEqual(bob.security.savedPeerIds(), [], 'shared names must not pin or trust a contact');
  assert.equal(bob.service.getSnapshot().sharingEnabled, false);
});

test('every history/event profile is reauthenticated and tampered text, source, keys, unsigned and private data cannot set a label', async t => {
  const bob = await eventFixture(t);
  const alice = await identity();
  const mallory = await identity();
  const valid = await packet(alice.security, 1, 'Alice');
  bob.engine.incoming(valid);
  await until(() => profile(bob.service, alice.security.deviceId)?.name === 'Alice');
  assert.equal(valid.kind, 'chat');
  const forged = [
    { ...valid, id: randomUUID(), payload: { text: announcement(999, 'Forged') } },
    { ...valid, source: mallory.security.deviceId },
    { ...valid, security: { ...valid.security!, signingKey: mallory.security.publicIdentity.signingKey } },
    createMessage({ kind: 'chat', destination: '*', payload: { text: announcement(999, 'Unsigned') } }, randomUUID(), alice.security.deviceId, NOW),
  ] as MeshMessage[];
  await alice.security.importPeer(bob.security.publicIdentity);
  forged.push(await packet(alice.security, 999, 'Private', NOW, { destination: bob.security.deviceId }));
  forged.push(await packet(alice.security, 999, 'Elevated profile', NOW, { priority: 'high' }));
  forged.push(await packet(bob.security, 999, 'Own'));
  forged.push(await packet(mallory.security, 1, 'Payload source', NOW, {
    text: JSON.stringify({ type: 'palmesh-profile', version: 1, revision: 1, name: 'Alice', source: alice.security.deviceId }),
  }));
  for (const message of forged) bob.engine.incoming(message);
  await bob.service.refresh();
  assert.equal(profile(bob.service, alice.security.deviceId)?.name, 'Alice');
  assert.equal(profile(bob.service, alice.security.deviceId)?.revision, 1);
  assert.equal(profile(bob.service, mallory.security.deviceId), undefined);
  assert.equal(profile(bob.service, bob.security.deviceId), undefined);
  assert.deepEqual(bob.security.savedPeerIds(), []);
});

test('a different real signing identity can share the same text but never replace the first identity binding', async t => {
  const bob = await eventFixture(t);
  const alice = await identity();
  const changedKeys = await identity();
  bob.engine.incoming(await packet(alice.security, 4, 'Shared name'));
  bob.engine.incoming(await packet(changedKeys.security, 99, 'Shared name'));
  await bob.service.refresh();
  assert.equal(profile(bob.service, alice.security.deviceId)?.revision, 4);
  assert.equal(profile(bob.service, changedKeys.security.deviceId)?.revision, 99);
  assert.equal(bob.service.getSnapshot().peers.length, 2);
});

test('newer revisions win independent of arrival order and equal-revision conflicts do not rename a holder', async t => {
  const bob = await eventFixture(t);
  const alice = await identity();
  const newest = await packet(alice.security, 3, 'Newest');
  bob.engine.incoming(newest);
  await bob.service.refresh();
  const first = profile(bob.service, alice.security.deviceId)!;
  bob.engine.incoming(await packet(alice.security, 1, 'Old'));
  bob.engine.incoming(await packet(alice.security, 2, 'Delayed'));
  bob.engine.incoming(await packet(alice.security, 3, 'Conflicting equal revision'));
  bob.engine.incoming(newest);
  await bob.service.refresh();
  assert.deepEqual(profile(bob.service, alice.security.deviceId), first);
});

test('withdrawal clears the shared label and its revision floor survives a fresh security/service session without routing history', async t => {
  const alice = await fixture(t);
  const bob = await fixture(t);
  await alice.service.setSharing(true);
  const first = (await alice.engine.history())[0]!.message;
  assert.equal((await bob.engine.receive(alice.security.deviceId, alice.security.forNextHop(first)!)).status, 'accepted');
  await bob.service.refresh();
  alice.name.value = 'Updated Arabic ليلى';
  await alice.service.shareCurrent();
  const update = (await alice.engine.history()).find(record => record.message.kind === 'chat'
    && parseProfileAnnouncement(record.message.payload.text)?.revision === 2)!.message;
  assert.equal((await bob.engine.receive(alice.security.deviceId, alice.security.forNextHop(update)!)).status, 'accepted');
  await bob.service.refresh();
  assert.equal(profile(bob.service, alice.security.deviceId)?.name, alice.name.value);
  await alice.service.setSharing(false);
  const withdrawal = (await alice.engine.history()).find(record => record.message.kind === 'chat'
    && parseProfileAnnouncement(record.message.payload.text)?.revision === 3)!.message;
  assert.equal(withdrawal.kind, 'chat');
  assert.equal(parseProfileAnnouncement(withdrawal.payload.text)?.name, '');
  assert.equal((await bob.engine.receive(alice.security.deviceId, alice.security.forNextHop(withdrawal)!)).status, 'accepted');
  await bob.service.refresh();
  assert.equal(profile(bob.service, alice.security.deviceId)?.name, '');
  assert.equal(profile(bob.service, alice.security.deviceId)?.revision, 3);
  await bob.service.stop();
  const restarted = await eventFixture(t, { vault: bob.vault });
  assert.equal(restarted.security.deviceId, bob.security.deviceId);
  assert.equal(profile(restarted.service, alice.security.deviceId)?.name, '');
  assert.equal(profile(restarted.service, alice.security.deviceId)?.revision, 3);
  restarted.engine.incoming(first);
  restarted.engine.incoming(update);
  await restarted.service.refresh();
  assert.equal(profile(restarted.service, alice.security.deviceId)?.name, '');
  assert.equal(profile(restarted.service, alice.security.deviceId)?.revision, 3);
  await alice.service.stop();
  const aliceRestarted = await fixture(t, { vault: alice.vault });
  assert.equal(aliceRestarted.service.getSnapshot().sharingEnabled, false);
  assert.deepEqual(await aliceRestarted.engine.history(), []);
  await aliceRestarted.service.setSharing(true);
  const newWire = (await aliceRestarted.engine.history())[0]!.message;
  assert.equal(newWire.kind, 'chat');
  assert.equal(parseProfileAnnouncement(newWire.payload.text)?.revision, 4);
});

test('failed consent/metadata writes preserve keys, existing contact metadata and previously committed labels', async t => {
  const bob = await eventFixture(t);
  const alice = await identity();
  bob.vault.records.set('contact-profile-v1', 'existing contact metadata owned by ContactDirectory');
  const originalIdentity = bob.vault.records.get('identity-v1');
  bob.engine.incoming(await packet(alice.security, 1, 'Committed'));
  await bob.service.refresh();
  const before = profile(bob.service, alice.security.deviceId);
  bob.vault.failWrite = true;
  await assert.rejects(bob.service.setSharing(true));
  assert.equal(bob.service.getSnapshot().sharingEnabled, false);
  assert.equal(bob.engine.publications.length, 0);
  bob.engine.incoming(await packet(alice.security, 2, 'Uncommitted'));
  await bob.service.refresh().catch(() => undefined);
  assert.deepEqual(profile(bob.service, alice.security.deviceId), before);
  assert.equal(bob.service.getSnapshot().error, true);
  assert.equal(bob.vault.records.get('identity-v1'), originalIdentity);
  assert.equal(bob.vault.records.get('contact-profile-v1'), 'existing contact metadata owned by ContactDirectory');
  bob.vault.failWrite = false;
  await bob.service.refresh();
  assert.equal(profile(bob.service, alice.security.deviceId)?.name, 'Uncommitted');
});

test('normal routing capacity rejects the profile while durable consent remains explicit and no false queued result is reported', async t => {
  const local = await fixture(t, { config: { maxMessages: 2, reservedEmergencyMessages: 1,
    maxSeenIds: 10, reservedEmergencySeenIds: 1 } });
  await local.engine.publish({ kind: 'chat', destination: '*', payload: { text: 'ordinary queued message' } });
  const identityBefore = local.vault.records.get('identity-v1');
  await assert.rejects(local.service.setSharing(true));
  assert.equal(local.service.getSnapshot().sharingEnabled, true, 'consent was stored before publication failed');
  assert.equal(local.service.getSnapshot().error, true);
  assert.equal((await local.engine.history()).length, 1, 'profile cannot consume reserved emergency capacity');
  assert.equal(local.vault.records.get('identity-v1'), identityBefore);
  assert.equal(JSON.parse(local.vault.records.get(RECORD)!).nextRevision, 2);
});

test('a failed queue attempt never reuses its reserved local revision, including after restart', async t => {
  const local = await eventFixture(t);
  local.engine.publishNext = async () => { throw new Error('routing store failed'); };
  await assert.rejects(local.service.setSharing(true));
  assert.equal(local.service.getSnapshot().error, true);
  assert.equal(JSON.parse(local.vault.records.get(RECORD)!).nextRevision, 2);
  await local.service.stop();
  const restarted = await eventFixture(t, { vault: local.vault });
  assert.equal(restarted.engine.publications.length, 0, 'restart cannot retry publicly without a user action');
  await restarted.service.shareCurrent();
  const last = restarted.engine.publications.at(-1)!;
  assert.equal(last.kind, 'chat');
  assert.equal(parseProfileAnnouncement(last.payload.text)?.revision, 2);
  assert.equal(restarted.service.getSnapshot().error, false);
});

test('turning sharing OFF is durable even when its normal withdrawal packet cannot queue', async t => {
  const local = await eventFixture(t);
  await local.service.setSharing(true);
  local.engine.publishNext = async () => ({ status: 'full', resource: 'messages' });
  await assert.rejects(local.service.setSharing(false));
  assert.equal(local.service.getSnapshot().sharingEnabled, false);
  assert.equal(local.service.getSnapshot().error, true);
  assert.equal(JSON.parse(local.vault.records.get(RECORD)!).sharingEnabled, false);
  const withdrawal = local.engine.publications.at(-1)!;
  assert.equal(withdrawal.kind, 'chat');
  assert.equal(parseProfileAnnouncement(withdrawal.payload.text)?.name, '');
  await local.service.stop();
  const restarted = await eventFixture(t, { vault: local.vault });
  assert.equal(restarted.service.getSnapshot().sharingEnabled, false);
  assert.equal(restarted.engine.publications.length, 0);
});

test('the twelve-per-hour ordinary publication bound survives restart and backwards wallclock movement', async t => {
  const time = { value: NOW };
  const local = await fixture(t, { time });
  await local.service.setSharing(true);
  for (let index = 1; index < 12; index += 1) {
    local.name.value = 'Name ' + index;
    await local.service.shareCurrent();
  }
  await assert.rejects(local.service.shareCurrent());
  assert.equal((await local.engine.history()).length, 12);
  assert.equal(local.service.getSnapshot().error, true);
  await local.service.stop();
  const restarted = await fixture(t, { vault: local.vault, time });
  await assert.rejects(restarted.service.shareCurrent());
  time.value -= 100;
  await assert.rejects(restarted.service.shareCurrent());
  assert.equal((await restarted.engine.history()).length, 0);
  time.value = NOW + 3_600_001;
  await restarted.service.shareCurrent();
  assert.equal((await restarted.engine.history()).length, 1);
});

test('corrupt and foreign-owner profile records fail closed without changing identity or overwriting the record', async t => {
  const local = await identity();
  const identityBefore = local.vault.records.get('identity-v1');
  for (const invalid of ['broken', JSON.stringify({ version: 1, owner: 'pm1:' + '0'.repeat(64),
    sharingEnabled: true, nextRevision: 1, publications: [], peers: [] })]) {
    local.vault.records.set(RECORD, invalid);
    const node = await eventFixture(t, { vault: local.vault });
    assert.equal(node.service.getSnapshot().loaded, false);
    assert.equal(node.service.getSnapshot().sharingEnabled, false);
    assert.equal(node.service.getSnapshot().error, true);
    await assert.rejects(node.service.setSharing(true));
    assert.equal(local.vault.records.get(RECORD), invalid);
    assert.equal(local.vault.records.get('identity-v1'), identityBefore);
    await node.service.stop();
  }
});

test('a full 256-identity floor table never evicts tombstones and still permits a newer revision for an existing holder', async t => {
  const local = await identity();
  const alice = await identity();
  const extra = await identity();
  // These owner-bound storage fixtures test capacity only; incoming updates
  // below still need Alice's actual signature; these rows never enter routing.
  const peers = Array.from({ length: 255 }, (_, index) => ({ id: 'pm1:' + index.toString(16).padStart(64, '0'),
    name: '', revision: 5, messageId: randomUUID(), createdAt: NOW }));
  peers.push({ id: alice.security.deviceId, name: '', revision: 5, messageId: randomUUID(), createdAt: NOW });
  local.vault.records.set(RECORD, JSON.stringify({ version: 1, owner: local.security.deviceId,
    sharingEnabled: false, nextRevision: 1, publications: [], peers }));
  const node = await eventFixture(t, { vault: local.vault });
  assert.equal(node.service.getSnapshot().peers.length, 256);
  node.engine.incoming(await packet(extra.security, 1, 'Must not evict a floor'));
  node.engine.incoming(await packet(alice.security, 6, 'New name after withdrawal'));
  await node.service.refresh();
  assert.equal(node.service.getSnapshot().peers.length, 256);
  assert.equal(profile(node.service, extra.security.deviceId), undefined);
  assert.equal(profile(node.service, alice.security.deviceId)?.name, 'New name after withdrawal');
  node.engine.incoming(await packet(alice.security, 4, 'Old replay'));
  await node.service.refresh();
  assert.equal(profile(node.service, alice.security.deviceId)?.revision, 6);
  assert.ok(node.service.getSnapshot().peers.some(peer => peer.id === peers[0]!.id && peer.revision === 5));
});
