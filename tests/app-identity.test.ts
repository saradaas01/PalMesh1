import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SqliteDeviceIdentity } from '../src/app/infrastructure/SqliteDeviceIdentity';
import type { IdGenerator, SynchronousSqliteDatabase } from '../src/features/dtn';
import { TestSqliteDatabase } from './helpers/sqlite';

const FIRST_ID = 'f13eff05-78dc-4311-a5a4-c5e86ba4f102';
const SECOND_ID = '7c975ff2-ae94-42f9-9e99-703fe9463cd5';
const ids: IdGenerator = { next: () => FIRST_ID };

test('device identity is committed once and survives an actual SQLite close/reopen', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'palmesh-identity-'));
  const path = join(directory, 'identity.sqlite');
  let db = new TestSqliteDatabase(path);
  try {
    let identity = new SqliteDeviceIdentity(db);
    await identity.initialize();
    assert.equal(await identity.getOrCreate(ids), FIRST_ID);
    db.close();
    db = new TestSqliteDatabase(path);
    identity = new SqliteDeviceIdentity(db);
    await identity.initialize();
    assert.equal(await identity.getOrCreate({ next: () => { throw new Error('Must not generate on reopen'); } }), FIRST_ID);
    assert.equal(db.execute('SELECT COUNT(*) AS count FROM palmesh_device_identity').rows[0]?.count, 1);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('multiple connections using the same file retain the first committed UUID', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'palmesh-identity-owners-'));
  const path = join(directory, 'identity.sqlite');
  const firstDb = new TestSqliteDatabase(path);
  const secondDb = new TestSqliteDatabase(path);
  try {
    const first = new SqliteDeviceIdentity(firstDb);
    const second = new SqliteDeviceIdentity(secondDb);
    await Promise.all([first.initialize(), second.initialize()]);
    assert.deepEqual(await Promise.all([first.getOrCreate(ids), second.getOrCreate({ next: () => SECOND_ID })]), [FIRST_ID, FIRST_ID]);
  } finally { secondDb.close(); firstDb.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('identity initialization rejects newer namespaced schemas and leaves global user_version intact', async t => {
  const db = new TestSqliteDatabase();
  t.after(() => db.close());
  db.execute('PRAGMA user_version = 41');
  db.execute('CREATE TABLE palmesh_identity_schema (singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL)');
  db.execute('INSERT INTO palmesh_identity_schema VALUES (1, 2)');
  await assert.rejects(new SqliteDeviceIdentity(db).initialize(), /Unsupported.*identity schema version: 2/);
  assert.equal(db.execute('PRAGMA user_version').rows[0]?.user_version, 41);
  assert.equal(db.execute('SELECT version FROM palmesh_identity_schema').rows[0]?.version, 2);
  assert.equal(db.execute("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'palmesh_device_identity'").rows[0]?.count, 0);
});

test('a corrupt stored identity is rejected without replacement or generator invocation', async t => {
  const db = new TestSqliteDatabase();
  t.after(() => db.close());
  const identity = new SqliteDeviceIdentity(db);
  await identity.initialize();
  let calls = 0;
  for (const corrupt of ['not-an-identity', `${FIRST_ID}\n`]) {
    db.execute('INSERT OR REPLACE INTO palmesh_device_identity VALUES (1, ?)', [corrupt]);
    await assert.rejects(identity.getOrCreate({ next: () => { calls += 1; return FIRST_ID; } }), /Stored device identity/);
    assert.equal(db.execute('SELECT device_id FROM palmesh_device_identity').rows[0]?.device_id, corrupt);
  }
  assert.equal(calls, 0);
});

test('entropy failure and invalid generated IDs leave no insecure fallback identity behind', async t => {
  const db = new TestSqliteDatabase();
  t.after(() => db.close());
  const identity = new SqliteDeviceIdentity(db);
  await assert.rejects(identity.getOrCreate(ids), /Initialize/);
  await identity.initialize();
  const entropyError = new Error('Secure random source unavailable');
  await assert.rejects(identity.getOrCreate({ next: () => { throw entropyError; } }), error => error === entropyError);
  for (const invalid of ['alice', 'f13eff05-78dc-1311-a5a4-c5e86ba4f102', 'f13eff05-78dc-4311-75a4-c5e86ba4f102', `${FIRST_ID}\n`, `${FIRST_ID}\r\n`, '']) {
    await assert.rejects(identity.getOrCreate({ next: () => invalid }), /UUID v4/);
  }
  assert.equal(db.execute('SELECT COUNT(*) AS count FROM palmesh_device_identity').rows[0]?.count, 0);
  assert.equal(await identity.getOrCreate(ids), FIRST_ID);
});

test('failed identity commits roll back and preserve the original error', async t => {
  const db = new TestSqliteDatabase();
  t.after(() => db.close());
  const commitError = new Error('Storage commit unavailable');
  let rejectCommit = false;
  const failing: SynchronousSqliteDatabase = {
    execute(sql, parameters) {
      if (sql === 'COMMIT' && rejectCommit) throw commitError;
      return db.execute(sql, parameters);
    },
  };
  const identity = new SqliteDeviceIdentity(failing);
  await identity.initialize();
  rejectCommit = true;
  await assert.rejects(identity.getOrCreate(ids), error => error === commitError);
  assert.equal(db.execute('SELECT COUNT(*) AS count FROM palmesh_device_identity').rows[0]?.count, 0);
  rejectCommit = false;
  assert.equal(await identity.getOrCreate({ next: () => SECOND_ID }), SECOND_ID);
});

test('failed schema initialization rolls back the migration and can be retried', async t => {
  const db = new TestSqliteDatabase();
  t.after(() => db.close());
  let fail = true;
  const failing: SynchronousSqliteDatabase = {
    execute(sql, parameters) {
      if (sql.startsWith('INSERT INTO palmesh_identity_schema') && fail) throw new Error('Migration interrupted');
      return db.execute(sql, parameters);
    },
  };
  const identity = new SqliteDeviceIdentity(failing);
  await assert.rejects(identity.initialize(), /Migration interrupted/);
  assert.equal(db.execute("SELECT COUNT(*) AS count FROM sqlite_master WHERE name LIKE 'palmesh_%'").rows[0]?.count, 0);
  fail = false;
  await identity.initialize();
  assert.equal(await identity.getOrCreate(ids), FIRST_ID);
});
