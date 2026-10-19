import type { Clock, DtnStore, IdGenerator, MeshTransport, PacketSecurity } from '../domain/ports';
import { canForward, forNextHop } from '../domain/routing';
import { createMessage, isPeerId, parseMessage } from '../domain/validation';
import type {
  AcceptResult, DtnEvent, MeshMessage, OutgoingMessage, PeerId, PowerMode,
  ReceiveResult, RoutingHistoryEntry, StorageLimits, StoredMessage,
} from '../domain/types';

export interface DtnConfig extends StorageLimits {
  readonly messageRetentionMs: number;
  readonly dedupRetentionMs: number;
  readonly maxPacketBytes: number;
  readonly maxConnectedPeers: number;
  readonly sendTimeoutMs: number;
  readonly retryBaseMs: number;
  readonly retryMaxMs: number;
  readonly maintenanceIntervalMs: number;
  readonly maxSendsPerTurn: number;
}

export const DEFAULT_DTN_CONFIG: Readonly<DtnConfig> = Object.freeze({
  maxMessages: 1_000,
  reservedEmergencyMessages: 100,
  maxSeenIds: 10_000,
  reservedEmergencySeenIds: 1_000,
  maxPeersPerMessage: 256,
  messageRetentionMs: 24 * 60 * 60 * 1_000,
  dedupRetentionMs: 7 * 24 * 60 * 60 * 1_000,
  maxPacketBytes: 16 * 1_024,
  maxConnectedPeers: 64,
  sendTimeoutMs: 10_000,
  retryBaseMs: 1_000,
  retryMaxMs: 60_000,
  maintenanceIntervalMs: 60_000,
  maxSendsPerTurn: 32,
});

export interface DtnEngineOptions {
  readonly deviceId: PeerId;
  readonly store: DtnStore;
  readonly transport: MeshTransport;
  readonly ids: IdGenerator;
  readonly clock?: Clock;
  readonly config?: Partial<DtnConfig>;
  readonly security?: PacketSecurity;
}

type Listener = (event: DtnEvent) => void | Promise<void>;

/** One engine owns one store/transport session. Native discovery supplies stable
 * peer IDs; it must not start a second worker for the same SQLite database. */
export class DtnEngine {
  readonly deviceId: PeerId;
  readonly config: Readonly<DtnConfig>;
  private readonly store: DtnStore;
  private readonly transport: MeshTransport;
  private readonly ids: IdGenerator;
  private readonly clock: Clock;
  private readonly security: PacketSecurity | undefined;
  private readonly listeners = new Set<Listener>();
  private peers: readonly PeerId[] = [];
  private powerMode: PowerMode = 'normal';
  private running = false;
  private lifecycle: Promise<void> = Promise.resolve();
  private worker: Promise<void> | null = null;
  private pendingWake = false;
  private yieldPending = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private activeSend: { readonly peerId: PeerId; readonly controller: AbortController } | null = null;
  private nextMaintenanceAt = 0;
  private lastNow = 0;

  constructor(options: DtnEngineOptions) {
    if (!isPeerId(options.deviceId)) throw new TypeError('Invalid local device ID');
    this.deviceId = options.deviceId;
    this.store = options.store;
    this.transport = options.transport;
    this.ids = options.ids;
    this.clock = options.clock ?? { now: () => Date.now() };
    this.security = options.security;
    if (this.security && this.security.deviceId !== this.deviceId) throw new TypeError('Secure identity does not match local device ID');
    this.config = Object.freeze({ ...DEFAULT_DTN_CONFIG, ...options.config });
    validateConfig(this.config);
  }

  start(): Promise<void> {
    return this.transition(async () => {
      if (this.running) return;
      await this.store.initialize();
      const now = this.now();
      await this.store.prune(now);
      this.nextMaintenanceAt = now + this.config.maintenanceIntervalMs;
      this.running = true;
      this.kick();
    });
  }

