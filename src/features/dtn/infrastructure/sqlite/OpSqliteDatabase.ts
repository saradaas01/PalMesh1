import type { SqliteRow, SqliteValue, SynchronousSqliteDatabase } from './SqliteDtnStore';

/** Structural subset of @op-engineering/op-sqlite 18.2.5's Scalar / DB types.
 * Keeping the dependency in the host app allows the routing module to run in
 * Node tests and on platforms with another synchronous SQLite implementation.
 */
export type OpSqliteScalar = string | number | boolean | null | ArrayBuffer | ArrayBufferView;

export interface OpSqliteSyncConnection {
  executeSync(query: string, parameters?: OpSqliteScalar[]): {
    readonly rows: readonly Readonly<Record<string, OpSqliteScalar>>[];
    readonly rowsAffected: number;
  };
}

export interface OpSqliteDatabaseOptions {
  /** The host must dedicate this handle and file to this store: never use its
   * async operations, reactive transactions or another writer alongside it. */
  readonly exclusiveConnection: true;
  /** Test-only: in-memory databases cannot preserve ACKs across process death. */
  readonly allowInMemory?: boolean;
}

/** Native executeSync bridge with verified local commit durability settings.
 * Host usage: new SqliteDtnStore(new OpSqliteDatabase(open({name: 'dtn.sqlite'}),
 *   {exclusiveConnection: true})). The host retains responsibility for close().
 * SQLCipher encryption must be configured when the host opens its connection.
 */
export class OpSqliteDatabase implements SynchronousSqliteDatabase {
  public readonly journalMode: 'wal' | 'delete' | 'truncate' | 'persist' | 'memory';

  public constructor(private readonly connection: OpSqliteSyncConnection, options: OpSqliteDatabaseOptions) {
    if (options.exclusiveConnection !== true) {
      throw new Error('OpSqliteDatabase requires an exclusive database connection');
    }
    // WAL reduces reader/writer contention. A VFS that cannot enable WAL may
    // retain a durable rollback journal; OFF and unapproved MEMORY are rejected.
    const journal = this.execute('PRAGMA journal_mode = WAL').rows[0]?.journal_mode;
    if (journal === 'memory' && options.allowInMemory === true) {
      this.journalMode = journal;
    } else if (journal === 'wal' || journal === 'delete' || journal === 'truncate' || journal === 'persist') {
      this.journalMode = journal;
    } else {
      throw new Error(`A durable SQLite journal is required; received ${String(journal)}`);
    }
    this.execute('PRAGMA synchronous = FULL');
    if (this.execute('PRAGMA synchronous').rows[0]?.synchronous !== 2) {
      throw new Error('SQLite must support synchronous=FULL for durable hop acknowledgements');
    }
  }

  public execute(sql: string, parameters: readonly SqliteValue[] = []): { readonly rows: readonly SqliteRow[]; readonly rowsAffected: number } {
    // Native executeSync takes a mutable array. Copy parameters without string
    // interpolation, preserving the native parameter binding boundary.
    const result = this.connection.executeSync(sql, [...parameters]);
    if (!Number.isSafeInteger(result.rowsAffected) || result.rowsAffected < 0) {
      throw new Error('SQLite adapter returned an invalid rowsAffected value');
    }
    const rows = result.rows.map((row) => Object.fromEntries(
      Object.entries(row).map(([column, value]) => [column, normalizeScalar(value)]),
    ));
    return { rows, rowsAffected: result.rowsAffected };
  }
}

function normalizeScalar(value: OpSqliteScalar): SqliteValue {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return value;
}
