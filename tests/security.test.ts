import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { SecurityService, SecurityError, identityFingerprint } from '../src/features/security/application/SecurityService';
import { NativeSecurityVault } from '../src/features/security/infrastructure/NativeSecurityVault';
import type { SecurityVault } from '../src/features/security/domain/types';
import { createMessage, parseMessage } from '../src/features/dtn/domain/validation';
import { DtnEngine } from '../src/features/dtn/application/DtnEngine';
import type { MeshMessage, DtnEvent } from '../src/features/dtn/domain/types';
import { encodeFrame, FrameDecoder, sessionFrameContent } from '../src/features/mesh/domain/wire';
import { createMeshNode } from '../src/features/mesh/application/createMeshNode';
import { SqlitePeerRegistry } from '../src/features/mesh/infrastructure/SqlitePeerRegistry';
import { createTestStore, TestSqliteDatabase } from './helpers/sqlite';
import { TestRadio } from './helpers/radio';

const now = 1_000_000;
class Vault implements SecurityVault {
  readonly records = new Map<string, string>();
  failure = false;
  async read(key: string): Promise<string | null> { if (this.failure) throw new Error('vault locked'); return this.records.get(key) ?? null; }
  async write(key: string, value: string): Promise<void> { if (this.failure) throw new Error('vault locked'); this.records.set(key, value); }
  async randomBytes(length: number): Promise<Uint8Array> { return randomBytes(length); }
}
async function identity(vault = new Vault()) {
  const security = new SecurityService(vault, { now: () => now });
  await security.initialize();
  return { security, vault };
}
function chat(source: string, destination: string, text = 'رسالة آمنة 👋') {
  return createMessage({ kind: 'chat', destination, payload: { text } }, randomUUID(), source, now);
}
function mutate(message: MeshMessage, values: Record<string, unknown>): MeshMessage {
  const parsed = parseMessage({ ...message, ...values });
  assert.ok(parsed.ok);
  return parsed.message;
}
async function engine(t: TestContext, security: SecurityService) {
  const db = createTestStore();
  const events: DtnEvent[] = [];
  const sent: MeshMessage[] = [];
  const instance = new DtnEngine({ deviceId: security.deviceId, security, store: db.store,
    ids: { next: randomUUID }, clock: { now: () => now }, transport: { async send(_peer, packet) { sent.push(packet); } } });
  instance.subscribe(event => { events.push(event); });
  await instance.start();
  t.after(async () => { await instance.stop(); db.close(); });
  return { engine: instance, store: db.store, events, sent };
}

test('self-certifying identity survives restart and rejects corrupt, locked or unsupported vault records', async () => {
  const { security, vault } = await identity();
  assert.match(security.deviceId, /^pm1:[0-9a-f]{64}$/);
  assert.equal(identityFingerprint(security.publicIdentity), security.deviceId);
  const restarted = await identity(vault);
  assert.equal(restarted.security.deviceId, security.deviceId);
  vault.records.set('identity-v1', '{"version":7}');
  await assert.rejects(identity(vault));
  assert.equal(vault.records.get('identity-v1'), '{"version":7}');
  const locked = new Vault(); locked.failure = true;
  await assert.rejects(identity(locked), /vault locked/);
  assert.throws(() => new NativeSecurityVault(undefined), /unavailable/);
});

test('missing or malformed OS randomness fails without storing a replacement identity', async () => {
  const vault = new Vault();
  vault.randomBytes = async length => new Uint8Array(length - 1);
  await assert.rejects(identity(vault), /entropy/);
  assert.equal(vault.records.size, 0);
  const native = new NativeSecurityVault({ read: async () => null, write: async () => {}, randomBytes: async () => 'AA==' });
  await assert.rejects(native.randomBytes(32), /byte count/);
});

test('direct chats encrypt for their endpoint, remain opaque at a relay, and decrypt at sender after key restart', async () => {
  const alice = await identity(); const bob = await identity(); const relay = await identity();
  await alice.security.importPeer(bob.security.publicIdentity);
  const wire = await alice.security.seal(chat(alice.security.deviceId, bob.security.deviceId));
  assert.equal(wire.kind, 'chat');
  assert.ok(!JSON.stringify(wire).includes('رسالة'));
  assert.ok(wire.security?.encryption);
  await relay.security.verify(wire);
  assert.equal(await relay.security.project(wire), null);
  await bob.security.verify(wire);
  assert.deepEqual((await bob.security.project(wire))?.payload, { text: 'رسالة آمنة 👋' });
  const restarted = await identity(alice.vault);
  assert.deepEqual((await restarted.security.project(wire))?.payload, { text: 'رسالة آمنة 👋' });
});

