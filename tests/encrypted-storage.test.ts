import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import {
  EncryptedStorage, type EncryptedConnection, type EncryptedOpenOptions,
} from '../src/app/infrastructure/EncryptedStorage';
import type { SecurityVault } from '../src/features/security';
import type { OpSqliteScalar } from '../src/features/dtn';
import { TestSqliteDatabase } from './helpers/sqlite';

const KEY_NAME = 'database-key-v1';
const EXISTING_KEY = '3f'.repeat(32);

class Vault implements SecurityVault {
  readonly records = new Map<string, string>();
  readonly writes: { key: string; value: string }[] = [];
  readonly entropy: Uint8Array[] = [];
  reads = 0;
  async read(key: string): Promise<string | null> { this.reads++; return this.records.get(key) ?? null; }
  async write(key: string, value: string): Promise<void> { this.writes.push({ key, value }); this.records.set(key, value); }
  async randomBytes(length: number): Promise<Uint8Array> {
    const bytes = new Uint8Array(randomBytes(length));
    this.entropy.push(bytes);
    return bytes;
  }
}

interface Connection extends EncryptedConnection {
  closed: boolean;
  readonly queries: string[];
}

/** Node SQLite exercises the real connection and schema behavior. Only the
 * native SQLCipher capability PRAGMAs are supplied here; this test deliberately
 * makes no claim to verify native encryption on disk.
 */
function harness(t: TestContext, options: {
  vault?: Vault;
  cipherVersion?: OpSqliteScalar;
  memoryProtection?: OpSqliteScalar;
  unreadableSchema?: boolean;
} = {}) {
  const vault = options.vault ?? new Vault();
  const opens: EncryptedOpenOptions[] = [];
  const connections: Connection[] = [];
  let cipherAvailable = true;
  const storage = new EncryptedStorage(vault, () => cipherAvailable, open => {
    opens.push(open);
    const db = new TestSqliteDatabase();
    const queries: string[] = [];
    const connection: Connection = {
      closed: false, queries,
      executeSync(sql, parameters = []) {
        queries.push(sql);
        if (sql === 'PRAGMA cipher_version') {
          return { rows: [{ cipher_version: options.cipherVersion ?? '4.6.1' }], rowsAffected: 0 };
        }
        if (sql === 'PRAGMA cipher_memory_security = ON') return { rows: [], rowsAffected: 0 };
        if (sql === 'PRAGMA cipher_memory_security') {
          return { rows: [{ cipher_memory_security: options.memoryProtection ?? 1 }], rowsAffected: 0 };
        }
        if (options.unreadableSchema && sql === 'SELECT count(*) FROM sqlite_master') {
          throw new Error('file is not a database');
        }
        if (parameters.length > 0) throw new Error('Unexpected parameter at SQLCipher setup boundary');
        return db.execute(sql);
      },
      close() {
        assert.equal(connection.closed, false, 'Connection must close exactly once');
        connection.closed = true;
        db.close();
      },
    };
    connections.push(connection);
    return connection;
  });
  t.after(() => { for (const connection of connections) if (!connection.closed) connection.close(); });
  return { vault, storage, opens, connections, disableCipher: () => { cipherAvailable = false; } };
}

test('concurrent initialization creates one OS-random key and sends it only through native open options', async t => {
  const h = harness(t);
  assert.throws(() => h.storage.connect('palmesh-chat.sqlite'), /Encrypted storage is unavailable/);
  await Promise.all([h.storage.initialize(), h.storage.initialize(), h.storage.initialize()]);
  assert.equal(h.vault.reads, 1);
  assert.equal(h.vault.writes.length, 1);
  assert.equal(h.vault.writes[0]!.key, KEY_NAME);
  const key = h.vault.records.get(KEY_NAME)!;
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(h.vault.entropy.length, 1);
  assert.deepEqual(h.vault.entropy[0], new Uint8Array(32), 'Temporary entropy must be cleared');
  const first = h.storage.connect('palmesh-chat.sqlite');
  const second = h.storage.connect('palmesh-dtn.sqlite');
  assert.deepEqual(h.opens, [
    { name: 'palmesh-chat.sqlite', encryptionKey: key },
    { name: 'palmesh-dtn.sqlite', encryptionKey: key },
  ]);
  for (const connection of [first, second]) {
    assert.ok(connection.queries.every(sql => !sql.includes(key) && !/PRAGMA\s+key\b/i.test(sql)));
    assert.ok(connection.queries.includes('SELECT count(*) FROM sqlite_master'));
    assert.equal(connection.executeSync('PRAGMA secure_delete').rows[0]?.secure_delete, 1);
  }
});

test('a stored key survives a new storage instance without generating or persisting a replacement', async t => {
  const vault = new Vault();
  vault.records.set(KEY_NAME, EXISTING_KEY);
  const first = harness(t, { vault });
  await first.storage.initialize();
  first.storage.connect('palmesh-chat.sqlite');
  const restarted = harness(t, { vault });
  await restarted.storage.initialize();
  restarted.storage.connect('palmesh-chat.sqlite');
  assert.equal(first.opens[0]?.encryptionKey, EXISTING_KEY);
  assert.equal(restarted.opens[0]?.encryptionKey, EXISTING_KEY);
  assert.equal(vault.entropy.length, 0);
  assert.deepEqual(vault.writes, []);
});

