import { randomUUID } from 'node:crypto';
import type { ChatEngine, ChatMesh, ChatRepository } from '../../src/features/chat/domain/ports';
import type { RoutingChatEntry } from '../../src/features/chat/domain/types';
import type { AcceptResult, DtnEvent, OutgoingMessage, StoredMessage } from '../../src/features/dtn/domain/types';
import { createMessage } from '../../src/features/dtn/domain/validation';
import type { MeshEvent } from '../../src/features/mesh/domain/types';

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export async function until(predicate: () => boolean, label = 'state update'): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

export function stored(input: OutgoingMessage, source = 'alice', now = 1_000): StoredMessage {
  return {
    message: createMessage(input, randomUUID(), source, now), receivedAt: now,
    expiresAt: now + 10_000, dedupExpiresAt: now + 20_000, forwardable: true,
  };
}

/** Controllable engine boundary for commit, history, and lifecycle races. The
 * SQLite integration cases use the real DtnEngine instead of this double. */
export class ControlledChatEngine implements ChatEngine {
  readonly deviceId = 'alice';
  readonly listeners = new Set<(event: DtnEvent) => void>();
  readonly publications: OutgoingMessage[] = [];
  records: RoutingChatEntry[] = [];
  readHistory: () => Promise<readonly RoutingChatEntry[]> = async () => this.records;
  publishNext: ((input: OutgoingMessage) => Promise<Exclude<AcceptResult, { status: 'duplicate' }>>) | undefined;

  subscribe(listener: (event: DtnEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  historyWithCustody(): Promise<readonly RoutingChatEntry[]> { return this.readHistory(); }
  async publish(input: OutgoingMessage): Promise<Exclude<AcceptResult, { status: 'duplicate' }>> {
    this.publications.push(input);
    if (this.publishNext) return this.publishNext(input);
    const record = stored(input);
    this.records.push({ ...record, peerStored: false });
    this.emit({ type: 'accepted', record, local: true });
    return { status: 'accepted', record };
  }
  emit(event: DtnEvent): void { for (const listener of [...this.listeners]) listener(event); }
  incoming(text: string, source = 'bob', destination = 'alice', now = 1_000): StoredMessage {
    const record = stored({ kind: 'chat', destination, payload: { text } }, source, now);
    this.records.push({ ...record, peerStored: false });
    this.emit({ type: 'accepted', record, local: false });
    return record;
  }
}

export class ControlledChatMesh implements ChatMesh {
  readonly listeners = new Set<(event: MeshEvent) => void>();
  peers: string[] = [];
  connectedPeers(): readonly string[] { return this.peers; }
  subscribe(listener: (event: MeshEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  update(peers: string[]): void {
    this.peers = peers;
    for (const listener of this.listeners) listener({ type: 'peers', peers });
  }
}

/** Wrap only the awaited boundary under test; all archive behavior still uses
 * real SQLite so races also exercise actual idempotence and read ordering. */
export function wrapRepository(repository: ChatRepository, overrides: Partial<ChatRepository>): ChatRepository {
  return {
    initialize: () => repository.initialize(),
    upsert: (entries, id) => repository.upsert(entries, id),
    markPeerStored: id => repository.markPeerStored(id),
    markRead: (id, through) => repository.markRead(id, through),
    listMessages: (id, limit) => repository.listMessages(id, limit),
    listConversations: () => repository.listConversations(),
    ...overrides,
  };
}
