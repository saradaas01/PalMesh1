import type { PeerId } from '../../dtn/domain/types';
import { isPeerId } from '../../dtn/domain/validation';
import type { SqliteRow, SynchronousSqliteDatabase } from '../../dtn/infrastructure/sqlite/SqliteDtnStore';
import type { PeerRegistry } from '../domain/ports';
import type { PeerRecord, RadioKind } from '../domain/types';

const SCHEMA_VERSION = 1;
const MAX_ENTRIES = 4096;

export interface SqlitePeerRegistryOptions {
  readonly maxEntries?: number;
}

/** Persists stable peer identity and observed radio capabilities only. Opaque
 * radio endpoints, handshakes, sessions, and locations stay out of this table.
 * Supply a dedicated synchronous SQLite handle: transactions span execute()
 * calls, so a connection must not be shared with another transaction owner.
 */
export class SqlitePeerRegistry implements PeerRegistry {
  private initialized = false;
  private readonly maxEntries: number;

  public constructor(
    private readonly database: SynchronousSqliteDatabase,
    options: SqlitePeerRegistryOptions = {},
  ) {
    this.maxEntries = options.maxEntries ?? 256;
    integerInRange(this.maxEntries, 1, MAX_ENTRIES, 'maxEntries');
  }

  public async initialize(): Promise<void> {
    if (this.initialized) return;
    this.transaction(() => {
      this.database.execute(`CREATE TABLE IF NOT EXISTS palmesh_peers_schema (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1), version INTEGER NOT NULL
      )`);
      const version = this.database.execute(
        'SELECT version FROM palmesh_peers_schema WHERE singleton = 1',
      ).rows[0]?.version;
      if (version !== undefined && version !== SCHEMA_VERSION) {
        throw new Error(`Unsupported PalMesh peer schema version: ${String(version)}`);
      }
      if (version === undefined) {
        this.database.execute(`CREATE TABLE palmesh_peers (
          peer_id TEXT PRIMARY KEY NOT NULL,
          last_seen_at INTEGER NOT NULL CHECK (last_seen_at >= 0),
          wifi_direct INTEGER NOT NULL CHECK (wifi_direct IN (0, 1)),
          ble INTEGER NOT NULL CHECK (ble IN (0, 1)),
          CHECK (wifi_direct + ble >= 1)
        )`);
        this.database.execute('CREATE INDEX palmesh_peers_last_seen ON palmesh_peers (last_seen_at, peer_id)');
        this.database.execute('INSERT INTO palmesh_peers_schema (singleton, version) VALUES (1, ?)', [SCHEMA_VERSION]);
      }
      // A reopened registry may intentionally lower its capacity. Apply the
      // bound before any record becomes visible through this instance.
      this.trimToCapacity();
    });
    this.initialized = true;
  }

  public async recordSeen(peerId: PeerId, radio: RadioKind, now: number): Promise<void> {
    this.requireInitialized();
    if (!isPeerId(peerId)) throw new TypeError('peerId must be a valid stable peer ID');
    if (radio !== 'wifi-direct' && radio !== 'ble') throw new TypeError('radio must be wifi-direct or ble');
    validTime(now, 'now');
    this.transaction(() => {
      // Delayed native callbacks and wall-clock corrections must not regress
      // lastSeenAt. Capabilities accumulate across both transport paths.
      this.database.execute(
        `INSERT INTO palmesh_peers (peer_id, last_seen_at, wifi_direct, ble)
         VALUES (?, ?, ?, ?) ON CONFLICT(peer_id) DO UPDATE SET
           last_seen_at = MAX(last_seen_at, excluded.last_seen_at),
           wifi_direct = MAX(wifi_direct, excluded.wifi_direct),
           ble = MAX(ble, excluded.ble)`,
        [peerId, now, radio === 'wifi-direct' ? 1 : 0, radio === 'ble' ? 1 : 0],
      );
      this.trimToCapacity();
    });
  }

  public async recentPeers(limit: number): Promise<readonly PeerRecord[]> {
    this.requireInitialized();
    integerInRange(limit, 0, MAX_ENTRIES, 'limit');
    return this.database.execute(
      'SELECT peer_id, last_seen_at, wifi_direct, ble FROM palmesh_peers ORDER BY last_seen_at DESC, peer_id DESC LIMIT ?',
      [limit],
    ).rows.map(decodePeer);
  }

  public async prune(before: number): Promise<void> {
    this.requireInitialized();
    validTime(before, 'before');
    this.transaction(() => {
      this.database.execute('DELETE FROM palmesh_peers WHERE last_seen_at < ?', [before]);
    });
  }

  private trimToCapacity(): void {
    // Retain the most recently observed identities, with a deterministic ID
    // tie-breaker. Repeated observations of one identity never consume slots.
    this.database.execute(
      `DELETE FROM palmesh_peers WHERE peer_id IN (
         SELECT peer_id FROM palmesh_peers ORDER BY last_seen_at DESC, peer_id DESC LIMIT -1 OFFSET ?
       )`, [this.maxEntries],
    );
  }

  private transaction<T>(operation: () => T): T {
    this.database.execute('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.database.execute('COMMIT');
      return result;
    } catch (error) {
      try { this.database.execute('ROLLBACK'); } catch { /* Preserve the original storage failure. */ }
      throw error;
    }
  }

  private requireInitialized(): void {
    if (!this.initialized) throw new Error('Call SqlitePeerRegistry.initialize() before accessing storage');
  }
}

function decodePeer(row: SqliteRow): PeerRecord {
  const peerId = row.peer_id;
  const lastSeenAt = row.last_seen_at;
  const wifiDirect = row.wifi_direct;
  const ble = row.ble;
  if (!isPeerId(peerId) || typeof lastSeenAt !== 'number' || !Number.isSafeInteger(lastSeenAt) || lastSeenAt < 0 ||
    (wifiDirect !== 0 && wifiDirect !== 1) || (ble !== 0 && ble !== 1) || (wifiDirect === 0 && ble === 0)) {
    throw new Error('Invalid SQLite peer record');
  }
  const radios: RadioKind[] = [];
  if (wifiDirect === 1) radios.push('wifi-direct');
  if (ble === 1) radios.push('ble');
  return { peerId, lastSeenAt, radios };
}

function integerInRange(value: number, minimum: number, maximum: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
}

function validTime(value: number, name: string): void {
  integerInRange(value, 0, Number.MAX_SAFE_INTEGER, name);
}