  /** Cancels only this engine's I/O and waits for its worker before returning.
   * The database remains open and the durable queue survives a later start. */
  stop(): Promise<void> {
    return this.transition(async () => {
      this.running = false;
      this.pendingWake = false;
      this.clearTimer();
      this.activeSend?.controller.abort();
      await this.worker;
    });
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Admission control belongs to discovery: do not silently discard connected
   * peers when its limit is exceeded. IDs must survive Wi-Fi/BLE reconnects. */
  setConnectedPeers(peers: readonly PeerId[]): void {
    if (peers.some(peer => !isPeerId(peer))) throw new TypeError('Invalid peer ID');
    const unique = [...new Set(peers)].filter(peer => peer !== this.deviceId);
    if (unique.length > this.config.maxConnectedPeers) throw new RangeError('Too many connected peers');
    this.peers = Object.freeze(unique);
    if (this.activeSend && !unique.includes(this.activeSend.peerId)) {
      this.activeSend.controller.abort();
    }
    this.kick();
  }

  /** Battery conservation pauses ordinary forwarding, while SOS stays eligible.
   * Already transmitted bytes cannot be preempted; priority is rechecked before
   * every subsequent packet, rather than capturing a stale queue snapshot. */
  setPowerMode(mode: PowerMode): void {
    if (mode !== 'normal' && mode !== 'conserve') throw new TypeError('Invalid power mode');
    this.powerMode = mode;
    this.kick();
  }

  async publish(input: OutgoingMessage): Promise<Exclude<AcceptResult, { readonly status: 'duplicate' }>> {
    this.assertRunning();
    const now = this.now();
    const plaintext = createMessage(input, this.ids.next(), this.deviceId, now, this.config.maxPacketBytes);
    const message = this.security ? await this.security.seal(plaintext) : plaintext;
    const bounded = parseMessage(message, this.config.maxPacketBytes);
    if (!bounded.ok) throw new Error(bounded.reason);
    const result = await this.store.accept(this.record(message, now), null, this.config, now);
    if (result.status === 'duplicate') {
      throw new Error('UUID generator reused an existing message ID');
    }
    const projected = await this.reportAcceptance(result, message.id, true);
    this.kick();
    return projected as Exclude<AcceptResult, { readonly status: 'duplicate' }>;
  }

  /** The native receiver may ACK only accepted/duplicate results. Storage errors
   * reject this Promise; full/invalid results must produce a NACK or no ACK.
   * An ACK means stored at this hop, not read or delivered to a person. */
  async receive(previousHop: PeerId, packet: unknown): Promise<ReceiveResult> {
    this.assertRunning();
    if (!isPeerId(previousHop) || previousHop === this.deviceId) {
      return this.rejectPacket('Invalid previous-hop device ID');
    }
    const parsed = parseMessage(packet, this.config.maxPacketBytes);
    if (!parsed.ok) return this.rejectPacket(parsed.reason);
    if (parsed.message.source === this.deviceId) {
      return this.rejectPacket('Received packet claims the local source ID');
    }
    if (this.security) {
      try { await this.security.verify(parsed.message); }
      catch (error) { return this.rejectPacket(error instanceof Error ? error.message : 'Packet authentication failed'); }
    }
    const now = this.now();
    const result = await this.store.accept(this.record(parsed.message, now), previousHop, this.config, now);
    await this.reportAcceptance(result, parsed.message.id, false);
    this.kick();
    return result;
  }

  history(limit = 100): Promise<readonly StoredMessage[]> {
    this.assertRunning();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RangeError('History limit must be between 1 and 1000');
    }
    const entries = this.store.listHistory(limit);
    const security = this.security;
    if (!security) return entries;
    return entries.then(async records => {
      const projected: StoredMessage[] = [];
      for (const entry of records) {
        const message = await security.project(entry.message);
        if (message) projected.push(Object.freeze({ ...entry, message }));
      }
      return Object.freeze(projected);
    });
  }

