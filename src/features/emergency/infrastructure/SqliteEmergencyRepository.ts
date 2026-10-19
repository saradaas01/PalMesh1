import type { PeerId, RoutingHistoryEntry } from '../../dtn/domain/types';
import { isPeerId, parseMessage } from '../../dtn/domain/validation';
import type { SqliteRow, SynchronousSqliteDatabase } from '../../dtn/infrastructure/sqlite/SqliteDtnStore';
import type { EmergencyRepository } from '../domain/ports';
import type { EmergencyEntry, EmergencyResponse } from '../domain/types';

/** Independently bounded archive; expiration ends forwarding/response eligibility,
 * but does not erase a human's SOS or claim that it was resolved. */
export class SqliteEmergencyRepository implements EmergencyRepository {
  private identity: PeerId | null = null;
  readonly maxEntries: number;
  readonly maxResponsesPerSos: number;
  constructor(private readonly database: SynchronousSqliteDatabase, options: {
    readonly maxEntries?: number; readonly maxResponsesPerSos?: number;
  } = {}) {
    this.maxEntries = options.maxEntries ?? 200;
    this.maxResponsesPerSos = options.maxResponsesPerSos ?? 32;
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries < 1 || this.maxEntries > 2_000
      || !Number.isSafeInteger(this.maxResponsesPerSos) || this.maxResponsesPerSos < 1 || this.maxResponsesPerSos > 128) {
      throw new RangeError('Invalid emergency archive bounds');
    }
  }
  async initialize(localDeviceId: PeerId): Promise<void> {
    if (!isPeerId(localDeviceId)) throw new TypeError('Invalid emergency device identity');
    if (this.identity !== null) {
      if (this.identity !== localDeviceId) throw new Error('Emergency archive belongs to another device identity');
      return;
    }
    this.transaction(() => {
      this.database.execute(`CREATE TABLE IF NOT EXISTS palmesh_emergency_schema (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1), version INTEGER NOT NULL, local_device_id TEXT NOT NULL
      )`);
      const schema = this.database.execute('SELECT * FROM palmesh_emergency_schema WHERE singleton = 1').rows[0];
      if (schema) {
        if (schema.version !== 1) throw new Error('Unsupported emergency archive version');
        if (schema.local_device_id !== localDeviceId) throw new Error('Emergency archive belongs to another device identity');
      } else {
        this.database.execute(`CREATE TABLE palmesh_emergency_sos (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, source TEXT NOT NULL,
          text TEXT NOT NULL, created_at INTEGER NOT NULL, received_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
          outgoing INTEGER NOT NULL CHECK (outgoing IN (0, 1)), dismissed INTEGER NOT NULL DEFAULT 0,
          notification_claimed INTEGER NOT NULL DEFAULT 0, location_json TEXT
        )`);
        this.database.execute(`CREATE TABLE palmesh_emergency_responses (
          sos_id TEXT NOT NULL, responder TEXT NOT NULL, message_id TEXT NOT NULL UNIQUE, received_at INTEGER NOT NULL,
          PRIMARY KEY (sos_id, responder)
        )`);
        this.database.execute('CREATE INDEX palmesh_emergency_receipt ON palmesh_emergency_sos (received_at, sequence)');
        this.database.execute('INSERT INTO palmesh_emergency_schema VALUES (1, 1, ?)', [localDeviceId]);
      }
    });
    this.identity = localDeviceId;
  }
  async ingest(entries: readonly RoutingHistoryEntry[]): Promise<void> {
    const localId = this.requireIdentity();
    // Validate immutable copies before SQL writes. Malformed archive/native input
    // cannot smuggle another recipient's response into this user's emergency.
    const valid = entries.flatMap(entry => {
      try {
        if (!Number.isSafeInteger(entry.receivedAt) || entry.receivedAt < 0
          || !Number.isSafeInteger(entry.expiresAt) || entry.expiresAt < entry.receivedAt) return [];
        const parsed = parseMessage(entry.message);
        return parsed.ok ? [{ message: parsed.message, receivedAt: entry.receivedAt, expiresAt: entry.expiresAt }] : [];
      } catch { return []; }
    });
    this.transaction(() => {
      // Originals precede responses even if history was returned newest first.
      for (const entry of valid) {
        const { message } = entry;
        if (message.kind !== 'sos' || (message.destination !== '*' && message.destination !== localId && message.source !== localId)) continue;
        this.database.execute(`INSERT INTO palmesh_emergency_sos
          (id, source, text, created_at, received_at, expires_at, outgoing, location_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
        [message.id, message.source, message.payload.text, message.createdAt, entry.receivedAt, entry.expiresAt,
          message.source === localId ? 1 : 0, message.payload.location ? JSON.stringify(message.payload.location) : null]);
      }
      for (const entry of valid) {
        const { message } = entry;
        if (message.kind !== 'sos-response') continue;
        const sos = this.database.execute('SELECT source, outgoing FROM palmesh_emergency_sos WHERE id = ?', [message.payload.sosId]).rows[0];
        if (!sos || message.source === sos.source || message.destination !== sos.source
          || (message.destination !== localId && message.source !== localId)) continue;
        const count = this.database.execute('SELECT COUNT(*) AS count FROM palmesh_emergency_responses WHERE sos_id = ?', [message.payload.sosId]).rows[0]?.count;
        if (typeof count !== 'number' || count >= this.maxResponsesPerSos) continue;
        this.database.execute(`INSERT INTO palmesh_emergency_responses (sos_id, responder, message_id, received_at)
          VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`, [message.payload.sosId, message.source, message.id, entry.receivedAt]);
      }
      this.database.execute(`DELETE FROM palmesh_emergency_sos WHERE id IN (
        SELECT id FROM palmesh_emergency_sos ORDER BY received_at DESC, sequence DESC LIMIT -1 OFFSET ?
      )`, [this.maxEntries]);
      this.database.execute('DELETE FROM palmesh_emergency_responses WHERE sos_id NOT IN (SELECT id FROM palmesh_emergency_sos)');
    });
  }
  async read(): Promise<readonly EmergencyEntry[]> {
    const identity = this.requireIdentity();
    const rows = this.database.execute('SELECT * FROM palmesh_emergency_sos ORDER BY received_at DESC, sequence DESC').rows;
    const responses = this.database.execute('SELECT * FROM palmesh_emergency_responses ORDER BY received_at, message_id').rows;
    return Object.freeze(rows.map(row => {
      const id = text(row, 'id');
      const linked = responses.filter(response => response.sos_id === id);
      const ownResponse = linked.find(response => response.responder === identity);
      const location: unknown = row.location_json === null ? undefined : JSON.parse(text(row, 'location_json'));
      // Reuse the packet parser to reject corrupt text, identifiers and coordinates.
      const parsed = parseMessage({ version: 1, id, source: text(row, 'source'), destination: '*',
        createdAt: integer(row, 'created_at'), ttl: 15, kind: 'sos', payload: {
          text: text(row, 'text'), ...(location === undefined ? {} : { location }),
        } });
      if (!parsed.ok || parsed.message.kind !== 'sos') throw new Error('Invalid emergency archive packet');
      const entry: EmergencyEntry = {
        id, source: parsed.message.source, text: parsed.message.payload.text,
        createdAt: parsed.message.createdAt, receivedAt: integer(row, 'received_at'), expiresAt: integer(row, 'expires_at'),
        outgoing: integer(row, 'outgoing') === 1, dismissed: integer(row, 'dismissed') === 1,
        responseId: ownResponse ? text(ownResponse, 'message_id') : null,
        responses: Object.freeze(linked.filter(response => response.responder !== identity).map(response => Object.freeze({
          id: text(response, 'message_id'), responder: text(response, 'responder'),
          receivedAt: integer(response, 'received_at'), status: 'responding',
        } satisfies EmergencyResponse))),
        ...(parsed.message.payload.location ? { location: parsed.message.payload.location } : {}),
      };
      return Object.freeze(entry);
    }));
  }
  async dismiss(sosId: string): Promise<void> {
    this.requireIdentity();
    this.database.execute('UPDATE palmesh_emergency_sos SET dismissed = 1 WHERE id = ?', [sosId]);
  }
  async claimNotification(sosId: string): Promise<boolean> {
    this.requireIdentity();
    return this.database.execute(`UPDATE palmesh_emergency_sos SET notification_claimed = 1
      WHERE id = ? AND outgoing = 0 AND dismissed = 0 AND notification_claimed = 0`, [sosId]).rowsAffected === 1;
  }
  private requireIdentity(): PeerId {
    if (this.identity === null) throw new Error('Initialize the emergency archive first');
    return this.identity;
  }
  private transaction<T>(operation: () => T): T {
    this.database.execute('BEGIN IMMEDIATE');
    try { const result = operation(); this.database.execute('COMMIT'); return result; }
    catch (error) { try { this.database.execute('ROLLBACK'); } catch { /* Preserve failure. */ } throw error; }
  }
}
function text(row: SqliteRow, key: string): string {
  if (typeof row[key] !== 'string') throw new Error(`Invalid emergency text: ${key}`);
  return row[key];
}
function integer(row: SqliteRow, key: string): number {
  const value = row[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid emergency integer: ${key}`);
  return value;
}
