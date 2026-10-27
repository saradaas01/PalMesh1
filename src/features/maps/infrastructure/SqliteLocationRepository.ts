import type { LocationFix, PeerId } from '../../dtn/domain/types';
import { isPeerId } from '../../dtn/domain/validation';
import type { SqliteRow, SynchronousSqliteDatabase } from '../../dtn/infrastructure/sqlite/SqliteDtnStore';
import { validLocationFix } from '../domain/locations';
import type { LocationRepository } from '../domain/ports';
import type { LocationArchive, LocationQuality, PeerLocation } from '../domain/types';

/** Own tables and identity binding coexist with routing/chat on the same SQLite
 * file. The host owns this connection; the repository never closes it. */
export class SqliteLocationRepository implements LocationRepository {
  readonly maxPeers: number;
  private identity: PeerId | null = null;

  constructor(private readonly database: SynchronousSqliteDatabase, options: { readonly maxPeers?: number } = {}) {
    this.maxPeers = options.maxPeers ?? 1_000;
    if (!Number.isSafeInteger(this.maxPeers) || this.maxPeers < 1 || this.maxPeers > 20_000) {
      throw new RangeError('Invalid location registry maxPeers');
    }
  }

  async initialize(localDeviceId: PeerId): Promise<void> {
    if (!isPeerId(localDeviceId)) throw new TypeError('Invalid location registry device identity');
    if (this.identity !== null) {
      if (this.identity !== localDeviceId) throw new Error('Location registry belongs to another device identity');
      return;
    }
    this.transaction(() => {
      this.database.execute(`CREATE TABLE IF NOT EXISTS palmesh_location_schema (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1), version INTEGER NOT NULL, local_device_id TEXT NOT NULL
      )`);
      const schema = this.database.execute('SELECT version, local_device_id FROM palmesh_location_schema WHERE singleton = 1').rows[0];
      if (schema !== undefined) {
        if (schema.version !== 1) throw new Error('Unsupported location registry schema version');
        if (schema.local_device_id !== localDeviceId) throw new Error('Location registry belongs to another device identity');
      } else {
        this.database.execute(`CREATE TABLE palmesh_local_location (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          latitude REAL NOT NULL, longitude REAL NOT NULL, fix_timestamp INTEGER NOT NULL
        )`);
        this.database.execute(`CREATE TABLE palmesh_peer_locations (
          device_id TEXT PRIMARY KEY, latitude REAL NOT NULL, longitude REAL NOT NULL,
          fix_timestamp INTEGER NOT NULL, received_at INTEGER NOT NULL,
          message_id TEXT NOT NULL, origin TEXT NOT NULL CHECK (origin IN ('location', 'sos'))
        )`);
        this.database.execute('CREATE INDEX palmesh_location_received ON palmesh_peer_locations (received_at, device_id)');
        this.database.execute('INSERT INTO palmesh_location_schema (singleton, version, local_device_id) VALUES (1, 1, ?)', [localDeviceId]);
      }
      this.database.execute('CREATE TABLE IF NOT EXISTS palmesh_local_quality (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), fix_timestamp INTEGER NOT NULL, quality_json TEXT NOT NULL)');
      this.prunePeers();
    });
    this.identity = localDeviceId;
  }

  async saveLocal(location: LocationFix, quality?: LocationQuality): Promise<void> {
    this.requireIdentity();
    if (!validLocationFix(location)) throw new TypeError('Invalid local location fix');
    if (quality && !validQuality(quality, location.timestamp)) throw new TypeError('Invalid local location quality');
    this.transaction(() => { const result = this.database.execute(`INSERT INTO palmesh_local_location (singleton, latitude, longitude, fix_timestamp)
      VALUES (1, ?, ?, ?) ON CONFLICT(singleton) DO UPDATE SET
        latitude = excluded.latitude, longitude = excluded.longitude, fix_timestamp = excluded.fix_timestamp
      WHERE excluded.fix_timestamp > palmesh_local_location.fix_timestamp`,
    [location.latitude, location.longitude, location.timestamp]);
    if (result.rowsAffected > 0) {
      this.database.execute('DELETE FROM palmesh_local_quality WHERE singleton = 1');
      if (quality) this.database.execute('INSERT INTO palmesh_local_quality VALUES (1, ?, ?)', [location.timestamp, JSON.stringify(quality)]);
    }
    });
  }

