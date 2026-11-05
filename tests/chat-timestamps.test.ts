import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { projectEntry } from '../src/features/chat/domain/messages';
import type { RoutingChatEntry } from '../src/features/chat/domain/types';
import { SqliteChatRepository } from '../src/features/chat/infrastructure/SqliteChatRepository';
import { DtnEngine } from '../src/features/dtn/application/DtnEngine';
import type { MeshMessage } from '../src/features/dtn/domain/types';
import { createMessage } from '../src/features/dtn/domain/validation';
import { SqliteDtnStore } from '../src/features/dtn/infrastructure/sqlite/SqliteDtnStore';
import { TestSqliteDatabase } from './helpers/sqlite';

const SENT = Date.UTC(2026, 10, 5, 7); // 10:00 in Aqaba; wire values stay UTC epoch milliseconds.
const MINUTE = 60_000;

function entry(text: string, createdAt: number, receivedAt: number, source = 'sara'): RoutingChatEntry {
  return {
    message: createMessage({ kind: 'chat', destination: 'samer', payload: { text } }, randomUUID(), source, createdAt),
    receivedAt, expiresAt: receivedAt + 24 * 60 * MINUTE, peerStored: false,
  };
}

test('a delayed chat projection preserves original 10:00 sender time separately from 10:25 local storage', () => {
  const delayed = entry('Sent before reconnecting', SENT, SENT + 25 * MINUTE);
  const projected = projectEntry(delayed, 'samer');
  assert.ok(projected);
  assert.equal(projected.createdAt, SENT);
  assert.equal(projected.receivedAt, SENT + 25 * MINUTE);
  assert.equal(projected.outgoing, false);
  assert.deepEqual(Object.keys(delayed.message).sort(), ['createdAt', 'destination', 'id', 'kind', 'payload', 'source', 'ttl', 'version']);
});

test('offline queue, failed forwarding, relay delay and duplicate arrival never rewrite sender time or first local receipt', async t => {
  const databases = [new TestSqliteDatabase(), new TestSqliteDatabase(), new TestSqliteDatabase()];
  const senderTime = { now: SENT };
  const relayTime = { now: SENT + 10 * MINUTE };
  const receiverTime = { now: SENT + 25 * MINUTE };
  const attempts: MeshMessage[] = [];
  let relay!: DtnEngine;
  let receiver!: DtnEngine;
  const sender = new DtnEngine({
    deviceId: 'sara', store: new SqliteDtnStore(databases[0]!), ids: { next: randomUUID }, clock: { now: () => senderTime.now },
    transport: { async send(_peer, packet) {
      attempts.push(packet);
      if (attempts.length === 1) throw new Error('The offline route disappeared');
      assert.equal((await relay.receive('sara', packet)).status, 'accepted');
    } },
  });
  relay = new DtnEngine({
    deviceId: 'carrier', store: new SqliteDtnStore(databases[1]!), ids: { next: randomUUID }, clock: { now: () => relayTime.now },
    transport: { async send(_peer, packet) { assert.equal((await receiver.receive('carrier', packet)).status, 'accepted'); } },
  });
  receiver = new DtnEngine({
    deviceId: 'samer', store: new SqliteDtnStore(databases[2]!), ids: { next: randomUUID }, clock: { now: () => receiverTime.now },
    transport: { async send() {} },
  });
  t.after(async () => {
    await Promise.all([sender.stop(), relay.stop(), receiver.stop()]);
    for (const database of databases) database.close();
  });
  await Promise.all([sender.start(), relay.start(), receiver.start()]);
  const queued = await sender.publish({ kind: 'chat', destination: 'samer', payload: { text: 'Queued offline at 10:00' } });
  assert.equal(queued.status, 'accepted');
  assert.equal(attempts.length, 0);
  senderTime.now += 5 * MINUTE;
  sender.setConnectedPeers(['carrier']);
  await sender.flush();
  assert.equal(attempts.length, 1);
  senderTime.now += 5 * MINUTE;
  await sender.flush();
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts.map(packet => packet.createdAt), [SENT, SENT]);
  const relayed = (await relay.history())[0]!;
  assert.equal(relayed.message.createdAt, SENT);
  assert.equal(relayed.receivedAt, SENT + 10 * MINUTE);
  relayTime.now += 15 * MINUTE;
  relay.setConnectedPeers(['samer']);
  await relay.flush();
  const arrived = (await receiver.historyWithCustody())[0]!;
  assert.equal(arrived.message.createdAt, SENT);
  assert.equal(arrived.receivedAt, SENT + 25 * MINUTE);
  assert.equal(arrived.message.ttl, queued.status === 'accepted' ? queued.record.message.ttl - 2 : -1);
  receiverTime.now += 5 * MINUTE;
  assert.equal((await receiver.receive('other-carrier', relayed.message)).status, 'duplicate');
  const repeated = (await receiver.historyWithCustody())[0]!;
  assert.equal(repeated.receivedAt, arrived.receivedAt);
  assert.equal(projectEntry(repeated, 'samer')?.createdAt, SENT);
  const senderHistory = (await sender.historyWithCustody())[0]!;
  assert.equal(senderHistory.message.createdAt, SENT);
  assert.equal(senderHistory.receivedAt, SENT);
  assert.equal(senderHistory.peerStored, true);
});

