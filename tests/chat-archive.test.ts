import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { SqliteChatRepository } from '../src/features/chat/infrastructure/SqliteChatRepository';
import { deliveryState } from '../src/features/chat/domain/messages';
import { TestSqliteDatabase } from './helpers/sqlite';
import { stored } from './helpers/chat';

async function fixture(t: TestContext, maxMessages = 5_000) {
  const db = new TestSqliteDatabase();
  const repo = new SqliteChatRepository(db, { maxMessages });
  t.after(() => db.close());
  await repo.initialize();
  await repo.upsert([], 'alice');
  return { db, repo };
}

test('chat archive survives a close/reopen and keeps history after forwarding expires', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'palmesh-archive-'));
  const path = join(directory, 'chat.sqlite');
  let db = new TestSqliteDatabase(path);
  try {
    let repo = new SqliteChatRepository(db);
    await repo.initialize();
    const record = stored({ kind: 'chat', destination: 'bob', payload: { text: 'Keep our conversation' } });
    await repo.upsert([{ ...record, peerStored: false }], 'alice');
    await repo.markPeerStored(record.message.id);
    db.close();
    db = new TestSqliteDatabase(path);
    repo = new SqliteChatRepository(db);
    await repo.initialize();
    await repo.upsert([], 'alice');
    const messages = await repo.listMessages('bob', 10);
    assert.equal(messages[0]?.text, 'Keep our conversation');
    assert.equal(deliveryState(messages[0]!, 'alice', record.expiresAt + 1), 'peer-stored');
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('chat archive makes custody monotonic, keeps the first UUID payload and preserves read state', async t => {
  const { repo } = await fixture(t);
  const original = stored({ kind: 'chat', destination: 'bob', payload: { text: 'Original' } });
  await repo.upsert([{ ...original, peerStored: true }], 'alice');
  const changed = { ...original, message: { ...original.message, kind: 'chat' as const, payload: { text: 'Changed body' } } };
  await repo.upsert([{ ...changed, peerStored: false }], 'alice');
  const rows = await repo.listMessages('bob', 10);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.text, 'Original');
  assert.equal(rows[0]?.peerStored, true);
  assert.equal(rows[0]?.read, true);
});

test('chat archive unread watermarks use local sequence and leave later same-time messages unread', async t => {
  const { repo } = await fixture(t);
  const first = stored({ kind: 'chat', destination: 'alice', payload: { text: 'First' } }, 'bob', 1_000);
  const later = stored({ kind: 'chat', destination: 'alice', payload: { text: 'Later' } }, 'bob', 1_000);
  await repo.upsert([{ ...first, peerStored: false }], 'alice');
  const through = (await repo.listMessages('bob', 10))[0]!.sequence;
  await repo.upsert([{ ...later, peerStored: false }], 'alice');
  await repo.markRead('bob', through);
  assert.deepEqual((await repo.listMessages('bob', 10)).map(message => message.read), [true, false]);
  assert.equal((await repo.listConversations())[0]?.unreadCount, 1);
  await repo.upsert([{ ...first, peerStored: false }], 'alice');
  assert.equal((await repo.listConversations())[0]?.unreadCount, 1);
});

test('chat archive excludes relay-only unicast and GPS packets while preserving SOS location', async t => {
  const { repo } = await fixture(t);
  const relay = stored({ kind: 'chat', destination: 'carol', payload: { text: 'Not a local conversation' } }, 'bob');
  const gps = stored({ kind: 'location', payload: { location: { latitude: 31.5, longitude: 34.4, timestamp: 1_000 } } }, 'bob');
  const sos = stored({ kind: 'sos', payload: { text: 'Help', location: { latitude: 31.5, longitude: 34.4, timestamp: 1_000 } } }, 'bob');
  await repo.upsert([relay, gps, sos].map(record => ({ ...record, peerStored: false })), 'alice');
  assert.equal((await repo.listConversations()).length, 1);
  const messages = await repo.listMessages('*', 10);
  assert.equal(messages[0]?.kind, 'sos');
  assert.deepEqual(messages[0]?.location, { latitude: 31.5, longitude: 34.4, timestamp: 1_000 });
  assert.equal(Object.isFrozen(messages[0]?.location), true);
});

test('bounded archive evicts oldest bodies without resurrecting them from repeated routing snapshots', async t => {
  const { repo, db } = await fixture(t, 2);
  const records = ['one', 'two', 'three'].map(text => ({ ...stored({ kind: 'chat', destination: 'bob', payload: { text } }), peerStored: false }));
  await repo.upsert(records, 'alice');
  assert.deepEqual((await repo.listMessages('bob', 10)).map(message => message.text), ['two', 'three']);
  await repo.upsert(records, 'alice');
  assert.deepEqual((await repo.listMessages('bob', 10)).map(message => message.text), ['two', 'three']);
  assert.equal(db.execute('SELECT COUNT(*) AS count FROM palmesh_chat_messages').rows[0]?.count, 2);
  assert.equal(db.execute('SELECT COUNT(*) AS count FROM palmesh_chat_seen').rows[0]?.count, 3);
});

test('chat archive binds the device identity before reads and rejects a different identity after reopen', async t => {
  const { db } = await fixture(t);
  const reopened = new SqliteChatRepository(db);
  await reopened.initialize();
  await assert.rejects(reopened.listConversations(), /Bind/);
  await assert.rejects(reopened.upsert([], 'mallory'), /another device/);
  await reopened.upsert([], 'alice');
  assert.deepEqual(await reopened.listConversations(), []);
});

test('archive batch errors roll back bodies, UUID tombstones and ownership changes together', async t => {
  const { repo, db } = await fixture(t);
  db.execute(`CREATE TRIGGER reject_chat BEFORE INSERT ON palmesh_chat_messages
    WHEN NEW.text = 'blocked' BEGIN SELECT RAISE(ABORT, 'simulated archive failure'); END`);
  const records = ['before', 'blocked'].map(text => ({ ...stored({ kind: 'chat', destination: 'bob', payload: { text } }), peerStored: false }));
  await assert.rejects(repo.upsert(records, 'alice'), /simulated archive failure/);
  assert.deepEqual(await repo.listMessages('bob', 10), []);
  assert.equal(db.execute('SELECT COUNT(*) AS count FROM palmesh_chat_seen').rows[0]?.count, 0);
  db.execute('DROP TRIGGER reject_chat');
  await repo.upsert(records, 'alice');
  assert.equal((await repo.listMessages('bob', 10)).length, 2);
});

test('chat archive rejects newer schema and validates query bounds without changing unrelated schema', async t => {
  const db = new TestSqliteDatabase();
  t.after(() => db.close());
  db.execute('PRAGMA user_version = 42');
  db.execute('CREATE TABLE palmesh_chat_schema (singleton INTEGER PRIMARY KEY, version INTEGER, local_device_id TEXT)');
  db.execute('INSERT INTO palmesh_chat_schema VALUES (1, 2, NULL)');
  await assert.rejects(new SqliteChatRepository(db).initialize(), /Unsupported/);
  assert.equal(db.execute('PRAGMA user_version').rows[0]?.user_version, 42);
  const { repo } = await fixture(t);
  await assert.rejects(repo.listMessages('bob', 1_002), /limit/);
  await assert.rejects(repo.markRead('bob', -1), /throughSequence/);
  await assert.rejects(repo.markPeerStored('bad-id'), /UUID/);
  assert.throws(() => new SqliteChatRepository(db, { maxMessages: 0 }), /maxMessages/);
});