  historyWithCustody(limit = 1_000): Promise<readonly RoutingHistoryEntry[]> {
    this.assertRunning();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RangeError('History limit must be between 1 and 1000');
    }
    const entries = this.store.listHistoryWithCustody(limit);
    const security = this.security;
    if (!security) return entries;
    return entries.then(async records => {
      const projected: RoutingHistoryEntry[] = [];
      for (const entry of records) {
        const message = await security.project(entry.message);
        if (message) projected.push(Object.freeze({ ...entry, message }));
      }
      return Object.freeze(projected);
    });
  }

  /** Useful for tests/manual synchronization. Waits for ready work across bounded
   * batches, yielding to the JS event loop, without waiting for future retries. */
  async flush(): Promise<void> {
    this.assertRunning();
    this.kick();
    while (this.running && (this.worker || this.yieldPending)) {
      if (this.worker) await this.worker;
      else {
        await new Promise<void>(resolve => { setTimeout(resolve, 0); });
        if (this.running) this.kick();
      }
    }
  }

  private transition(operation: () => Promise<void>): Promise<void> {
    const result = this.lifecycle.then(operation);
    this.lifecycle = result.catch(() => { /* Permit recovery after a failed start. */ });
    return result;
  }

  private record(message: MeshMessage, now: number): StoredMessage {
    return Object.freeze({
      message,
      receivedAt: now,
      expiresAt: now + this.config.messageRetentionMs,
      dedupExpiresAt: now + this.config.dedupRetentionMs,
      forwardable: canForward(message, this.deviceId),
    });
  }

  private async reportAcceptance(result: AcceptResult, messageId: string, local: boolean): Promise<AcceptResult> {
    if (result.status === 'accepted') {
      const message = this.security ? await this.security.project(result.record.message) : result.record.message;
      if (message) {
        const projected = { status: 'accepted' as const, record: Object.freeze({ ...result.record, message }) };
        this.emit({ type: 'accepted', record: projected.record, local });
        return projected;
      }
    }
    else if (result.status === 'duplicate') this.emit({ type: 'duplicate', messageId });
    else this.emit({ type: 'rejected', reason: `Storage capacity reached: ${result.resource}` });
    return result;
  }

  private rejectPacket(reason: string): ReceiveResult {
    this.emit({ type: 'rejected', reason });
    return { status: 'invalid', reason };
  }

  private kick(): void {
    if (!this.running) return;
    this.clearTimer();
    this.pendingWake = true;
    if (this.worker) return;
    this.worker = this.pump().catch(error => {
      this.pendingWake = false;
      this.emit({ type: 'error', operation: 'forwarding', error });
      this.schedule(this.config.retryBaseMs);
    }).finally(() => {
      this.worker = null;
      if (this.running && this.pendingWake) this.kick();
    });
  }

  private async pump(): Promise<void> {
    let sent = 0;
    while (this.running) {
      this.pendingWake = false;
      const now = this.now();
      if (now >= this.nextMaintenanceAt) {
        await this.store.prune(now);
        this.nextMaintenanceAt = now + this.config.maintenanceIntervalMs;
      }
      const candidate = await this.store.getNextDelivery(
        this.peers, now, this.powerMode === 'conserve', this.config.maxPeersPerMessage,
      );
      if (!this.running) return;
      // An SOS/peer/power update during the DB read invalidates that selection.
      if (this.pendingWake) continue;
      if (!candidate || candidate.nextAttemptAt > now) {
        const nextWake = candidate
          ? Math.min(candidate.nextAttemptAt, this.nextMaintenanceAt)
          : this.nextMaintenanceAt;
        this.schedule(Math.max(1, nextWake - this.now()));
        return;
      }
      const packet = this.security ? this.security.forNextHop(candidate.record.message) : forNextHop(candidate.record.message);
      if (!packet) throw new Error('Store returned a terminal packet for forwarding');
      try {
        await this.send(candidate.peerId, packet);
      } catch {
        if (!this.running) return;
        const failedAt = this.now();
        const attempts = Math.min(candidate.attempts + 1, 1_000_000);
        const nextAttemptAt = failedAt + retryDelay(
          packet.id, candidate.peerId, attempts, this.config.retryBaseMs, this.config.retryMaxMs,
        );
        await this.store.markFailed({
          messageId: packet.id, peerId: candidate.peerId, attempts, nextAttemptAt, now: failedAt,
        });
        this.emit({ type: 'retry-scheduled', messageId: packet.id, peerId: candidate.peerId, nextAttemptAt });
        sent += 1;
        if (sent >= this.config.maxSendsPerTurn) return this.yieldWorker();
        continue;
      }
      if (!this.running) return;
      await this.store.markAcknowledged(packet.id, candidate.peerId, this.now());
      this.emit({ type: 'hop-acknowledged', messageId: packet.id, peerId: candidate.peerId });
      sent += 1;
      if (sent >= this.config.maxSendsPerTurn) return this.yieldWorker();
    }
  }

  private yieldWorker(): void {
    this.pendingWake = false;
    this.schedule(0);
    this.yieldPending = true;
  }

  private async send(peerId: PeerId, packet: MeshMessage): Promise<void> {
    const controller = new AbortController();
    const active = { peerId, controller };
    this.activeSend = active;
    let onAbort: (() => void) | undefined;
    const interrupted = new Promise<never>((_resolve, reject) => {
      onAbort = () => { reject(new Error('Hop transmission interrupted')); };
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    const timeout = setTimeout(() => { controller.abort(); }, this.config.sendTimeoutMs);
    try {
      // Promise.resolve also captures a native wrapper that throws synchronously.
      await Promise.race([
        Promise.resolve().then(() => {
          if (controller.signal.aborted) throw new Error('Hop transmission cancelled');
          return this.transport.send(peerId, packet, controller.signal);
        }),
        interrupted,
      ]);
    } finally {
      clearTimeout(timeout);
      if (onAbort) controller.signal.removeEventListener('abort', onAbort);
      if (this.activeSend === active) this.activeSend = null;
    }
  }

  private schedule(delay: number): void {
    if (!this.running) return;
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.kick();
    }, Math.min(delay, 2_147_483_647));
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.yieldPending = false;
  }

  private now(): number {
    const value = this.clock.now();
    if (!Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER - this.config.dedupRetentionMs) {
      throw new RangeError('Clock must return a nonnegative safe millisecond timestamp');
    }
    // A wall-clock correction must not move this session's retention backwards.
    this.lastNow = Math.max(this.lastNow, value);
    return this.lastNow;
  }

  private assertRunning(): void {
    if (!this.running) throw new Error('Start the DTN engine before using it');
  }

  private emit(event: DtnEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        const observed = listener(event);
        if (observed) void Promise.resolve(observed).catch(() => { /* Isolate async observers too. */ });
      } catch { /* UI listeners cannot break routing or durable ACKs. */ }
    }
  }
}

