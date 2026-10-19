import type { DtnStore } from '../../domain/ports';
import type {
  AcceptResult, DeliveryCandidate, DeliveryFailure, MessageId, MeshMessage,
  PeerId, RoutingHistoryEntry, StorageLimits, StoredMessage,
} from '../../domain/types';

export type SqliteValue = string | number | null | Uint8Array;
export type SqliteRow = Readonly<Record<string, SqliteValue>>;

/** A native adapter must execute synchronously and preserve bound parameters.
 * Keep this connection exclusive to this store: transactions span execute calls.
 * Promise-based SQLite bridges need their own transaction-aware DtnStore adapter.
 */
export interface SynchronousSqliteDatabase {
  execute(sql: string, parameters?: readonly SqliteValue[]): {
    readonly rows: readonly SqliteRow[];
    readonly rowsAffected: number;
  };
}

const SCHEMA_VERSION = 2;
const MAX_TRACKED_PEERS = 4096;
const MAX_CONNECTED_PEERS = 64;

/** Durable, bounded store-and-forward storage. No React Native or Node imports:
 * the host supplies a synchronous native SQLite connection through this port.
 */
export class SqliteDtnStore implements DtnStore {
  private initialized = false;

  public constructor(private readonly database: SynchronousSqliteDatabase) {}

  public async initialize(): Promise<void> {
    if (this.initialized) return;
    this.transaction(() => {
      // A namespaced migration table leaves unrelated application schemas alone.
      this.database.execute(`CREATE TABLE IF NOT EXISTS palmesh_dtn_schema (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1), version INTEGER NOT NULL
      )`);
      const version = this.database.execute(
        'SELECT version FROM palmesh_dtn_schema WHERE singleton = 1',
      ).rows[0]?.version;
      if (version !== undefined && version !== 1 && version !== SCHEMA_VERSION) {
        throw new Error(`Unsupported PalMesh DTN schema version: ${String(version)}`);
      }
      if (version === undefined) {
        this.database.execute(`CREATE TABLE palmesh_dtn_messages (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          source TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('chat', 'sos', 'sos-response', 'location')),
          ttl INTEGER NOT NULL,
          packet TEXT NOT NULL,
          received_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          dedup_expires_at INTEGER NOT NULL,
          forwardable INTEGER NOT NULL CHECK (forwardable IN (0, 1)),
          peer_limit INTEGER NOT NULL CHECK (peer_limit BETWEEN 1 AND 4096)
        )`);
        this.database.execute(`CREATE TABLE palmesh_dtn_seen (
          message_id TEXT PRIMARY KEY NOT NULL,
          expires_at INTEGER NOT NULL,
          emergency INTEGER NOT NULL CHECK (emergency IN (0, 1))
        )`);
        this.database.execute(`CREATE TABLE palmesh_dtn_deliveries (
          message_id TEXT NOT NULL,
          peer_id TEXT NOT NULL,
          acknowledged INTEGER NOT NULL CHECK (acknowledged IN (0, 1)),
          attempts INTEGER NOT NULL CHECK (attempts >= 0),
          next_attempt_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (message_id, peer_id)
        )`);
        this.database.execute('CREATE INDEX palmesh_dtn_messages_expiry ON palmesh_dtn_messages (expires_at)');
        this.database.execute(`CREATE INDEX palmesh_dtn_messages_priority ON palmesh_dtn_messages
          ((CASE WHEN kind IN ('sos', 'sos-response') THEN 0 ELSE 1 END), received_at, sequence)`);
        this.database.execute('CREATE INDEX palmesh_dtn_messages_fifo ON palmesh_dtn_messages (received_at, sequence)');
        this.database.execute('CREATE INDEX palmesh_dtn_seen_expiry ON palmesh_dtn_seen (expires_at)');
        this.database.execute('CREATE INDEX palmesh_dtn_deliveries_retry ON palmesh_dtn_deliveries (peer_id, acknowledged, next_attempt_at)');
        this.database.execute('CREATE INDEX palmesh_dtn_deliveries_pending ON palmesh_dtn_deliveries (message_id, acknowledged, next_attempt_at)');
        this.database.execute('INSERT INTO palmesh_dtn_schema (singleton, version) VALUES (1, ?)', [SCHEMA_VERSION]);
      } else if (version === 1) {
        // Widen the packet-kind constraint without losing queue sequence, UUID
        // tombstones or durable hop receipts from installed version-one builds.
        this.database.execute('ALTER TABLE palmesh_dtn_messages RENAME TO palmesh_dtn_messages_v1');
        this.database.execute(`CREATE TABLE palmesh_dtn_messages (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, source TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('chat', 'sos', 'sos-response', 'location')),
          ttl INTEGER NOT NULL, packet TEXT NOT NULL, received_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL, dedup_expires_at INTEGER NOT NULL,
          forwardable INTEGER NOT NULL CHECK (forwardable IN (0, 1)),
          peer_limit INTEGER NOT NULL CHECK (peer_limit BETWEEN 1 AND 4096)
        )`);
        this.database.execute('INSERT INTO palmesh_dtn_messages SELECT * FROM palmesh_dtn_messages_v1');
        this.database.execute('DROP TABLE palmesh_dtn_messages_v1');
        this.database.execute('CREATE INDEX palmesh_dtn_messages_expiry ON palmesh_dtn_messages (expires_at)');
        this.database.execute(`CREATE INDEX palmesh_dtn_messages_priority ON palmesh_dtn_messages
          ((CASE WHEN kind IN ('sos', 'sos-response') THEN 0 ELSE 1 END), received_at, sequence)`);
        this.database.execute('CREATE INDEX palmesh_dtn_messages_fifo ON palmesh_dtn_messages (received_at, sequence)');
        this.database.execute('UPDATE palmesh_dtn_schema SET version = ? WHERE singleton = 1', [SCHEMA_VERSION]);
      }
    });
    this.initialized = true;
  }