test('an unavailable SQLCipher build never reads keys or opens plaintext, including after initialization', async t => {
  const missing = harness(t);
  missing.disableCipher();
  await assert.rejects(missing.storage.initialize(), /does not include SQLCipher/);
  assert.equal(missing.vault.reads, 0);
  assert.equal(missing.opens.length, 0);
  const lost = harness(t);
  await lost.storage.initialize();
  lost.disableCipher();
  assert.throws(() => lost.storage.connect('palmesh-chat.sqlite'), /Encrypted storage is unavailable/);
  assert.equal(lost.opens.length, 0);
});

test('corrupt or noncanonical stored keys are preserved and never silently regenerated', async t => {
  for (const value of ['', '3f'.repeat(31), 'FF'.repeat(32), `${EXISTING_KEY}\n`, "x'; PRAGMA key = ''; --"]) {
    const vault = new Vault();
    vault.records.set(KEY_NAME, value);
    const h = harness(t, { vault });
    await assert.rejects(h.storage.initialize(), /Stored database key is invalid/);
    await assert.rejects(h.storage.initialize(), /Stored database key is invalid/);
    assert.equal(vault.records.get(KEY_NAME), value);
    assert.equal(vault.reads, 1);
    assert.equal(vault.entropy.length, 0);
    assert.deepEqual(vault.writes, []);
    assert.equal(h.opens.length, 0);
  }
});

test('a backend that claims SQLCipher without its version is closed without a plaintext retry', async t => {
  for (const version of ['', 'SQLite 3.50.0', 4]) {
    const h = harness(t, { cipherVersion: version });
    await h.storage.initialize();
    assert.throws(() => h.storage.connect('palmesh-chat.sqlite'), /Preserve existing data and keys for recovery/);
    assert.equal(h.opens.length, 1);
    assert.equal(h.connections[0]?.closed, true);
    assert.deepEqual(h.connections[0]?.queries, ['PRAGMA cipher_version']);
  }
});

test('an unreadable existing schema is closed and its key is preserved without resetting or reopening', async t => {
  const h = harness(t, { unreadableSchema: true });
  await h.storage.initialize();
  const key = h.vault.records.get(KEY_NAME);
  assert.throws(() => h.storage.connect('palmesh-chat.sqlite'), /Encrypted local storage could not be opened/);
  assert.equal(h.connections[0]?.closed, true);
  assert.equal(h.opens.length, 1);
  assert.equal(h.vault.records.get(KEY_NAME), key);
  assert.equal(h.vault.writes.length, 1);
  assert.ok(h.connections[0]?.queries.every(sql => !/DROP|DELETE|VACUUM|REKEY/i.test(sql)));
});

test('SQLCipher memory protection must actually be enabled before returning a handle', async t => {
  for (const value of [0, '0', 'ON', false]) {
    const h = harness(t, { memoryProtection: value });
    await h.storage.initialize();
    assert.throws(() => h.storage.connect('palmesh-chat.sqlite'), /Preserve existing data and keys/);
    assert.equal(h.connections[0]?.closed, true);
    assert.equal(h.opens.length, 1);
  }
  const stringValue = harness(t, { memoryProtection: '1' });
  await stringValue.storage.initialize();
  assert.equal(stringValue.storage.connect('palmesh-chat.sqlite').closed, false);
});

test('vault failures and invalid entropy never expose an initialized storage connection', async t => {
  const locked = harness(t);
  locked.vault.read = async () => { throw new Error('Vault is locked'); };
  await assert.rejects(locked.storage.initialize(), /Vault is locked/);
  assert.deepEqual(locked.vault.writes, []);
  const short = harness(t);
  short.vault.randomBytes = async () => new Uint8Array(31);
  await assert.rejects(short.storage.initialize(), /Native key entropy/);
  assert.deepEqual(short.vault.writes, []);
  const writeFailed = harness(t);
  writeFailed.vault.write = async () => { throw new Error('Vault persistence failed'); };
  await assert.rejects(writeFailed.storage.initialize(), /Vault persistence failed/);
  for (const h of [locked, short, writeFailed]) {
    assert.throws(() => h.storage.connect('palmesh-chat.sqlite'), /Encrypted storage is unavailable/);
    assert.deepEqual(h.opens, []);
  }
});

test('private database names are validated before calling the native backend', async t => {
  const h = harness(t);
  await h.storage.initialize();
  for (const name of ['../palmesh-chat.sqlite', '/palmesh-chat.sqlite', 'other.sqlite', 'palmesh-chat.sqlite\n', "palmesh-chat.sqlite';--"]) {
    assert.throws(() => h.storage.connect(name), /Invalid private database name/);
  }
  assert.deepEqual(h.opens, []);
});