/** Deterministic 0–20% jitter avoids synchronized retries without treating
 * Math.random as a source of identity/security entropy. Backoff is capped. */
function retryDelay(id: string, peerId: string, attempts: number, base: number, maximum: number): number {
  let hash = 2_166_136_261;
  for (const char of `${id}:${peerId}:${attempts}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16_777_619);
  const delay = base * 2 ** Math.min(attempts - 1, 30);
  return Math.min(maximum, Math.ceil(delay * (1 + ((hash >>> 0) % 201) / 1_000)));
}

function validateConfig(config: DtnConfig): void {
  for (const [key, value] of Object.entries(config)) {
    const minimum = key.startsWith('reserved') ? 0 : 1;
    if (!Number.isSafeInteger(value) || value < minimum) throw new RangeError(`Invalid DTN configuration: ${key}`);
  }
  if (config.reservedEmergencyMessages > config.maxMessages
    || config.reservedEmergencySeenIds > config.maxSeenIds
    || config.dedupRetentionMs < config.messageRetentionMs
    || config.retryMaxMs < config.retryBaseMs
    || config.maxConnectedPeers > 64
    || config.maxPeersPerMessage > 4_096
    || config.maxPacketBytes > 64 * 1_024
    || config.sendTimeoutMs > 2_147_483_647
    || config.retryMaxMs > 2_147_483_647
    || config.maintenanceIntervalMs > 2_147_483_647) {
    throw new RangeError('Inconsistent or excessive DTN configuration');
  }
}
