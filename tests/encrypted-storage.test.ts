import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import {
  EncryptedStorage, type EncryptedConnection, type EncryptedOpenOptions,
} from '../src/app/infrastructure/EncryptedStorage';
import { SecurityService, SecurityRecoveryError, type SecurityVault } from '../src/features/security';
import { BootstrapError, type BootstrapErrorCode } from '../src/app/domain/BootstrapError';
import type { OpSqliteScalar } from '../src/features/dtn';
import { TestSqliteDatabase } from './helpers/sqlite';

const KEY_NAME = 'database-key-v1';
const EXISTING_KEY = '3f'.repeat(32);

function bootstrapError(code: BootstrapErrorCode): (error: unknown) => boolean {
  return error => error instanceof BootstrapError && error.code === code;
}

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
  assert.throws(() => h.storage.connect('palmesh-chat.sqlite'), bootstrapError('secure-storage-unavailable'));
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
  await assert.rejects(missing.storage.initialize(), bootstrapError('encryption-unavailable'));
  assert.equal(missing.vault.reads, 0);
  assert.equal(missing.opens.length, 0);
  const lost = harness(t);
  await lost.storage.initialize();
  lost.disableCipher();
  assert.throws(() => lost.storage.connect('palmesh-chat.sqlite'), bootstrapError('encryption-unavailable'));
  assert.equal(lost.opens.length, 0);
});

test('corrupt or noncanonical stored keys are preserved and never silently regenerated', async t => {
  for (const value of ['', '3f'.repeat(31), 'FF'.repeat(32), `${EXISTING_KEY}\n`, "x'; PRAGMA key = ''; --"]) {
    const vault = new Vault();
    vault.records.set(KEY_NAME, value);
    const h = harness(t, { vault });
    await assert.rejects(h.storage.initialize(), bootstrapError('data-recovery-required'));
    await assert.rejects(h.storage.initialize(), bootstrapError('data-recovery-required'));
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
    assert.throws(() => h.storage.connect('palmesh-chat.sqlite'), bootstrapError('encryption-unavailable'));
    assert.equal(h.opens.length, 1);
    assert.equal(h.connections[0]?.closed, true);
    assert.deepEqual(h.connections[0]?.queries, ['PRAGMA cipher_version']);
  }
});