  async upsertPeers(peers: readonly PeerLocation[]): Promise<void> {
    const identity = this.requireIdentity();
    // Validate the whole batch before beginning writes. Snapshot values so the
    // returned registry cannot retain references owned by a native/event caller.
    const snapshots = peers.map(peer => snapshotPeer(peer)).filter(peer => peer.deviceId !== identity);
    this.transaction(() => {
      for (const peer of snapshots) this.database.execute(`INSERT INTO palmesh_peer_locations
        (device_id, latitude, longitude, fix_timestamp, received_at, message_id, origin)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(device_id) DO UPDATE SET
          latitude = excluded.latitude, longitude = excluded.longitude, fix_timestamp = excluded.fix_timestamp,
          received_at = excluded.received_at, message_id = excluded.message_id, origin = excluded.origin
        WHERE excluded.fix_timestamp > palmesh_peer_locations.fix_timestamp
          AND excluded.message_id <> palmesh_peer_locations.message_id`,
      [peer.deviceId, peer.location.latitude, peer.location.longitude, peer.location.timestamp,
        peer.receivedAt, peer.messageId, peer.origin]);
      // Ties are deterministic. Duplicate or older fixes do not refresh age and
      // therefore cannot pin stale entries by replaying packets at high volume.
      this.prunePeers();
    });
  }

  async read(): Promise<LocationArchive> {
    this.requireIdentity();
    const local = this.database.execute('SELECT latitude, longitude, fix_timestamp FROM palmesh_local_location WHERE singleton = 1').rows[0];
    const peers = this.database.execute('SELECT * FROM palmesh_peer_locations ORDER BY received_at DESC, device_id ASC').rows.map(row => {
      const peer = snapshotPeer({
        deviceId: text(row, 'device_id'), location: decodeFix(row), receivedAt: integer(row, 'received_at'),
        messageId: text(row, 'message_id'), origin: text(row, 'origin'),
      });
      if (peer.deviceId === this.identity) throw new Error('Location registry contains the local device as a peer');
      return peer;
    });
    const row = this.database.execute('SELECT * FROM palmesh_local_quality WHERE singleton = 1').rows[0];
    const quality: unknown = row ? JSON.parse(text(row, 'quality_json')) : undefined;
    const localQuality = local && validQuality(quality, Number(local.fix_timestamp)) ? Object.freeze(quality) : undefined;
    return Object.freeze({ localLocation: local ? decodeFix(local) : null, peers: Object.freeze(peers), ...(localQuality ? {localQuality} : {}) });
  }

  private prunePeers(): void {
    this.database.execute(`DELETE FROM palmesh_peer_locations WHERE device_id IN (
      SELECT device_id FROM palmesh_peer_locations ORDER BY received_at DESC, device_id ASC LIMIT -1 OFFSET ?
    )`, [this.maxPeers]);
  }

  private requireIdentity(): PeerId {
    if (this.identity === null) throw new Error('Initialize the location registry first');
    return this.identity;
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

function snapshotPeer(input: unknown): PeerLocation {
  if (input === null || typeof input !== 'object') throw new TypeError('Invalid peer location');
  const fields = Object.getOwnPropertyDescriptors(input);
  const required = ['deviceId', 'location', 'receivedAt', 'messageId', 'origin'];
  if (required.some(key => !fields[key]?.enumerable || !Object.hasOwn(fields[key]!, 'value'))) throw new TypeError('Invalid peer location fields');
  const deviceId: unknown = fields.deviceId!.value;
  const location: unknown = fields.location!.value;
  const receivedAt: unknown = fields.receivedAt!.value;
  const messageId: unknown = fields.messageId!.value;
  const origin: unknown = fields.origin!.value;
  if (!isPeerId(deviceId) || !validLocationFix(location) || !isTimestamp(receivedAt)
    || typeof messageId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/i.test(messageId)
    || (origin !== 'location' && origin !== 'sos')) throw new TypeError('Invalid peer location values');
  return Object.freeze({ deviceId, location: Object.freeze({ ...location }), receivedAt, messageId: messageId.toLowerCase(), origin });
}

function decodeFix(row: SqliteRow): LocationFix {
  const value = { latitude: row.latitude, longitude: row.longitude, timestamp: row.fix_timestamp };
  if (!validLocationFix(value)) throw new Error('Invalid location fix in the database');
  return Object.freeze(value);
}
function text(row: SqliteRow, column: string): string {
  if (typeof row[column] !== 'string') throw new Error(`Invalid location text column: ${column}`);
  return row[column];
}
function integer(row: SqliteRow, column: string): number {
  const value = row[column];
  if (!isTimestamp(value)) throw new Error(`Invalid location timestamp column: ${column}`);
  return value;
}
function isTimestamp(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }

function validQuality(value: unknown, timestamp: number): value is LocationQuality {
 if (!value || typeof value !== 'object') return false;
 const q=value as LocationQuality;return q.timestamp === timestamp && typeof q.approximate === 'boolean' && (q.accuracyMeters === undefined || typeof q.accuracyMeters === 'number' && Number.isFinite(q.accuracyMeters) && q.accuracyMeters >= 0);
}
