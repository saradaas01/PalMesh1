import { isPeerId } from '../../dtn/domain/validation';
import type { PeerId } from '../../dtn/domain/types';
import type { SqliteRow, SynchronousSqliteDatabase } from '../../dtn/infrastructure/sqlite/SqliteDtnStore';
import type { ChatRepository } from '../domain/ports';
import { projectEntry } from '../domain/messages';
import type { ChatMessage, Conversation, ConversationId, RoutingChatEntry } from '../domain/types';

/** A separate bounded archive, not the router's expiring queue. Dedicate this
 * synchronous SQLite handle to the archive; the mobile host owns its close(). */
export class SqliteChatRepository implements ChatRepository {
  readonly maxMessages: number;
  private initialized = false;
  private boundIdentity: PeerId | null = null;

  constructor(private readonly database: SynchronousSqliteDatabase, options: { readonly maxMessages?: number } = {}) {
    this.maxMessages = options.maxMessages ?? 5_000;
    integer(this.maxMessages, 1, 20_000, 'maxMessages');
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.transaction(() => {
      this.database.execute(`CREATE TABLE IF NOT EXISTS palmesh_chat_schema (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1), version INTEGER NOT NULL, local_device_id TEXT
      )`);
      const version = this.database.execute('SELECT version FROM palmesh_chat_schema WHERE singleton = 1').rows[0]?.version;
      if (version !== undefined && version !== 1) throw new Error('Unsupported chat archive schema version');
      if (version === undefined) {
        this.database.execute(`CREATE TABLE palmesh_chat_messages (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL UNIQUE,
          conversation_id TEXT NOT NULL, source TEXT NOT NULL, destination TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('chat', 'sos')), text TEXT NOT NULL,
          created_at INTEGER NOT NULL, received_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
          outgoing INTEGER NOT NULL CHECK (outgoing IN (0, 1)),
          peer_stored INTEGER NOT NULL CHECK (peer_stored IN (0, 1)),
          is_read INTEGER NOT NULL CHECK (is_read IN (0, 1)), location TEXT
        )`);
        this.database.execute('CREATE INDEX palmesh_chat_conversation ON palmesh_chat_messages (conversation_id, sequence)');
        // Tombstones preserve UUID idempotence when a bounded archive evicts a
        // packet that is still present in the routing snapshot. This metadata
        // budget is separate from the full message bodies.
        this.database.execute(`CREATE TABLE palmesh_chat_seen (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL UNIQUE
        )`);
        this.database.execute('INSERT INTO palmesh_chat_schema (singleton, version, local_device_id) VALUES (1, 1, NULL)');
      }
    });
    this.initialized = true;
  }