test('tampering with ciphertext, source, destination, kind, location or immutable timestamps fails authentication', async () => {
  const alice = await identity(); const bob = await identity(); const other = await identity();
  await alice.security.importPeer(bob.security.publicIdentity);
  const wire = await alice.security.seal(chat(alice.security.deviceId, bob.security.deviceId));
  assert.equal(wire.kind, 'chat'); if (wire.kind !== 'chat') return;
  const text = wire.payload.text;
  for (const changed of [
    mutate(wire, { payload: { text: `${text[0] === 'A' ? 'B' : 'A'}${text.slice(1)}` } }),
    mutate(wire, { source: other.security.deviceId }),
    mutate(wire, { destination: other.security.deviceId }),
    mutate(wire, { createdAt: now - 1 }),
  ]) await assert.rejects(bob.security.verify(changed), SecurityError);
  const sos = await alice.security.seal(createMessage({ kind: 'sos', payload: { text: 'Help', location: { latitude: 31.5, longitude: 34.4, timestamp: now } } }, randomUUID(), alice.security.deviceId, now));
  await assert.rejects(bob.security.verify(mutate(sos, { payload: { text: 'Help', location: { latitude: 30, longitude: 34.4, timestamp: now } } })), /signature/);
  const changedKind = mutate(sos, { kind: 'chat', ttl: 10, destination: bob.security.deviceId, payload: { text: 'forged' } });
  await assert.rejects(bob.security.verify(changedKind), /hop budget|encryption/);
});

test('a wrong recipient cannot decrypt a valid packet or substitute its own public key', async () => {
  const alice = await identity(); const bob = await identity(); const mallory = await identity();
  await alice.security.importPeer(bob.security.publicIdentity);
  const wire = await alice.security.seal(chat(alice.security.deviceId, bob.security.deviceId));
  assert.equal(await mallory.security.project(wire), null);
  const changed = mutate(wire, { destination: mallory.security.deviceId });
  await assert.rejects(mallory.security.verify(changed), /signature/);
  const keySwap = mutate(wire, { security: { ...wire.security!, encryption: {
    ...wire.security!.encryption!, recipientKey: mallory.security.publicIdentity.encryptionKey } } });
  await assert.rejects(bob.security.verify(keySwap), /signature/);
});

test('signed one-way hop proofs allow decrementing while preventing downstream TTL inflation', async () => {
  const alice = await identity(); const relay = await identity();
  const source = await alice.security.seal(createMessage({ kind: 'sos', payload: { text: 'Help' } }, randomUUID(), alice.security.deviceId, now));
  assert.equal(source.ttl, 15);
  let wire = alice.security.forNextHop(source)!;
  await relay.security.verify(wire);
  assert.equal(wire.ttl, 14);
  await assert.rejects(relay.security.verify(mutate(wire, { ttl: 15 })), /Hop proof/);
  await assert.rejects(relay.security.verify(mutate(wire, { ttl: 13 })), /Hop proof/);
  while (wire.ttl > 0) { wire = relay.security.forNextHop(wire)!; await relay.security.verify(wire); }
  assert.equal(wire.ttl, 0);
  assert.equal(relay.security.forNextHop(wire), null);
});

test('unsigned plaintext, broadcast chat, expired and future-dated packets fail closed', async () => {
  const alice = await identity(); const bob = await identity();
  await assert.rejects(bob.security.verify(chat(alice.security.deviceId, bob.security.deviceId)), /Unsigned/);
  await assert.rejects(alice.security.seal(chat(alice.security.deviceId, '*')), /another device/);
  await assert.rejects(alice.security.seal(chat(alice.security.deviceId, bob.security.deviceId)), /unknown/);
  const expired = await alice.security.seal(createMessage({ kind: 'sos', payload: { text: 'Help' } }, randomUUID(), alice.security.deviceId, 0));
  const future = await alice.security.seal(createMessage({ kind: 'sos', payload: { text: 'Help' } }, randomUUID(), alice.security.deviceId, now + 300_001));
  const later = new SecurityService(bob.vault, { now: () => 86_400_001 }); await later.initialize();
  await assert.rejects(later.verify(expired), /expired/);
  await assert.rejects(bob.security.verify(future), /clock/);
});

test('nonce-bound handshake signatures reject spoofing and replayed acknowledgments', async () => {
  const alice = await identity(); const bob = await identity();
  const nonce = randomUUID(); const echo = randomUUID();
  const proof = alice.security.authenticate(nonce, echo);
  bob.security.verifyHandshake(alice.security.deviceId, nonce, echo, proof);
  assert.throws(() => bob.security.verifyHandshake(alice.security.deviceId, nonce, randomUUID(), proof), /signature/);
  assert.throws(() => bob.security.verifyHandshake(bob.security.deviceId, nonce, echo, proof), /identity/);
  assert.throws(() => bob.security.verifyHandshake(alice.security.deviceId, nonce, echo, undefined), /Unauthenticated/);
  const frame = { v: 1 as const, type: 'hello-ack' as const, peerId: alice.security.deviceId, nonce, echo, authentication: proof };
  const decoder = new FrameDecoder();
  assert.deepEqual(decoder.push(encodeFrame(frame)), [frame]);
});