test('an unreadable existing schema is closed and its key is preserved without resetting or reopening', async t => {
  const h = harness(t, { unreadableSchema: true });
  await h.storage.initialize();
  const key = h.vault.records.get(KEY_NAME);
  assert.throws(() => h.storage.connect('palmesh-chat.sqlite'), bootstrapError('data-recovery-required'));
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
    assert.throws(() => h.storage.connect('palmesh-chat.sqlite'), bootstrapError('encryption-unavailable'));
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
  await assert.rejects(locked.storage.initialize(), bootstrapError('secure-storage-unavailable'));
  assert.deepEqual(locked.vault.writes, []);
  const short = harness(t);
  short.vault.randomBytes = async () => new Uint8Array(31);
  await assert.rejects(short.storage.initialize(), bootstrapError('secure-storage-unavailable'));
  assert.deepEqual(short.vault.writes, []);
  const writeFailed = harness(t);
  writeFailed.vault.write = async () => { throw new Error('Vault persistence failed'); };
  await assert.rejects(writeFailed.storage.initialize(), bootstrapError('provisioning-incomplete'));
  for (const h of [locked, short, writeFailed]) {
    assert.throws(() => h.storage.connect('palmesh-chat.sqlite'), bootstrapError('secure-storage-unavailable'));
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

/** AppRuntime reconstructs failed resources on retry; only durable vault records
 * survive between these independent composition attempts. */
function secureBootstrap(t: TestContext, vault: Vault) {
  const h = harness(t, { vault });
  const security = new SecurityService(vault);
  return {
    ...h, security,
    initialize: () => h.storage.initialize({
      beforeProvision: existingKey => security.initialize({ requireExistingIdentity: existingKey }),
    }),
  };
}

test('an interrupted first identity write cannot commit a database key and a new bootstrap can retry', async t => {
  const vault = new Vault();
  const write = vault.write.bind(vault);
  vault.write = async (key, value) => {
    if (key === 'identity-v1') throw new Error('Private native failure');
    await write(key, value);
  };
  const failed = secureBootstrap(t, vault);
  await assert.rejects(failed.initialize(), /Private native failure/);
  assert.equal(vault.records.has(KEY_NAME), false);
  assert.equal(vault.records.has('identity-v1'), false);
  assert.equal(vault.writes.length, 0);
  assert.equal(vault.entropy.length, 2, 'Only identity entropy can precede its successful write');
  assert.throws(() => failed.storage.connect('palmesh-chat.sqlite'), bootstrapError('secure-storage-unavailable'));
  vault.write = write;
  const retried = secureBootstrap(t, vault);
  await retried.initialize();
  assert.deepEqual(vault.writes.map(item => item.key), ['identity-v1', KEY_NAME]);
  assert.equal(retried.storage.wasProvisioned, false);
  retried.storage.connect('palmesh-chat.sqlite');
});

test('an interrupted database-key write retries with the original durable identity', async t => {
  const vault = new Vault();
  const write = vault.write.bind(vault);
  vault.write = async (key, value) => {
    if (key === KEY_NAME) throw new Error('Private native persistence failure');
    await write(key, value);
  };
  const failed = secureBootstrap(t, vault);
  await assert.rejects(failed.initialize(), bootstrapError('provisioning-incomplete'));
  const identity = vault.records.get('identity-v1');
  assert.ok(identity);
  const deviceId = failed.security.deviceId;
  assert.equal(vault.records.has(KEY_NAME), false);
  vault.write = write;
  const retried = secureBootstrap(t, vault);
  await retried.initialize();
  assert.equal(retried.security.deviceId, deviceId);
  assert.equal(vault.records.get('identity-v1'), identity);
  assert.equal(vault.writes.filter(item => item.key === 'identity-v1').length, 1);
  assert.equal(vault.entropy.length, 4, 'Retry generates a database key without another identity');
});

test('a key write that commits before rejecting is reused without replacing either key on retry', async t => {
  const vault = new Vault();
  const write = vault.write.bind(vault);
  vault.write = async (key, value) => {
    await write(key, value);
    if (key === KEY_NAME) throw new Error('Native bridge completion interrupted');
  };
  const failed = secureBootstrap(t, vault);
  await assert.rejects(failed.initialize(), bootstrapError('provisioning-incomplete'));
  const identity = vault.records.get('identity-v1');
  const key = vault.records.get(KEY_NAME);
  const entropyCalls = vault.entropy.length;
  const writes = vault.writes.length;
  vault.write = write;
  const retried = secureBootstrap(t, vault);
  await retried.initialize();
  assert.equal(retried.security.deviceId, failed.security.deviceId);
  assert.equal(vault.records.get('identity-v1'), identity);
  assert.equal(vault.records.get(KEY_NAME), key);
  assert.equal(vault.entropy.length, entropyCalls);
  assert.equal(vault.writes.length, writes);
  assert.equal(retried.storage.wasProvisioned, true);
  retried.storage.connect('palmesh-chat.sqlite');
  assert.equal(retried.opens[0]?.encryptionKey, key);
});

test('a saved database key without its identity fails before entropy or database access', async t => {
  const vault = new Vault();
  vault.records.set(KEY_NAME, EXISTING_KEY);
  const h = secureBootstrap(t, vault);
  await assert.rejects(h.initialize(), SecurityRecoveryError);
  assert.equal(vault.records.get(KEY_NAME), EXISTING_KEY);
  assert.deepEqual(vault.writes, []);
  assert.deepEqual(vault.entropy, []);
  assert.deepEqual(h.opens, []);
  assert.throws(() => h.storage.connect('palmesh-chat.sqlite'), bootstrapError('secure-storage-unavailable'));
});

test('unlocking a transiently unavailable vault retries without replacing established keys', async t => {
  const vault = new Vault();
  const initial = secureBootstrap(t, vault);
  await initial.initialize();
  const records = new Map(vault.records);
  const writes = vault.writes.length;
  const entropyCalls = vault.entropy.length;
  const read = vault.read.bind(vault);
  vault.read = async () => { throw new Error('Private native locked-vault details'); };
  await assert.rejects(secureBootstrap(t, vault).initialize(), bootstrapError('secure-storage-unavailable'));
  vault.read = read;
  const retried = secureBootstrap(t, vault);
  await retried.initialize();
  assert.equal(retried.security.deviceId, initial.security.deviceId);
  assert.deepEqual(vault.records, records);
  assert.equal(vault.writes.length, writes);
  assert.equal(vault.entropy.length, entropyCalls);
});

test('native failures are sanitized and failed cleanup cannot replace recovery status', async () => {
  const vault = new Vault();
  vault.records.set(KEY_NAME, EXISTING_KEY);
  const capability = new EncryptedStorage(vault, () => { throw new Error('Private backend details'); }, (): EncryptedConnection => {
    throw new Error('Unexpected open');
  });
  await assert.rejects(capability.initialize(), bootstrapError('encryption-unavailable'));
  const opening = new EncryptedStorage(vault, () => true, (): EncryptedConnection => {
    throw new Error(`Private native failure containing ${EXISTING_KEY}`);
  });
  await opening.initialize();
  assert.throws(() => opening.connect('palmesh-chat.sqlite'), bootstrapError('secure-storage-unavailable'));
  let closes = 0;
  const unreadable = new EncryptedStorage(vault, () => true, () => ({
    executeSync(sql: string) {
      if (sql === 'PRAGMA cipher_version') return { rows: [{ cipher_version: '4.6.1' }], rowsAffected: 0 };
      throw new Error(`Private database path and ${EXISTING_KEY}`);
    },
    close() { closes += 1; throw new Error('Private cleanup failure'); },
  }));
  await unreadable.initialize();
  assert.throws(() => unreadable.connect('palmesh-chat.sqlite'), bootstrapError('data-recovery-required'));
  assert.equal(closes, 1);
});