  async upsert(entries: readonly RoutingChatEntry[], localDeviceId: PeerId): Promise<void> {
    this.requireInitialized();
    if (!isPeerId(localDeviceId)) throw new TypeError('Invalid archive device identity');
    // Discard invisible/malformed projections before they can reach storage.
    // Stable sort preserves local source order at equal arrival time.
    const projected = entries.map(entry => projectEntry(entry, localDeviceId))
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .sort((a, b) => a.receivedAt - b.receivedAt);
    this.transaction(() => {
      const owner = this.database.execute('SELECT local_device_id FROM palmesh_chat_schema WHERE singleton = 1').rows[0]?.local_device_id;
      if (owner !== null && owner !== localDeviceId) throw new Error('Chat archive belongs to another device identity');
      if (owner === null) this.database.execute('UPDATE palmesh_chat_schema SET local_device_id = ? WHERE singleton = 1', [localDeviceId]);
      for (const entry of projected) {
        const existing = this.database.execute('SELECT message_id FROM palmesh_chat_seen WHERE message_id = ?', [entry.id]).rows[0];
        if (existing) {
          if (entry.peerStored) this.database.execute(
            'UPDATE palmesh_chat_messages SET peer_stored = 1 WHERE message_id = ? AND outgoing = 1', [entry.id],
          );
          continue;
        }
        this.database.execute('INSERT INTO palmesh_chat_seen (message_id) VALUES (?)', [entry.id]);
        this.database.execute(`INSERT INTO palmesh_chat_messages
          (message_id, conversation_id, source, destination, kind, text, created_at, received_at,
            expires_at, outgoing, peer_stored, is_read, location)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [entry.id, entry.conversationId, entry.source, entry.destination, entry.kind, entry.text,
          entry.createdAt, entry.receivedAt, entry.expiresAt, entry.outgoing ? 1 : 0,
          entry.peerStored ? 1 : 0, entry.outgoing ? 1 : 0, entry.location ? JSON.stringify(entry.location) : null]);
      }
      this.database.execute(`DELETE FROM palmesh_chat_messages WHERE sequence IN (
        SELECT sequence FROM palmesh_chat_messages ORDER BY sequence DESC LIMIT -1 OFFSET ?
      )`, [this.maxMessages]);
      this.database.execute(`DELETE FROM palmesh_chat_seen WHERE sequence IN (
        SELECT sequence FROM palmesh_chat_seen WHERE NOT EXISTS (
          SELECT 1 FROM palmesh_chat_messages m WHERE m.message_id = palmesh_chat_seen.message_id
        ) ORDER BY sequence DESC LIMIT -1 OFFSET ?
      )`, [Math.max(10_000, this.maxMessages * 2)]);
    });
    this.boundIdentity = localDeviceId;
  }

  async markPeerStored(messageId: string): Promise<void> {
    this.requireBound();
    messageId = uuid(messageId);
    this.database.execute('UPDATE palmesh_chat_messages SET peer_stored = 1 WHERE message_id = ? AND outgoing = 1', [messageId]);
  }

  async markRead(conversationId: ConversationId, throughSequence: number): Promise<void> {
    this.requireBound();
    conversation(conversationId);
    integer(throughSequence, 0, Number.MAX_SAFE_INTEGER, 'throughSequence');
    this.database.execute('UPDATE palmesh_chat_messages SET is_read = 1 WHERE conversation_id = ? AND sequence <= ?',
      [conversationId, throughSequence]);
  }

  async listConversations(): Promise<readonly Conversation[]> {
    this.requireBound();
    return this.database.execute(`SELECT m.*, c.unread_count FROM palmesh_chat_messages m JOIN (
      SELECT conversation_id, MAX(sequence) AS latest,
        SUM(CASE WHEN outgoing = 0 AND is_read = 0 THEN 1 ELSE 0 END) AS unread_count
      FROM palmesh_chat_messages GROUP BY conversation_id
    ) c ON c.latest = m.sequence ORDER BY m.sequence DESC`).rows.map(row => Object.freeze({
      id: string(row, 'conversation_id'), lastMessage: decode(row), unreadCount: number(row, 'unread_count'),
    }));
  }

  async listMessages(conversationId: ConversationId, limit: number): Promise<readonly ChatMessage[]> {
    this.requireBound();
    conversation(conversationId);
    integer(limit, 1, 1_001, 'limit');
    return this.database.execute(
      'SELECT * FROM palmesh_chat_messages WHERE conversation_id = ? ORDER BY sequence DESC LIMIT ?', [conversationId, limit],
    ).rows.map(decode).reverse();
  }

  private requireInitialized(): void {
    if (!this.initialized) throw new Error('Initialize the chat archive first');
  }

  private requireBound(): void {
    this.requireInitialized();
    if (this.boundIdentity === null) throw new Error('Bind the chat archive with upsert(entries, localDeviceId) first');
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
}

function decode(row: SqliteRow): ChatMessage {
  const kind = string(row, 'kind');
  if (kind !== 'chat' && kind !== 'sos') throw new Error('Invalid chat message kind');
  const location = row.location === null ? undefined : Object.freeze(JSON.parse(string(row, 'location')) as NonNullable<ChatMessage['location']>);
  return Object.freeze({
    id: string(row, 'message_id'), sequence: number(row, 'sequence'), conversationId: string(row, 'conversation_id'),
    source: string(row, 'source'), destination: string(row, 'destination'), kind, text: string(row, 'text'),
    createdAt: number(row, 'created_at'), receivedAt: number(row, 'received_at'), expiresAt: number(row, 'expires_at'),
    outgoing: number(row, 'outgoing') === 1, peerStored: number(row, 'peer_stored') === 1, read: number(row, 'is_read') === 1,
    ...(location ? { location } : {}),
  });
}

function integer(value: number, minimum: number, maximum: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new RangeError(`Invalid ${name}`);
}
function conversation(id: string): void {
  if (id !== '*' && !isPeerId(id)) throw new TypeError('Invalid conversation ID');
}
function uuid(id: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/i.test(id)) {
    throw new TypeError('Invalid message UUID');
  }
  return id.toLowerCase();
}
function string(row: SqliteRow, key: string): string {
  if (typeof row[key] !== 'string') throw new Error(`Invalid chat text column: ${key}`);
  return row[key];
}
function number(row: SqliteRow, key: string): number {
  const value = row[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`Invalid chat integer column: ${key}`);
  return value;
}