test('out-of-order arrivals retain sender times while local sequence and unread state ignore implausible sender clocks', async t => {
  const database = new TestSqliteDatabase();
  t.after(() => database.close());
  const archive = new SqliteChatRepository(database);
  await archive.initialize();
  const firstArrival = entry('Newer send arrived first', SENT + 5 * MINUTE, SENT + 24 * MINUTE);
  const delayed = entry('Earlier send arrived later', SENT, SENT + 25 * MINUTE);
  const skewed = entry('Far future sender clock', Date.UTC(2099, 0, 1), SENT + 26 * MINUTE, 'future-clock');
  const current = entry('Current conversation', SENT + 26 * MINUTE, SENT + 27 * MINUTE, 'current-clock');
  await archive.upsert([current, delayed, skewed, firstArrival], 'samer');
  const messages = await archive.listMessages('sara', 10);
  assert.deepEqual(messages.map(message => [message.text, message.createdAt, message.receivedAt]), [
    ['Newer send arrived first', SENT + 5 * MINUTE, SENT + 24 * MINUTE],
    ['Earlier send arrived later', SENT, SENT + 25 * MINUTE],
  ]);
  assert.deepEqual((await archive.listConversations()).map(conversation => conversation.id), ['current-clock', 'future-clock', 'sara']);
  assert.equal((await archive.listConversations())[2]?.lastMessage.createdAt, SENT);
  await archive.markRead('sara', messages[0]!.sequence);
  assert.deepEqual((await archive.listMessages('sara', 10)).map(message => message.read), [true, false]);
});

test('original sending and first storage timestamps survive replay, custody updates and a real SQLite close/reopen', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'palmesh-timestamps-'));
  const path = join(directory, 'history.sqlite');
  let database = new TestSqliteDatabase(path);
  try {
    let archive = new SqliteChatRepository(database);
    await archive.initialize();
    const original = entry('Original delayed history', SENT, SENT + 25 * MINUTE);
    await archive.upsert([original], 'samer');
    const first = (await archive.listMessages('sara', 10))[0]!;
    // Even a later snapshot that supplies altered metadata cannot replace an archived UUID.
    const replay = { ...original, message: { ...original.message, createdAt: SENT + 30 * MINUTE }, receivedAt: SENT + 45 * MINUTE, peerStored: true };
    await archive.upsert([replay], 'samer');
    await archive.markRead('sara', first.sequence);
    database.close();
    database = new TestSqliteDatabase(path);
    archive = new SqliteChatRepository(database);
    await archive.initialize(); await archive.upsert([], 'samer');
    const restored = (await archive.listMessages('sara', 10))[0]!;
    assert.equal(restored.id, original.message.id);
    assert.equal(restored.sequence, first.sequence);
    assert.equal(restored.createdAt, SENT);
    assert.equal(restored.receivedAt, SENT + 25 * MINUTE);
    assert.equal(restored.read, true);
    assert.equal((await archive.listConversations())[0]?.lastMessage.createdAt, SENT);
    assert.equal(database.execute('SELECT version FROM palmesh_chat_schema WHERE singleton=1').rows[0]?.version, 2);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
