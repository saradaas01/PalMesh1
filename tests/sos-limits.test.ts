import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { ChatService } from '../src/features/chat/application/ChatService';
import { SqliteChatRepository } from '../src/features/chat/infrastructure/SqliteChatRepository';
import { DtnEngine } from '../src/features/dtn/application/DtnEngine';
import { EmergencyRateLimitError, type MeshMessage, type StorageLimits, type StoredMessage } from '../src/features/dtn/domain/types';
import { createMessage } from '../src/features/dtn/domain/validation';
import { SqliteDtnStore } from '../src/features/dtn/infrastructure/sqlite/SqliteDtnStore';
import { EmergencyService, SqliteEmergencyRepository } from '../src/features/emergency';
import { ControlledChatEngine, stored } from './helpers/chat';
import { TestSqliteDatabase } from './helpers/sqlite';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const LIMITS: StorageLimits = {
  maxMessages: 200, reservedEmergencyMessages: 20, maxSeenIds: 1_000, reservedEmergencySeenIds: 100, maxPeersPerMessage: 8,
};

async function engineFixture(t: TestContext) {
  const database = new TestSqliteDatabase();
  const time = { value: 10 * 24 * HOUR };
  const engine = new DtnEngine({
    deviceId: 'alice', store: new SqliteDtnStore(database), ids: { next: randomUUID },
    clock: { now: () => time.value }, transport: { async send() { /* No peers are connected. */ } },
  });
  await engine.start();
  t.after(async () => { await engine.stop(); database.close(); });
  const sos = () => engine.publish({ kind: 'sos', payload: { text: 'Help' } });
  return { engine, time, sos };
}

async function rejectsUntil(promise: Promise<unknown>, retryAt: number): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof EmergencyRateLimitError && error.retryAt === retryAt);
}

test('this device allows one SOS per 2 minutes and reports when the next is allowed', async t => {
  const { time, sos } = await engineFixture(t);
  const first = time.value;
  assert.equal((await sos()).status, 'accepted');
  time.value += 30_000;
  await rejectsUntil(sos(), first + 2 * MINUTE);
  time.value = first + 2 * MINUTE;
  assert.equal((await sos()).status, 'accepted');
});

test('this device sends at most 3 SOS per hour and 6 per day', async t => {
  const { time, sos } = await engineFixture(t);
  const start = time.value;
  for (let index = 0; index < 3; index += 1) {
    time.value = start + index * 3 * MINUTE;
    assert.equal((await sos()).status, 'accepted');
  }
  time.value = start + 20 * MINUTE;
  // The hourly window reopens one hour after the oldest of the three.
  await rejectsUntil(sos(), start + HOUR);
  const sent = [start, start + 3 * MINUTE, start + 6 * MINUTE];
  for (const at of [start + HOUR, start + HOUR + 3 * MINUTE, start + HOUR + 6 * MINUTE]) {
    time.value = at;
    assert.equal((await sos()).status, 'accepted');
    sent.push(at);
  }
  time.value = start + 3 * HOUR;
  await rejectsUntil(sos(), sent[0]! + 24 * HOUR);
  time.value = sent[0]! + 24 * HOUR;
  assert.equal((await sos()).status, 'accepted', 'old SOS leave the daily window');
});

test('this device sends at most 10 SOS responses per hour, without a cooldown', async t => {
  const { engine, time } = await engineFixture(t);
  const start = time.value;
  const respond = () => engine.publish({ kind: 'sos-response', destination: 'bob', payload: { sosId: randomUUID(), status: 'responding' } });
  for (let index = 0; index < 10; index += 1) assert.equal((await respond()).status, 'accepted');
  await rejectsUntil(respond(), start + HOUR);
  // Ordinary chat is never limited by the SOS budget.
  assert.equal((await engine.publish({ kind: 'chat', destination: '*', payload: { text: 'Still here' } })).status, 'accepted');
});

function sosFrom(source: string, receivedAt: number): StoredMessage {
  return { message: createMessage({ kind: 'sos', payload: { text: 'Help' } }, randomUUID(), source, receivedAt),
    receivedAt, expiresAt: receivedAt + 24 * HOUR, dedupExpiresAt: receivedAt + 48 * HOUR, forwardable: true };
}

