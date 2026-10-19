import type { SecurityVault } from '../../features/security';
import type { OpSqliteSyncConnection } from '../../features/dtn';

const STORAGE_KEY = 'database-key-v1';
const HEX_KEY = /^[0-9a-f]{64}$(?![\s\S])/;

export interface EncryptedConnection extends OpSqliteSyncConnection { close(): void }
export interface EncryptedOpenOptions { readonly name: string; readonly encryptionKey: string }

/** Key bytes are created by the OS and persisted only through the native vault.
 * SQLCipher receives the key through its C API, never interpolated SQL. Existing
 * plaintext/corrupt databases fail closed; they are never deleted or reset.
 */
export class EncryptedStorage<Connection extends EncryptedConnection> {
  private key: string | undefined;
  private initialization: Promise<void> | undefined;
  private existingKey = false;

  get wasProvisioned(): boolean {
    if (!this.key) throw new Error('Initialize encrypted storage before reading installation state.');
    return this.existingKey;
  }

  constructor(
    private readonly vault: SecurityVault,
    private readonly isSqlCipher: () => boolean,
    private readonly open: (options: EncryptedOpenOptions) => Connection,
  ) {}

  initialize(): Promise<void> {
    this.initialization ??= this.loadKey();
    return this.initialization;
  }

  connect(name: string): Connection {
    if (!this.key || !this.isSqlCipher()) throw new Error('Encrypted storage is unavailable.');
    if (!/^palmesh-[a-z-]+\.sqlite$/.test(name)) throw new Error('Invalid private database name.');
    const connection = this.open({ name, encryptionKey: this.key });
    try {
      const version = connection.executeSync('PRAGMA cipher_version').rows[0]?.cipher_version;
      if (typeof version !== 'string' || !/^\d+\.\d+\./.test(version)) {
        throw new Error('A verified SQLCipher backend is required.');
      }
      // SQLCipher must authenticate/decrypt an existing schema before a store
      // can run migrations. No attempt is made to retry without encryption.
      connection.executeSync('PRAGMA cipher_memory_security = ON');
      connection.executeSync('SELECT count(*) FROM sqlite_master');
      const memoryProtection = connection.executeSync('PRAGMA cipher_memory_security').rows[0]?.cipher_memory_security;
      if (memoryProtection !== 1 && memoryProtection !== '1') {
        throw new Error('SQLCipher memory protection is unavailable.');
      }
      connection.executeSync('PRAGMA secure_delete = ON');
      return connection;
    } catch {
      connection.close();
      throw new Error('Encrypted local storage could not be opened. Preserve existing data and keys for recovery.');
    }
  }

  private async loadKey(): Promise<void> {
    if (!this.isSqlCipher()) throw new Error('This build does not include SQLCipher.');
    const stored = await this.vault.read(STORAGE_KEY);
    if (stored !== null) {
      if (!HEX_KEY.test(stored)) throw new Error('Stored database key is invalid; recovery is required.');
      this.key = stored;
      this.existingKey = true;
      return;
    }
    const bytes = await this.vault.randomBytes(32);
    if (bytes.length !== 32) throw new Error('Native key entropy is unavailable.');
    const key = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
    bytes.fill(0);
    await this.vault.write(STORAGE_KEY, key);
    this.key = key;
  }
}