  public async accept(record: StoredMessage, receivedFrom: PeerId | null, limits: StorageLimits, now: number): Promise<AcceptResult> {
    this.requireInitialized();
    validateLimits(limits);
    validTime(now, 'now');
    validTime(record.receivedAt, 'receivedAt');
    validTime(record.expiresAt, 'expiresAt');
    validTime(record.dedupExpiresAt, 'dedupExpiresAt');
    if (record.expiresAt <= now || record.dedupExpiresAt < record.expiresAt) {
      throw new RangeError('A stored packet must be unexpired and retained in deduplication until its expiry');
    }
    // Serialize before mutating storage. Returning a parsed copy prevents callers
    // from changing an accepted packet by retaining a reference to its payload.
    const packet = JSON.stringify(record.message);
    const snapshot = JSON.parse(packet) as MeshMessage;
    return this.transaction<AcceptResult>(() => {
      this.pruneRows(now);
      const seen = this.database.execute(
        'SELECT message_id FROM palmesh_dtn_seen WHERE message_id = ?', [snapshot.id],
      ).rows[0];
      if (seen) {
        if (receivedFrom !== null) this.writeReceipt(snapshot.id, receivedFrom, now, limits.maxPeersPerMessage);
        return { status: 'duplicate' };
      }

      const emergency = snapshot.kind === 'sos' || snapshot.kind === 'sos-response';
      const seenCount = this.count('SELECT COUNT(*) AS count FROM palmesh_dtn_seen');
      const seenCeiling = emergency ? limits.maxSeenIds : limits.maxSeenIds - limits.reservedEmergencySeenIds;
      // Live seen IDs are never evicted, even to make room for SOS traffic.
      if (seenCount >= seenCeiling) return { status: 'full', resource: 'dedup' };

      const messageCount = this.count('SELECT COUNT(*) AS count FROM palmesh_dtn_messages');
      const messageCeiling = emergency ? limits.maxMessages : limits.maxMessages - limits.reservedEmergencyMessages;
      if (messageCount >= messageCeiling) {
        if (!emergency) return { status: 'full', resource: 'messages' };
        const needed = messageCount - limits.maxMessages + 1;
        const evictions = this.database.execute(
          `SELECT id FROM palmesh_dtn_messages WHERE kind NOT IN ('sos', 'sos-response')
           ORDER BY received_at, sequence LIMIT ?`, [needed],
        ).rows;
        if (evictions.length < needed) return { status: 'full', resource: 'messages' };
        for (const row of evictions) this.deleteMessage(stringField(row, 'id'));
      }

      this.database.execute(
        `INSERT INTO palmesh_dtn_messages
         (id, source, kind, ttl, packet, received_at, expires_at, dedup_expires_at, forwardable, peer_limit)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [snapshot.id, snapshot.source, snapshot.kind, snapshot.ttl, packet, record.receivedAt,
          record.expiresAt, record.dedupExpiresAt, record.forwardable ? 1 : 0, limits.maxPeersPerMessage],
      );
      this.database.execute(
        'INSERT INTO palmesh_dtn_seen (message_id, expires_at, emergency) VALUES (?, ?, ?)',
        [snapshot.id, record.dedupExpiresAt, emergency ? 1 : 0],
      );
      if (receivedFrom !== null) this.writeReceipt(snapshot.id, receivedFrom, now, limits.maxPeersPerMessage);
      return { status: 'accepted', record: { ...record, message: snapshot } };
    });
  }

  public async getMessage(id: MessageId): Promise<StoredMessage | null> {
    this.requireInitialized();
    const row = this.database.execute('SELECT * FROM palmesh_dtn_messages WHERE id = ?', [id]).rows[0];
    return row ? decodeRecord(row) : null;
  }

  public async listHistory(limit: number): Promise<readonly StoredMessage[]> {
    this.requireInitialized();
    integerInRange(limit, 0, Number.MAX_SAFE_INTEGER, 'limit');
    return this.database.execute(
      'SELECT * FROM palmesh_dtn_messages ORDER BY received_at DESC, sequence DESC LIMIT ?', [limit],
    ).rows.map(decodeRecord);
  }

  public async listHistoryWithCustody(limit: number): Promise<readonly RoutingHistoryEntry[]> {
    this.requireInitialized();
    integerInRange(limit, 0, 1_000, 'limit');
    return this.database.execute(
      `SELECT m.packet, m.received_at, m.expires_at,
        EXISTS (SELECT 1 FROM palmesh_dtn_deliveries d
          WHERE d.message_id = m.id AND d.acknowledged = 1 AND d.peer_id <> m.source) AS peer_stored
       FROM palmesh_dtn_messages m ORDER BY m.received_at DESC, m.sequence DESC LIMIT ?`, [limit],
    ).rows.map(row => Object.freeze({
      message: JSON.parse(stringField(row, 'packet')) as MeshMessage,
      receivedAt: numberField(row, 'received_at'), expiresAt: numberField(row, 'expires_at'),
      peerStored: numberField(row, 'peer_stored') === 1,
    })).reverse();
  }

  public async getNextDelivery(peers: readonly PeerId[], now: number, emergencyOnly: boolean, maxPeersPerMessage: number): Promise<DeliveryCandidate | null> {
    this.requireInitialized();
    validTime(now, 'now');
    integerInRange(maxPeersPerMessage, 1, MAX_TRACKED_PEERS, 'maxPeersPerMessage');
    const uniquePeers = [...new Set(peers)];
    if (uniquePeers.length > MAX_CONNECTED_PEERS) throw new RangeError('At most 64 connected peers can be scheduled');
    if (uniquePeers.length === 0) return null;
    const peerParameters: SqliteValue[] = [];
    uniquePeers.forEach((peer, index) => peerParameters.push(peer, index));
    // Peer placeholders are SQL syntax only; all peer values remain bound.
    const placeholders = uniquePeers.map(() => '(?, ?)').join(', ');
    // Split due work from future retries. Combining both in one CASE-sorted
    // query materializes every message × peer pair before LIMIT, blocking the
    // native JS thread at high density. This index scan stops at the first
    // deliverable message in SOS/FIFO order instead.
    let row = this.database.execute(
      `WITH connected(peer_id, peer_order) AS (VALUES ${placeholders})
       SELECT m.*, p.peer_id AS delivery_peer, COALESCE(d.attempts, 0) AS delivery_attempts,
              COALESCE(d.next_attempt_at, 0) AS delivery_next_at
       FROM palmesh_dtn_messages m INDEXED BY palmesh_dtn_messages_priority CROSS JOIN connected p
       LEFT JOIN palmesh_dtn_deliveries d ON d.message_id = m.id AND d.peer_id = p.peer_id
       WHERE m.forwardable = 1 AND m.ttl > 0 AND m.expires_at > ?
         AND m.source <> p.peer_id AND (? = 0 OR m.kind IN ('sos', 'sos-response'))
         AND ((SELECT COUNT(*) FROM palmesh_dtn_deliveries ledger WHERE ledger.message_id = m.id) < MIN(m.peer_limit, ?)
           OR EXISTS (SELECT 1 FROM palmesh_dtn_deliveries pending INDEXED BY palmesh_dtn_deliveries_pending
             JOIN connected available ON available.peer_id = pending.peer_id
             WHERE pending.message_id = m.id AND pending.acknowledged = 0
               AND pending.next_attempt_at <= ? AND available.peer_id <> m.source))
         AND COALESCE(d.acknowledged, 0) = 0
         AND COALESCE(d.next_attempt_at, 0) <= ?
         AND (d.peer_id IS NOT NULL OR
           (SELECT COUNT(*) FROM palmesh_dtn_deliveries ledger WHERE ledger.message_id = m.id) < MIN(m.peer_limit, ?))
       ORDER BY (CASE WHEN m.kind IN ('sos', 'sos-response') THEN 0 ELSE 1 END),
         m.received_at, m.sequence, p.peer_order LIMIT 1`,
      [...peerParameters, now, emergencyOnly ? 1 : 0, maxPeersPerMessage, now, now, maxPeersPerMessage],
    ).rows[0];
    if (!row) {
      // A future candidate necessarily has an existing failed-delivery row:
      // untracked peers are immediately due. Find the earliest valid deadline
      // for each connected peer, then choose FIFO within that deadline. This
      // avoids both scanning retries for disconnected peers and sorting all
      // messages per peer when many retries have an identical deadline.
      const earliest = this.database.execute(
        `WITH connected(peer_id, peer_order) AS (VALUES ${placeholders})
         SELECT MIN((SELECT d.next_attempt_at FROM palmesh_dtn_deliveries d INDEXED BY palmesh_dtn_deliveries_retry
           JOIN palmesh_dtn_messages m ON m.id = d.message_id
           WHERE d.peer_id = p.peer_id AND d.acknowledged = 0 AND d.next_attempt_at > ?
             AND m.forwardable = 1 AND m.ttl > 0 AND m.expires_at > ?
             AND m.source <> p.peer_id AND (? = 0 OR m.kind IN ('sos', 'sos-response'))
           ORDER BY d.next_attempt_at LIMIT 1)) AS next_time FROM connected p`,
        [...peerParameters, now, now, emergencyOnly ? 1 : 0],
      ).rows[0];
      if (earliest && earliest.next_time !== null) {
        row = this.database.execute(
          `WITH connected(peer_id, peer_order) AS (VALUES ${placeholders})
           SELECT m.*, p.peer_id AS delivery_peer, d.attempts AS delivery_attempts,
                  d.next_attempt_at AS delivery_next_at
           FROM palmesh_dtn_messages m INDEXED BY palmesh_dtn_messages_fifo CROSS JOIN connected p
           JOIN palmesh_dtn_deliveries d ON d.message_id = m.id AND d.peer_id = p.peer_id
           WHERE m.forwardable = 1 AND m.ttl > 0 AND m.expires_at > ?
             AND m.source <> p.peer_id AND (? = 0 OR m.kind IN ('sos', 'sos-response'))
             AND d.acknowledged = 0 AND d.next_attempt_at = ?
           ORDER BY m.received_at, m.sequence, p.peer_order LIMIT 1`,
          [...peerParameters, now, emergencyOnly ? 1 : 0, numberField(earliest, 'next_time')],
        ).rows[0];
      }
    }
    if (!row) return null;
    return {
      record: decodeRecord(row), peerId: stringField(row, 'delivery_peer'),
      attempts: numberField(row, 'delivery_attempts'), nextAttemptAt: numberField(row, 'delivery_next_at'),
    };
  }

  public async markAcknowledged(messageId: MessageId, peerId: PeerId, now: number): Promise<void> {
    this.requireInitialized();
    validTime(now, 'now');
    this.transaction(() => this.writeReceipt(messageId, peerId, now));
  }

  public async markFailed(failure: DeliveryFailure): Promise<void> {
    this.requireInitialized();
    validTime(failure.now, 'now');
    validTime(failure.nextAttemptAt, 'nextAttemptAt');
    integerInRange(failure.attempts, 1, Number.MAX_SAFE_INTEGER, 'attempts');
    this.transaction(() => {
      const row = this.database.execute(
        `SELECT m.peer_limit, m.expires_at, d.acknowledged,
          (SELECT COUNT(*) FROM palmesh_dtn_deliveries WHERE message_id = m.id) AS ledger_count
         FROM palmesh_dtn_messages m LEFT JOIN palmesh_dtn_deliveries d
           ON d.message_id = m.id AND d.peer_id = ? WHERE m.id = ?`,
        [failure.peerId, failure.messageId],
      ).rows[0];
      if (!row || numberField(row, 'expires_at') <= failure.now || row.acknowledged === 1) return;
      if (row.acknowledged === null && numberField(row, 'ledger_count') >= numberField(row, 'peer_limit')) return;
      // A late failure must never erase an ACK that arrived during send().
      this.database.execute(
        `INSERT INTO palmesh_dtn_deliveries
         (message_id, peer_id, acknowledged, attempts, next_attempt_at, updated_at)
         VALUES (?, ?, 0, ?, ?, ?)
         ON CONFLICT(message_id, peer_id) DO UPDATE SET
           attempts = MAX(attempts, excluded.attempts),
           next_attempt_at = excluded.next_attempt_at, updated_at = excluded.updated_at
         WHERE acknowledged = 0`,
        [failure.messageId, failure.peerId, failure.attempts, failure.nextAttemptAt, failure.now],
      );
    });
  }

  public async prune(now: number): Promise<void> {
    this.requireInitialized();
    validTime(now, 'now');
    this.transaction(() => this.pruneRows(now));
  }

  private writeReceipt(messageId: MessageId, peerId: PeerId, now: number, requestedLimit = MAX_TRACKED_PEERS): void {
    this.database.execute(
      `INSERT INTO palmesh_dtn_deliveries
       (message_id, peer_id, acknowledged, attempts, next_attempt_at, updated_at)
       SELECT id, ?, 1, 0, 0, ? FROM palmesh_dtn_messages m
       WHERE id = ? AND expires_at > ? AND (
         EXISTS (SELECT 1 FROM palmesh_dtn_deliveries WHERE message_id = m.id AND peer_id = ?)
         OR (SELECT COUNT(*) FROM palmesh_dtn_deliveries WHERE message_id = m.id) < MIN(peer_limit, ?))
       ON CONFLICT(message_id, peer_id) DO UPDATE SET acknowledged = 1, updated_at = excluded.updated_at`,
      [peerId, now, messageId, now, peerId, requestedLimit],
    );
  }

  private pruneRows(now: number): void {
    // Explicit cleanup keeps correctness independent of the host connection's
    // foreign_keys pragma, which may be shared with other application storage.
    this.database.execute(
      `DELETE FROM palmesh_dtn_deliveries WHERE message_id IN
       (SELECT id FROM palmesh_dtn_messages WHERE expires_at <= ?)`, [now],
    );
    this.database.execute('DELETE FROM palmesh_dtn_messages WHERE expires_at <= ?', [now]);
    this.database.execute(
      `DELETE FROM palmesh_dtn_seen WHERE expires_at <= ? AND NOT EXISTS
       (SELECT 1 FROM palmesh_dtn_messages WHERE id = message_id)`, [now],
    );
  }

  private deleteMessage(id: MessageId): void {
    this.database.execute('DELETE FROM palmesh_dtn_deliveries WHERE message_id = ?', [id]);
    this.database.execute('DELETE FROM palmesh_dtn_messages WHERE id = ?', [id]);
  }

  private count(sql: string): number {
    const row = this.database.execute(sql).rows[0];
    if (!row) throw new Error('SQLite did not return a count');
    return numberField(row, 'count');
  }

  private transaction<T>(operation: () => T): T {
    this.database.execute('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.database.execute('COMMIT');
      return result;
    } catch (error) {
      try { this.database.execute('ROLLBACK'); } catch { /* Keep the original failure. */ }
      throw error;
    }
  }

  private requireInitialized(): void {
    if (!this.initialized) throw new Error('Call SqliteDtnStore.initialize() before accessing storage');
  }
}

function decodeRecord(row: SqliteRow): StoredMessage {
  return {
    message: JSON.parse(stringField(row, 'packet')) as MeshMessage,
    receivedAt: numberField(row, 'received_at'), expiresAt: numberField(row, 'expires_at'),
    dedupExpiresAt: numberField(row, 'dedup_expires_at'), forwardable: numberField(row, 'forwardable') === 1,
  };
}

function stringField(row: SqliteRow, field: string): string {
  const value = row[field];
  if (typeof value !== 'string') throw new Error(`Invalid SQLite string column: ${field}`);
  return value;
}

function numberField(row: SqliteRow, field: string): number {
  const value = row[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`Invalid SQLite integer column: ${field}`);
  return value;
}

function integerInRange(value: number, min: number, max: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer between ${min} and ${max}`);
  }
}

function validTime(value: number, name: string): void {
  integerInRange(value, 0, Number.MAX_SAFE_INTEGER, name);
}

function validateLimits(limits: StorageLimits): void {
  integerInRange(limits.maxMessages, 1, Number.MAX_SAFE_INTEGER, 'maxMessages');
  integerInRange(limits.maxSeenIds, 1, Number.MAX_SAFE_INTEGER, 'maxSeenIds');
  integerInRange(limits.reservedEmergencyMessages, 0, limits.maxMessages, 'reservedEmergencyMessages');
  integerInRange(limits.reservedEmergencySeenIds, 0, limits.maxSeenIds, 'reservedEmergencySeenIds');
  integerInRange(limits.maxPeersPerMessage, 1, MAX_TRACKED_PEERS, 'maxPeersPerMessage');
}
