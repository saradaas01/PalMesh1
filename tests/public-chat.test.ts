import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SecurityService } from '../src/features/security/application/SecurityService';
import type { SecurityVault } from '../src/features/security/domain/types';
import { DtnEngine } from '../src/features/dtn/application/DtnEngine';
import { createMessage, parseMessage } from '../src/features/dtn/domain/validation';
import { ChatService } from '../src/features/chat/application/ChatService';
import { SqliteChatRepository } from '../src/features/chat/infrastructure/SqliteChatRepository';
import { createTestStore, TestSqliteDatabase } from './helpers/sqlite';
import { until } from './helpers/chat';

const now = 1_000_000;
class Vault implements SecurityVault {
  readonly records = new Map<string, string>();
  async read(key: string) { return this.records.get(key) ?? null; }
  async write(key: string, value: string) { this.records.set(key, value); }
  async randomBytes(length: number) { return randomBytes(length); }
}
async function identity(vault = new Vault()) {
  const security = new SecurityService(vault, { now: () => now });
  await security.initialize();
  return { security, vault };
}
function engine(security: SecurityService, store: ReturnType<typeof createTestStore>['store']) {
  return new DtnEngine({ deviceId: security.deviceId, security, store, clock: { now: () => now },
    ids: { next: randomUUID }, transport: { async send() { throw new Error('No connected peers expected'); } } });
}

test('signed public chat verifies at strangers and after forwarding; tampering and unsigned admission fail closed', async () => {
  const alice = await identity(); const bob = await identity(); const relay = await identity();
  const packet = await alice.security.seal(createMessage({ kind: 'chat', destination: '*', payload: { text: 'Hello مرحباً 👋' } }, randomUUID(), alice.security.deviceId, now));
  assert.equal(packet.kind, 'chat');
  if (packet.kind !== 'chat') throw new Error('Expected chat');
  assert.equal(packet.destination, '*');
  assert.equal(packet.ttl, 10);
  assert.equal(packet.security?.encryption, undefined);
  assert.ok(packet.security?.signature);
  await bob.security.verify(packet);
  assert.deepEqual((await bob.security.project(packet))?.payload, { text: 'Hello مرحباً 👋' });
  const hop = relay.security.forNextHop(packet)!;
  await bob.security.verify(hop);
  assert.equal(hop.ttl, 9);
  for (const changed of [
    { ...packet, payload: { text: 'forged' } },
    { ...packet, destination: bob.security.deviceId },
    { ...packet, kind: 'location', payload: { location: { latitude: 31, longitude: 34, timestamp: now } } },
    { ...hop, ttl: 10 },
  ]) {
    const parsed = parseMessage(changed); assert.ok(parsed.ok);
    await assert.rejects(bob.security.verify(parsed.message));
  }
  const { security: _security, ...unsigned } = packet;
  await assert.rejects(bob.security.verify(unsigned), /Unsigned/);
  await assert.rejects(bob.security.project({ ...packet, payload: { text: 'forged retained history' } }), /signature/);
  await alice.security.importPeer(bob.security.publicIdentity);
  const direct = await alice.security.seal(createMessage({ kind: 'chat', destination: bob.security.deviceId, payload: { text: 'private' } }, randomUUID(), alice.security.deviceId, now));
  assert.ok(direct.security?.encryption);
  assert.equal(parseMessage({ ...direct, destination: '*' }).ok, false);
  const { encryption: _encryption, ...metadata } = direct.security!;
  await assert.rejects(bob.security.verify({ ...direct, security: metadata }), /encryption/);
  await assert.rejects(bob.security.verify({ ...direct, destination: '*', security: metadata }), /signature/);
});

