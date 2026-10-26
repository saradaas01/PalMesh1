import type { SecurityVault } from '../../features/security';
import type { OpSqliteSyncConnection } from '../../features/dtn';
import { BootstrapError } from '../domain/BootstrapError';

const STORAGE_KEY = 'database-key-v1';
const HEX_KEY = /^[0-9a-f]{64}$(?![\s\S])/;

export interface EncryptedConnection extends OpSqliteSyncConnection { close(): void }
export interface EncryptedOpenOptions { readonly name: string; readonly encryptionKey: string }
export interface EncryptedStorageInitialization {
  /** Runs after reading the existing key and before creating a new one. The
   * native host provisions/validates its identity here so a failed first write
   * cannot leave a database key that falsely implies an established identity. */
  readonly beforeProvision?: (existingKey: boolean) => Promise<void>;
}

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

  initialize(options: EncryptedStorageInitialization = {}): Promise<void> {
    this.initialization ??= this.loadKey(options);
    return this.initialization;
  }

  connect(name: string): Connection {
    if (!this.key) throw new BootstrapError('secure-storage-unavailable');
    this.requireCipher();
    if (typeof name !== 'string' || name.length > 128 || !/^palmesh-[a-z-]+\.sqlite$(?![\s\S])/.test(name)) {
      throw new Error('Invalid private database name.');
    }
    let connection: Connection;
    try { connection = this.open({ name, encryptionKey: this.key }); }
    catch { throw new BootstrapError('secure-storage-unavailable'); }
    try {
      const version = connection.executeSync('PRAGMA cipher_version').rows[0]?.cipher_version;
      if (typeof version !== 'string' || !/^\d+\.\d+\./.test(version)) {
        throw new BootstrapError('encryption-unavailable');
      }
      // SQLCipher must authenticate/decrypt an existing schema before a store
      // can run migrations. No attempt is made to retry without encryption.
      connection.executeSync('PRAGMA cipher_memory_security = ON');
      connection.executeSync('SELECT count(*) FROM sqlite_master');
      const memoryProtection = connection.executeSync('PRAGMA cipher_memory_security').rows[0]?.cipher_memory_security;
      if (memoryProtection !== 1 && memoryProtection !== '1') {
        throw new BootstrapError('encryption-unavailable');
      }
      connection.executeSync('PRAGMA secure_delete = ON');
      return connection;
    } catch (error) {
      // A cleanup exception must not replace the actionable, sanitized failure.
      try { connection.close(); } catch { /* The native host will preserve the files. */ }
      if (error instanceof BootstrapError) throw error;
      throw new BootstrapError('data-recovery-required');
    }
  }

  private requireCipher(): void {
    try { if (this.isSqlCipher()) return; } catch { /* An unavailable backend is not a plaintext fallback. */ }
    throw new BootstrapError('encryption-unavailable');
  }

  private async loadKey(options: EncryptedStorageInitialization): Promise<void> {
    this.requireCipher();
    let stored: string | null;
    try { stored = await this.vault.read(STORAGE_KEY); }
    catch { throw new BootstrapError('secure-storage-unavailable'); }
    if (stored !== null) {
      if (typeof stored !== 'string' || !HEX_KEY.test(stored)) throw new BootstrapError('data-recovery-required');
      await options.beforeProvision?.(true);
      this.key = stored;
      this.existingKey = true;
      return;
    }
    // The identity must be durable before a new database key is committed.
    // A later retry can reuse that identity after either provisioning step fails.
    await options.beforeProvision?.(false);
    let bytes: Uint8Array;
    try { bytes = await this.vault.randomBytes(32); }
    catch { throw new BootstrapError('secure-storage-unavailable'); }
    if (!(bytes instanceof Uint8Array) || bytes.length !== 32) {
      if (bytes instanceof Uint8Array) bytes.fill(0);
      throw new BootstrapError('secure-storage-unavailable');
    }
    const key = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
    bytes.fill(0);
    try { await this.vault.write(STORAGE_KEY, key); }
    catch { throw new BootstrapError('provisioning-incomplete'); }
    this.key = key;
  }
}
