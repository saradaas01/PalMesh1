import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DtnEngine } from '../src/features/dtn/application/DtnEngine';
import { randomUUID } from 'node:crypto';
import { stored } from './helpers/chat';
import { createTestStore } from './helpers/sqlite';

const limits = { maxMessages: 100, reservedEmergencyMessages: 10, maxSeenIds: 1_000, reservedEmergencySeenIds: 100, maxPeersPerMessage: 10 };

test('routing custody snapshots distinguish retries and source receipts from a durable peer ACK', async t => {
  const { store, close } = createTestStore();
  t.after(close);
  await store.initialize();
  const queued = stored({ kind: 'chat', destination: 'bob', payload: { text: 'Retrying' } });
  const acknowledged = stored({ kind: 'chat', destination: 'bob', payload: { text: 'Peer stored it' } });
  await store.accept(queued, null, limits, 1_000);
  await store.accept(acknowledged, null, limits, 1_000);
  await store.markAcknowledged(queued.message.id, 'alice', 1_000);
  await store.markFailed({ messageId: queued.message.id, peerId: 'relay', attempts: 1, nextAttemptAt: 2_000, now: 1_000 });
  await store.markAcknowledged(acknowledged.message.id, 'relay', 1_000);
  const snapshot = await store.listHistoryWithCustody(10);
  assert.deepEqual(snapshot.map(entry => [entry.message.payload, entry.peerStored]), [
    [{ text: 'Retrying' }, false], [{ text: 'Peer stored it' }, true],
  ]);
  assert.equal((await store.getNextDelivery(['relay'], 1_000, false, 10))?.record.message.id, queued.message.id);
});

test('routing custody snapshot takes the latest window in ascending local arrival order', async t => {
  const { store, close } = createTestStore();
  t.after(close);
  await store.initialize();
  for (const text of ['one', 'two', 'three']) await store.accept(stored({ kind: 'chat', destination: 'bob', payload: { text } }), null, limits, 1_000);
  assert.deepEqual((await store.listHistoryWithCustody(2)).map(entry => entry.message.payload), [{ text: 'two' }, { text: 'three' }]);
  assert.deepEqual(await store.listHistoryWithCustody(0), []);
  await assert.rejects(store.listHistoryWithCustody(1_001), /limit/);
});

test('engine custody reads require startup and enforce the public history limit', async t => {
  const { store, close } = createTestStore();
  const engine = new DtnEngine({ deviceId: 'alice', store, ids: { next: randomUUID }, transport: { async send() {} }, clock: { now: () => 1_000 } });
  t.after(async () => { await engine.stop(); close(); });
  assert.throws(() => engine.historyWithCustody(), /Start/);
  await engine.start();
  assert.throws(() => engine.historyWithCustody(0), /limit/);
  assert.deepEqual(await engine.historyWithCustody(), []);
});