test('session MACs bind hop ACKs to authenticated peers, both nonce challenges, and message IDs', async () => {
  const alice = await identity(); const bob = await identity(); const mallory = await identity();
  await alice.security.importPeer(bob.security.publicIdentity); await bob.security.importPeer(alice.security.publicIdentity);
  await mallory.security.importPeer(alice.security.publicIdentity);
  const aNonce = randomUUID(); const bNonce = randomUUID();
  const frame = { v: 1 as const, type: 'ack' as const, session: bNonce, transferId: randomUUID(), messageId: randomUUID() };
  const content = sessionFrameContent(frame);
  const tag = alice.security.sessionTag(bob.security.deviceId, aNonce, bNonce, content);
  bob.security.verifySessionTag(alice.security.deviceId, bNonce, aNonce, content, tag);
  assert.throws(() => bob.security.verifySessionTag(alice.security.deviceId, bNonce, randomUUID(), content, tag), /authentication/);
  assert.throws(() => bob.security.verifySessionTag(alice.security.deviceId, bNonce, aNonce, sessionFrameContent({ ...frame, messageId: randomUUID() }), tag), /authentication/);
  assert.throws(() => mallory.security.verifySessionTag(alice.security.deviceId, bNonce, aNonce, content, tag), /authentication/);
  assert.throws(() => bob.security.verifySessionTag(alice.security.deviceId, bNonce, aNonce, content, undefined), /authentication/);
  const encoded = encodeFrame({ ...frame, authenticationTag: tag });
  assert.deepEqual(new FrameDecoder().push(encoded), [{ ...frame, authenticationTag: tag }]);
});

test('cross-node DTN stores only ciphertext and keeps transit chat out of relay history/events', async t => {
  const alice = await identity(); const relay = await identity(); const bob = await identity();
  await alice.security.importPeer(bob.security.publicIdentity);
  const a = await engine(t, alice.security); const r = await engine(t, relay.security); const b = await engine(t, bob.security);
  const outgoing = await a.engine.publish({ kind: 'chat', destination: bob.security.deviceId, payload: { text: 'private payload' } });
  assert.equal(outgoing.status, 'accepted'); if (outgoing.status !== 'accepted') return;
  assert.deepEqual(outgoing.record.message.payload, { text: 'private payload' });
  const retained = (await a.store.getMessage(outgoing.record.message.id))!.message;
  assert.notDeepEqual(retained.payload, outgoing.record.message.payload);
  const firstHop = alice.security.forNextHop(retained)!;
  assert.equal((await r.engine.receive(alice.security.deviceId, firstHop)).status, 'accepted');
  assert.deepEqual(await r.engine.history(), []);
  assert.equal(r.events.some(event => event.type === 'accepted'), false);
  const secondHop = relay.security.forNextHop((await r.store.getMessage(retained.id))!.message)!;
  assert.equal((await b.engine.receive(relay.security.deviceId, secondHop)).status, 'accepted');
  assert.deepEqual((await b.engine.history())[0]!.message.payload, { text: 'private payload' });
  assert.equal((await b.engine.receive(relay.security.deviceId, secondHop)).status, 'duplicate');
  assert.equal(b.events.filter(event => event.type === 'accepted').length, 1);
  assert.notDeepEqual((await b.store.getMessage(retained.id))!.message.payload, { text: 'private payload' });
  const unsigned = chat(alice.security.deviceId, bob.security.deviceId, 'plaintext leak');
  assert.equal((await b.engine.receive(relay.security.deviceId, unsigned)).status, 'invalid');
  assert.equal(await b.store.getMessage(unsigned.id), null);
});

test('native secure node authenticates real fragmented radio handshakes and delivers encrypted chat', async t => {
  const alice = await identity(); const bob = await identity();
  const network = new Map<string, TestRadio>();
  const nodes = [alice, bob].map(({ security }, index) => {
    const db = createTestStore();
    const radio = new TestRadio('wifi-direct', `secure-${index}`, network);
    const peersDb = new TestSqliteDatabase();
    const node = createMeshNode({ deviceId: security.deviceId, security, store: db.store,
      registry: new SqlitePeerRegistry(peersDb), radios: [radio], ids: { next: randomUUID }, clock: { now: () => now },
      meshConfig: { handshakeTimeoutMs: 1000, maintenanceIntervalMs: 100 } });
    t.after(async () => { await node.stop(); db.close(); peersDb.close(); });
    return { node, radio };
  });
  await Promise.all(nodes.map(({ node }) => node.start()));
  nodes[0]!.radio.discover(nodes[1]!.radio.address);
  const deadline = Date.now() + 2000;
  while (nodes.some(({ node }) => node.mesh.connectedPeers().length === 0)) {
    if (Date.now() > deadline) assert.fail('Secure radio handshake did not finish');
    await new Promise<void>(resolve => { setTimeout(resolve, 5); });
  }
  const result = await nodes[0]!.node.engine.publish({ kind: 'chat', destination: bob.security.deviceId, payload: { text: 'radio secret' } });
  assert.equal(result.status, 'accepted');
  await nodes[0]!.node.engine.flush();
  assert.deepEqual((await nodes[1]!.node.engine.history())[0]!.message.payload, { text: 'radio secret' });
});