test('Nearby Hello queues with real security and no peers, survives database/key reopen, and reaches another node', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'palmesh-public-chat-'));
  const alice = await identity();
  let routing = createTestStore(join(directory, 'dtn.sqlite'));
  let archiveDb = new TestSqliteDatabase(join(directory, 'chat.sqlite'));
  let node = engine(alice.security, routing.store);
  let repository = new SqliteChatRepository(archiveDb);
  let chat = new ChatService({ engine: node, repository, clock: { now: () => now } });
  try {
    await node.start(); await chat.start(); await chat.openConversation('*');
    chat.setDraft('Hello');
    const queued = await chat.send();
    assert.equal(queued.status, 'queued'); if (queued.status !== 'queued') return;
    assert.equal(chat.getSnapshot().draft, '');
    await until(() => chat.getSnapshot().messages.some(message => message.text === 'Hello'));
    assert.equal(chat.getSnapshot().issue, null);
    const retained = (await routing.store.getMessage(queued.messageId))!;
    assert.equal(retained.message.security?.encryption, undefined);
    assert.ok(retained.message.security?.signature);
    assert.equal(retained.forwardable, true);
    await chat.stop(); await node.stop(); routing.close(); archiveDb.close();
    const restarted = await identity(alice.vault);
    routing = createTestStore(join(directory, 'dtn.sqlite'));
    archiveDb = new TestSqliteDatabase(join(directory, 'chat.sqlite'));
    node = engine(restarted.security, routing.store);
    repository = new SqliteChatRepository(archiveDb);
    chat = new ChatService({ engine: node, repository, clock: { now: () => now } });
    await node.start(); await chat.start(); await chat.openConversation('*');
    assert.equal(chat.getSnapshot().messages[0]?.text, 'Hello');
    assert.equal((await node.history())[0]?.message.id, queued.messageId);
    const bob = await identity(); const remoteDb = createTestStore(); const remote = engine(bob.security, remoteDb.store);
    try {
      await remote.start();
      const hop = restarted.security.forNextHop(retained.message)!;
      assert.equal((await remote.receive(restarted.security.deviceId, hop)).status, 'accepted');
      assert.equal((await remote.receive(restarted.security.deviceId, hop)).status, 'duplicate');
      assert.deepEqual((await remote.history())[0]?.message.payload, { text: 'Hello' });
      const remoteArchive = new TestSqliteDatabase();
      try {
        const repo = new SqliteChatRepository(remoteArchive); await repo.initialize();
        await repo.upsert(await remote.historyWithCustody(), bob.security.deviceId);
        assert.equal((await repo.listMessages('*', 10))[0]?.text, 'Hello');
      } finally { remoteArchive.close(); }
    } finally { await remote.stop(); remoteDb.close(); }
  } finally {
    await chat.stop(); await node.stop(); routing.close(); archiveDb.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('real routing storage failure retains public draft, retry queues once, and SOS keeps its emergency budget', async () => {
  const alice = await identity(); const routing = createTestStore(); const archiveDb = new TestSqliteDatabase();
  const node = engine(alice.security, routing.store);
  const chat = new ChatService({ engine: node, repository: new SqliteChatRepository(archiveDb), clock: { now: () => now } });
  try {
    await node.start(); await chat.start(); await chat.openConversation('*');
    routing.db.exec(`CREATE TRIGGER reject_public BEFORE INSERT ON palmesh_dtn_messages WHEN NEW.kind = 'chat' BEGIN SELECT RAISE(ABORT, 'storage failure'); END`);
    chat.setDraft('Hello');
    assert.equal((await chat.send()).status, 'rejected');
    assert.equal(chat.getSnapshot().draft, 'Hello');
    assert.equal(chat.getSnapshot().issue, 'send-unavailable');
    assert.equal((await node.history()).length, 0);
    assert.equal((await chat.sendSos()).status, 'queued');
    const sos = (await node.history())[0]!.message;
    assert.equal(sos.kind, 'sos'); assert.equal(sos.ttl, 15); assert.ok(sos.security?.signature);
    routing.db.exec('DROP TRIGGER reject_public');
    assert.equal((await chat.send()).status, 'queued');
    assert.equal(chat.getSnapshot().draft, '');
    assert.equal((await node.history()).filter(record => record.message.kind === 'chat').length, 1);
  } finally { await chat.stop(); await node.stop(); routing.close(); archiveDb.close(); }
});


test('private unknown-key recovery keeps draft, imports a contact, and queues encrypted while offline', async () => {
  const alice = await identity(); const bob = await identity();
  const routing = createTestStore(); const archiveDb = new TestSqliteDatabase();
  const node = engine(alice.security, routing.store);
  const chat = new ChatService({ engine: node, repository: new SqliteChatRepository(archiveDb), clock: { now: () => now } });
  try {
    await node.start(); await chat.start(); await chat.openConversation(bob.security.deviceId);
    chat.setDraft('Private offline Hello');
    assert.equal((await chat.send()).status, 'rejected');
    assert.equal(chat.getSnapshot().issue, 'recipient-unknown');
    assert.equal(chat.getSnapshot().draft, 'Private offline Hello');
    assert.equal((await node.history()).length, 0);
    await alice.security.importPeer(bob.security.publicIdentity);
    const result = await chat.send();
    assert.equal(result.status, 'queued'); if (result.status !== 'queued') return;
    const packet = (await routing.store.getMessage(result.messageId))!.message;
    assert.ok(packet.security?.encryption);
    assert.ok(!JSON.stringify(packet).includes('Private offline Hello'));
    await bob.security.verify(packet);
    assert.deepEqual((await bob.security.project(packet))?.payload, { text: 'Private offline Hello' });
    assert.equal(chat.getSnapshot().draft, '');
    assert.equal(chat.getSnapshot().issue, null);
  } finally { await chat.stop(); await node.stop(); routing.close(); archiveDb.close(); }
});

test('private key persistence failure is actionable without blocking public chat or SOS', async () => {
  const alice = await identity(); const bob = await identity();
  const write = alice.vault.write.bind(alice.vault);
  alice.vault.write = async (key, value) => { if (key === 'peer-directory-v1') throw new Error('native private details'); await write(key, value); };
  await assert.rejects(alice.security.importPeer(bob.security.publicIdentity));
  const routing = createTestStore(); const archiveDb = new TestSqliteDatabase(); const node = engine(alice.security, routing.store);
  const chat = new ChatService({ engine: node, repository: new SqliteChatRepository(archiveDb), clock: { now: () => now } });
  try {
    await node.start(); await chat.start(); await chat.openConversation(bob.security.deviceId); chat.setDraft('Keep private');
    assert.equal((await chat.send()).status, 'rejected');
    assert.equal(chat.getSnapshot().issue, 'recipient-keys-unavailable');
    assert.equal(chat.getSnapshot().draft, 'Keep private');
    assert.equal((await node.history()).length, 0);
    await chat.openConversation('*'); chat.setDraft('Public');
    assert.equal((await chat.send()).status, 'queued');
    assert.equal((await chat.sendSos()).status, 'queued');
    alice.vault.write = write;
    await alice.security.importPeer(bob.security.publicIdentity);
    await chat.openConversation(bob.security.deviceId);
    assert.equal(chat.getSnapshot().draft, 'Keep private');
    assert.equal((await chat.send()).status, 'queued');
  } finally { await chat.stop(); await node.stop(); routing.close(); archiveDb.close(); }
});
