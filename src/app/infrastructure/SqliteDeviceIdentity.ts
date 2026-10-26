import type { IdGenerator, PeerId, SynchronousSqliteDatabase } from '../../features/dtn';

const SCHEMA_VERSION = 1;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A local installation identity, not a cryptographic identity or peer proof.
 * Keep this file on its own durable connection and exclude it from cloud/device
 * backup: restoring a copy on a second phone would duplicate the mesh identity.
 */
export class SqliteDeviceIdentity {
  private initialized = false;

  constructor(private readonly database: SynchronousSqliteDatabase) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.transaction(() => {
      this.database.execute(`CREATE TABLE IF NOT EXISTS palmesh_identity_schema (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1), version INTEGER NOT NULL
      )`);
      const version = this.database.execute(
        'SELECT version FROM palmesh_identity_schema WHERE singleton = 1',
      ).rows[0]?.version;
      if (version !== undefined && version !== SCHEMA_VERSION) {
        throw new Error(`Unsupported PalMesh identity schema version: ${String(version)}`);
      }
      if (version === undefined) {
        this.database.execute(`CREATE TABLE palmesh_device_identity (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1), device_id TEXT NOT NULL
        )`);
        this.database.execute('INSERT INTO palmesh_identity_schema (singleton, version) VALUES (1, ?)', [SCHEMA_VERSION]);
      }
    });
    this.initialized = true;
  }

  /** Generate only inside the first-write transaction. Never replace a corrupt
   * stored ID: rotating it silently would orphan local archives and receipts.
   * The native composition root supplies secure UUID v4; entropy failure is fatal.
   */
  async getOrCreate(ids: IdGenerator): Promise<PeerId> {
    if (!this.initialized) throw new Error('Initialize device identity before reading it');
    return this.transaction(() => {
      const stored = this.database.execute(
        'SELECT device_id FROM palmesh_device_identity WHERE singleton = 1',
      ).rows[0]?.device_id;
      if (stored !== undefined) {
        if (!validUuidV4(stored)) throw new Error('Stored device identity is not a UUID v4');
        return stored;
      }
      const generated = ids.next();
      if (!validUuidV4(generated)) throw new Error('Secure identity generator must return a UUID v4');
      this.database.execute('INSERT INTO palmesh_device_identity (singleton, device_id) VALUES (1, ?)', [generated]);
      return generated;
    });
  }

  private transaction<T>(operation: () => T): T {
    this.database.execute('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.database.execute('COMMIT');
      return result;
    } catch (error) {
      try { this.database.execute('ROLLBACK'); } catch { /* Preserve the original failure. */ }
      throw error;
    }
  }
}

function validUuidV4(value: unknown): value is string {
  // JavaScript's $ also matches before a terminal newline; UUIDs are exactly 36
  // ASCII characters, so an explicit length check rejects that malformed case.
  return typeof value === 'string' && value.length === 36 && UUID_V4.test(value);
}