test('relays keep emergency priority for at most 6 SOS per sender; extras queue as normal chat', async t => {
  const database = new TestSqliteDatabase();
  const store = new SqliteDtnStore(database);
  await store.initialize();
  t.after(() => database.close());
  const now = 1_000;
  for (let index = 0; index < 8; index += 1) {
    assert.equal((await store.accept(sosFrom('spammer', now + index), null, LIMITS, now)).status, 'accepted');
  }
  await store.accept(sosFrom('honest', now + 100), null, LIMITS, now);
  const ranks = (source: string) => database.execute(
    'SELECT priority_rank FROM palmesh_dtn_messages WHERE source = ? ORDER BY sequence', [source]).rows.map(row => row.priority_rank);
  assert.deepEqual(ranks('spammer'), [0, 0, 0, 0, 0, 0, 3, 3]);
  assert.deepEqual(ranks('honest'), [0], 'one sender cannot exhaust another sender’s budget');
  // Battery saver forwards only packets that kept emergency priority here.
  const forwarded: MeshMessage[] = [];
  for (let next = await store.getNextDelivery(['peer'], now + 200, true, 8); next; next = await store.getNextDelivery(['peer'], now + 200, true, 8)) {
    forwarded.push(next.record.message);
    await store.markAcknowledged(next.record.message.id, 'peer', now + 200);
  }
  assert.equal(forwarded.length, 7);
  assert.equal(forwarded.filter(message => message.source === 'spammer').length, 6);
  // A downgraded SOS cannot use reserved emergency storage.
  const tight: StorageLimits = { ...LIMITS, maxMessages: 9, reservedEmergencyMessages: 5 };
  assert.deepEqual(await store.accept(sosFrom('spammer', now + 300), null, tight, now), { status: 'full', resource: 'messages' });
  await assert.rejects(store.accept(sosFrom('x', now), null, { ...LIMITS, maxEmergencyPerSource: -1 }, now), /maxEmergencyPerSource/);
});

test('SOS limits surface as a clear chat issue instead of a generic failure', async t => {
  const database = new TestSqliteDatabase();
  const engine = new ControlledChatEngine();
  engine.publishNext = async () => { throw new EmergencyRateLimitError('sos', 5_000); };
  const service = new ChatService({ engine, repository: new SqliteChatRepository(database), clock: { now: () => 1_000 } });
  t.after(async () => { await service.stop(); database.close(); });
  await service.start();
  assert.deepEqual(await service.sendSos(), { status: 'rejected', reason: 'limited' });
  assert.equal(service.getSnapshot().issue, 'sos-limited');
});

test('a receiving phone shows at most one SOS alert per sender every 10 minutes', async t => {
  const database = new TestSqliteDatabase();
  const engine = new ControlledChatEngine();
  const time = { value: 50_000 };
  const notified: string[] = [];
  const service = new EmergencyService({ engine, repository: new SqliteEmergencyRepository(database), clock: { now: () => time.value },
    alerts: { notifyIncoming: async value => { notified.push(value.source); }, cancel: async () => undefined } });
  t.after(async () => { await service.stop(); database.close(); });
  await service.start();
  const incoming = (source: string) => {
    const record = stored({ kind: 'sos', payload: { text: 'Help' } }, source, time.value);
    engine.emit({ type: 'accepted', record, local: false });
  };
  const settle = async (count: number) => {
    for (let attempt = 0; attempt < 200 && service.getSnapshot().entries.length < count; attempt += 1) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  };
  incoming('bob'); await settle(1);
  incoming('bob'); await settle(2);
  incoming('carol'); await settle(3);
  assert.deepEqual(notified, ['bob', 'carol']);
  assert.equal(service.getSnapshot().entries.length, 3, 'throttled SOS still appear in the inbox');
  time.value += 10 * MINUTE;
  incoming('bob'); await settle(4);
  assert.deepEqual(notified, ['bob', 'carol', 'bob']);
});

test('SOS limit configuration is validated', () => {
  const base = { deviceId: 'alice', store: new SqliteDtnStore(new TestSqliteDatabase()), ids: { next: randomUUID }, transport: { async send() {} } };
  assert.throws(() => new DtnEngine({ ...base, config: { maxSosPerHour: 7, maxSosPerDay: 6 } }), /Inconsistent/);
  assert.throws(() => new DtnEngine({ ...base, config: { maxSosPerDay: 65 } }), /Inconsistent/);
  assert.throws(() => new DtnEngine({ ...base, config: { sosCooldownMs: 0 } }), /sosCooldownMs/);
});
