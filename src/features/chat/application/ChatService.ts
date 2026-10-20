import type { Clock } from '../../dtn/domain/ports';
import type { DtnEvent, PeerId } from '../../dtn/domain/types';
import { isPeerId } from '../../dtn/domain/validation';
import type { ChatEngine, ChatMesh, ChatRepository } from '../domain/ports';
import { conversationFor } from '../domain/messages';
import type {
  ChatActionResult, ChatIssue, ChatSnapshot, ConversationId, RoutingChatEntry,
} from '../domain/types';

export interface ChatServiceOptions {
  readonly engine: ChatEngine;
  readonly repository: ChatRepository;
  readonly mesh?: ChatMesh;
  readonly clock?: Clock;
  readonly pageSize?: number;
  readonly refreshIntervalMs?: number;
  readonly sosText?: string;
}

/** A React-independent external store. All archive writes are serialized, while
 * emergency publication goes straight to the durable DTN use case: a broken
 * chat archive must never block an SOS that the routing database can queue. */
export class ChatService {
  readonly deviceId: PeerId;
  private readonly engine: ChatEngine;
  private readonly repository: ChatRepository;
  private readonly mesh: ChatMesh | undefined;
  private readonly clock: Clock;
  private readonly pageSize: number;
  private readonly refreshIntervalMs: number;
  private readonly sosText: string;
  private readonly listeners = new Set<() => void>();
  private readonly drafts = new Map<ConversationId, string>();
  private readonly pendingArchive = new Map<string, RoutingChatEntry>();
  private readonly pendingCustody = new Set<string>();
  private state: ChatSnapshot;
  private active = false;
  private visible = true;
  private initialized = false;
  private generation = 0;
  private lifecycleIntent = 0;
  private selectionRevision = 0;
  private visibleLimit: number;
  private lifecycle: Promise<void> = Promise.resolve();
  private work: Promise<void> = Promise.resolve();
  private unsubscribers: (() => void)[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private archiveFlushQueued = false;
  private archiveFailed = false;
  private subscriptionsReady = false;

  constructor(options: ChatServiceOptions) {
    if (!isPeerId(options.engine.deviceId)) throw new TypeError('Invalid chat device ID');
    this.deviceId = options.engine.deviceId;
    this.engine = options.engine;
    this.repository = options.repository;
    this.mesh = options.mesh;
    this.clock = options.clock ?? { now: () => Date.now() };
    this.pageSize = options.pageSize ?? 50;
    this.visibleLimit = this.pageSize;
    this.refreshIntervalMs = options.refreshIntervalMs ?? 30_000;
    this.sosText = options.sosText ?? 'I need help';
    if (!Number.isSafeInteger(this.pageSize) || this.pageSize < 1 || this.pageSize > 1_000
      || !Number.isSafeInteger(this.refreshIntervalMs) || this.refreshIntervalMs < 1 || this.refreshIntervalMs > 2_147_483_647
      || this.sosText.trim().length === 0 || this.sosText.length > 4_096) {
      throw new RangeError('Invalid chat service configuration');
    }
    this.state = Object.freeze({
      status: 'idle', conversations: Object.freeze([]), messages: Object.freeze([]),
      selectedConversationId: null, connectedPeers: Object.freeze([]), draft: '',
      pendingSend: false, pendingSos: false, hasOlderMessages: false,
      issue: null, notice: null, now: this.now(),
    });
  }

  /** Arrow properties preserve identity for useSyncExternalStore. */
  getSnapshot = (): ChatSnapshot => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  start(): Promise<void> {
    const intent = ++this.lifecycleIntent;
    return this.transition(async () => {
      if (intent !== this.lifecycleIntent || this.active) return;
      this.active = true;
      this.archiveFailed = false;
      const generation = ++this.generation;
      this.patch({ status: 'loading', issue: null, connectedPeers: this.readPeers() });
      // Queue initialization first, then subscribe before reading the routing
      // snapshot. Events during that read follow it and cannot be lost or let
      // an older snapshot downgrade a newly persisted custody acknowledgment.
      const initial = this.enqueue(() => this.synchronize(generation), generation);
      this.attachSubscriptions(generation);
      await initial;
      if (this.live(generation)) {
        this.timer = setInterval(() => {
          if (this.live(generation)) {
            this.patch({ now: this.now() });
            this.archiveFailed = false;
            this.scheduleArchiveFlush(generation);
          }
        }, this.refreshIntervalMs);
      }
    });
  }

  /** Does not stop the engine, mesh, or database owned by the mobile runtime. */
  stop(): Promise<void> {
    this.lifecycleIntent += 1;
    this.active = false;
    this.generation += 1;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.subscriptionsReady = false;
    this.removeSubscriptions();
    return this.transition(async () => {
      await this.work;
      this.patch({ status: 'idle', pendingSend: false, pendingSos: false });
    });
  }

  openConversation = async (id: ConversationId): Promise<void> => {
    if (id !== '*' && !isPeerId(id)) {
      this.patch({ issue: 'invalid-input' });
      return;
    }
    this.selectionRevision += 1;
    this.visibleLimit = this.pageSize;
    this.patch({
      selectedConversationId: id, messages: Object.freeze([]), hasOlderMessages: false,
      draft: this.drafts.get(id) ?? '', notice: null,
    });
    if (this.active) await this.enqueue(() => this.reload(true));
  };

  closeConversation = (): void => {
    this.selectionRevision += 1;
    this.patch({ selectedConversationId: null, messages: Object.freeze([]), draft: '', hasOlderMessages: false });
    if (this.active) void this.enqueue(() => this.reload(false));
  };

  setDraft = (text: string): void => {
    const conversation = this.state.selectedConversationId;
    if (conversation === null) return;
    if (typeof text !== 'string' || text.length > 4_096) {
      this.patch({ issue: 'invalid-input' });
      return;
    }
    // Drafts are session-local. Bound them independently of the durable archive.
    if (!this.drafts.has(conversation) && this.drafts.size >= 32) {
      const oldest = this.drafts.keys().next().value;
      if (oldest !== undefined) this.drafts.delete(oldest);
    }
    if (text === '') this.drafts.delete(conversation);
    else this.drafts.set(conversation, text);
    this.patch({ draft: text });
  };

  send = async (): Promise<ChatActionResult> => {
    if (!this.active || this.state.selectedConversationId === null) return { status: 'rejected', reason: 'unavailable' };
    if (this.state.pendingSend) return { status: 'rejected', reason: 'busy' };
    const destination = this.state.selectedConversationId;
    const text = this.state.draft;
    if (text.trim().length === 0) return { status: 'rejected', reason: 'empty' };
    if (text.length > 4_096) return { status: 'rejected', reason: 'too-long' };
    const generation = this.generation;
    this.patch({ pendingSend: true, issue: null, notice: null });
    try {
      const result = await this.engine.publish({ kind: 'chat', destination, payload: { text } });
      if (result.status === 'full') {
        if (this.live(generation)) this.patch({ issue: 'queue-full' });
        return { status: 'rejected', reason: 'capacity' };
      }
      if (this.live(generation)) {
        // New typing or navigation while SQLite commits must not be erased by
        // the completion of this older send.
        if (this.drafts.get(destination) === text) {
          this.drafts.delete(destination);
          if (this.state.selectedConversationId === destination) this.patch({ draft: '' });
        }
        this.patch({ notice: { kind: 'chat-queued', messageId: result.record.message.id } });
        this.archive(result.record, generation);
      }
      return { status: 'queued', messageId: result.record.message.id };
    } catch {
      if (this.live(generation)) this.patch({ issue: 'send-unavailable' });
      return { status: 'rejected', reason: 'unavailable' };
    } finally {
      if (this.live(generation)) this.patch({ pendingSend: false });
    }
  };

  sendSos = async (): Promise<ChatActionResult> => {
    if (!this.active) {
      this.patch({ issue: 'send-unavailable' });
      return { status: 'rejected', reason: 'unavailable' };
    }
    if (this.state.pendingSos) return { status: 'rejected', reason: 'busy' };
    const generation = this.generation;
    this.patch({ pendingSos: true, issue: null, notice: null });
    try {
      // This deliberately does not await archive initialization or work: the
      // routing DB is the authority for whether the emergency was queued.
      const result = await this.engine.publish({ kind: 'sos', payload: { text: this.sosText } });
      if (result.status === 'full') {
        if (this.live(generation)) this.patch({ issue: 'queue-full' });
        return { status: 'rejected', reason: 'capacity' };
      }
      if (this.live(generation)) {
        this.patch({ notice: { kind: 'sos-queued', messageId: result.record.message.id } });
        this.archive(result.record, generation);
      }
      return { status: 'queued', messageId: result.record.message.id };
    } catch {
      if (this.live(generation)) this.patch({ issue: 'send-unavailable' });
      return { status: 'rejected', reason: 'unavailable' };
    } finally {
      if (this.live(generation)) this.patch({ pendingSos: false });
    }
  };

  loadOlder = async (): Promise<void> => {
    if (!this.active || !this.state.hasOlderMessages || this.visibleLimit >= 1_000) return;
    this.visibleLimit = Math.min(1_000, this.visibleLimit + this.pageSize);
    await this.enqueue(() => this.reload(true));
  };

  refresh = async (): Promise<void> => {
    if (!this.active) { await this.start(); return; }
    const generation = this.generation;
    this.patch({ issue: null, status: this.state.conversations.length ? 'ready' : 'loading' });
    this.archiveFailed = false;
    if (!this.subscriptionsReady) this.attachSubscriptions(generation);
    await this.enqueue(() => this.synchronize(generation), generation);
  };

  dismissIssue = (): void => { this.patch({ issue: null }); };
  dismissNotice = (): void => { this.patch({ notice: null }); };

  /** Keep archiving in the background, but count arrivals unread until this
   * conversation is actually visible. The native host also sets false for a
   * hidden navigation route even when the app itself stays in the foreground. */
  setVisible = (visible: boolean): void => {
    if (typeof visible !== 'boolean') throw new TypeError('Chat visibility must be boolean');
    const becameVisible = visible && !this.visible;
    this.visible = visible;
    if (becameVisible && this.active) void this.enqueue(() => this.reload(true));
  };

  private async synchronize(generation: number): Promise<void> {
    await this.repository.initialize();
    this.initialized = true;
    if (!this.live(generation)) return;
    const records = await this.engine.historyWithCustody(1_000);
    if (!this.live(generation)) return;
    await this.repository.upsert(records, this.deviceId);
    if (!this.live(generation)) return;
    await this.reload(true);
    this.scheduleArchiveFlush(generation);
  }

  private onEngineEvent(event: DtnEvent, generation: number): void {
    if (event.type === 'accepted') this.archive(event.record, generation);
    else if (event.type === 'hop-acknowledged') {
      const pending = this.pendingArchive.get(event.messageId);
      if (pending) this.pendingArchive.set(event.messageId, { ...pending, peerStored: true });
      if (this.pendingCustody.size < 1_000 || this.pendingCustody.has(event.messageId)) {
        this.pendingCustody.add(event.messageId);
      } else this.patch({ issue: 'history-unavailable' });
      this.scheduleArchiveFlush(generation);
    } else if (event.type === 'error') this.patch({ issue: 'routing-error' });
  }

  private archive(record: Omit<RoutingChatEntry, 'peerStored'>, generation: number): void {
    if (conversationFor(record.message, this.deviceId) === null) return;
    if (!this.pendingArchive.has(record.message.id) && this.pendingArchive.size >= 1_000) {
      // The routing queue remains authoritative under archive backpressure. Its
      // next snapshot can reconcile retained packets; never allocate an
      // unbounded promise per incoming message or falsely fail a committed SOS.
      this.patch({ issue: 'history-unavailable' });
      return;
    }
    const knownCustody = this.pendingArchive.get(record.message.id)?.peerStored
      || this.pendingCustody.has(record.message.id);
    this.pendingArchive.set(record.message.id, { ...record, peerStored: Boolean(knownCustody) });
    this.scheduleArchiveFlush(generation);
  }

  private scheduleArchiveFlush(generation: number): void {
    if (!this.live(generation) || this.archiveFlushQueued || this.archiveFailed
      || (!this.pendingArchive.size && !this.pendingCustody.size)) return;
    this.archiveFlushQueued = true;
    void this.enqueue(async () => {
      let completed = false;
      try {
        if (!this.initialized) return;
        const entries = [...this.pendingArchive.values()].slice(0, 100);
        const custody = [...this.pendingCustody].slice(0, 100);
        if (entries.length) await this.repository.upsert(entries, this.deviceId);
        for (const id of custody) await this.repository.markPeerStored(id);
        for (const entry of entries) this.pendingArchive.delete(entry.message.id);
        for (const id of custody) this.pendingCustody.delete(id);
        await this.reload(true);
        completed = true;
      } catch (error) {
        this.archiveFailed = true;
        throw error;
      } finally {
        this.archiveFlushQueued = false;
        if (completed) this.scheduleArchiveFlush(generation);
      }
    }, generation).then(() => {
      // A queued flush skipped by stop() still needs to release its admission
      // flag so a subsequent start can reconcile the bounded pending maps.
      if (!this.live(generation)) this.archiveFlushQueued = false;
    });
  }

  private async reload(markRead: boolean): Promise<void> {
    const generation = this.generation;
    const revision = this.selectionRevision;
    const conversation = this.state.selectedConversationId;
    let messages = conversation === null ? [] : [...await this.repository.listMessages(conversation, this.visibleLimit + 1)];
    if (!this.live(generation) || revision !== this.selectionRevision) return;
    const hasOlderMessages = messages.length > this.visibleLimit;
    if (hasOlderMessages) messages = messages.slice(1);
    if (markRead && this.visible && conversation !== null && messages.length) {
      await this.repository.markRead(conversation, messages[messages.length - 1]!.sequence);
      if (!this.live(generation) || revision !== this.selectionRevision) return;
      messages = messages.map(message => Object.freeze({ ...message, read: true }));
    }
    const conversations = await this.repository.listConversations();
    if (!this.live(generation) || revision !== this.selectionRevision) return;
    this.patch({
      status: this.subscriptionsReady ? 'ready' : 'error',
      conversations: Object.freeze([...conversations]), messages: Object.freeze(messages),
      hasOlderMessages: hasOlderMessages && this.visibleLimit < 1_000, now: this.now(), connectedPeers: this.readPeers(),
      ...(!this.subscriptionsReady ? { issue: 'history-unavailable' } : this.state.issue === 'history-unavailable' ? { issue: null } : {}),
    });
  }

  private enqueue(operation: () => Promise<void>, generation = this.generation): Promise<void> {
    const next = this.work.then(async () => { if (this.live(generation)) await operation(); });
    this.work = next.catch(() => {
      if (this.live(generation)) this.patch({
        issue: this.state.issue === 'queue-full' || this.state.issue === 'send-unavailable' ? this.state.issue : 'history-unavailable',
        status: this.state.conversations.length || this.state.messages.length ? 'ready' : 'error',
      });
    });
    return this.work;
  }

  private live(generation: number): boolean { return this.active && this.generation === generation; }

  private attachSubscriptions(generation: number): void {
    this.removeSubscriptions();
    this.subscriptionsReady = false;
    try {
      this.unsubscribers.push(this.engine.subscribe(event => {
        if (this.live(generation)) this.onEngineEvent(event, generation);
      }));
      if (this.mesh) this.unsubscribers.push(this.mesh.subscribe(event => {
        if (this.live(generation) && event.type === 'peers') this.patch({ connectedPeers: this.readPeers() });
      }));
      this.subscriptionsReady = true;
    } catch {
      this.removeSubscriptions();
      this.patch({ status: 'error', issue: 'history-unavailable' });
    }
  }

  private removeSubscriptions(): void {
    for (const unsubscribe of this.unsubscribers.splice(0)) {
      try { unsubscribe(); } catch { /* Generation guards still reject an obsolete listener. */ }
    }
  }

  private readPeers(): readonly PeerId[] {
    try { return Object.freeze([...new Set(this.mesh?.connectedPeers() ?? [])].filter(isPeerId).slice(0, 64)); }
    catch { return Object.freeze([]); }
  }

  private now(): number {
    const now = this.clock.now();
    if (!Number.isSafeInteger(now) || now < 0) throw new RangeError('Invalid chat clock timestamp');
    return now;
  }

  private patch(patch: Partial<ChatSnapshot>): void {
    this.state = Object.freeze({ ...this.state, ...patch });
    for (const listener of [...this.listeners]) {
      try { listener(); } catch { /* A screen cannot break archive/custody handling. */ }
    }
  }

  private transition(operation: () => Promise<void>): Promise<void> {
    const result = this.lifecycle.then(operation);
    this.lifecycle = result.catch(() => {});
    return result;
  }
}
