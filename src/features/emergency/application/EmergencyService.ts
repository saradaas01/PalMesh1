import type { Clock } from '../../dtn/domain/ports';
import type { DtnEvent, PeerId, RoutingHistoryEntry } from '../../dtn/domain/types';
import { isPeerId } from '../../dtn/domain/validation';
import type { EmergencyAlerts, EmergencyEngine, EmergencyRepository } from '../domain/ports';
import type { EmergencyActionResult, EmergencySnapshot } from '../domain/types';

export interface EmergencyServiceOptions {
  readonly engine: EmergencyEngine;
  readonly repository: EmergencyRepository;
  readonly alerts?: EmergencyAlerts;
  readonly clock?: Clock;
  readonly refreshIntervalMs?: number;
}
/** Reactive SOS inbox. The DTN engine owns delivery and authentication; this
 * service records human statements separately from radio hop acknowledgments. */
export class EmergencyService {
  readonly deviceId: PeerId;
  private readonly engine: EmergencyEngine;
  private readonly repository: EmergencyRepository;
  private readonly alerts: EmergencyAlerts | undefined;
  private readonly clock: Clock;
  private readonly refreshIntervalMs: number;
  private readonly listeners = new Set<() => void>();
  private readonly pending = new Map<string, RoutingHistoryEntry>();
  private readonly responding = new Set<string>();
  private active = false;
  private generation = 0;
  private unsubscribe: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private work: Promise<void> = Promise.resolve();
  private flushQueued = false;
  private state: EmergencySnapshot;

  constructor(options: EmergencyServiceOptions) {
    if (!isPeerId(options.engine.deviceId)) throw new TypeError('Invalid emergency device identity');
    this.deviceId = options.engine.deviceId;
    this.engine = options.engine;
    this.repository = options.repository;
    this.alerts = options.alerts;
    this.clock = options.clock ?? { now: () => Date.now() };
    this.refreshIntervalMs = options.refreshIntervalMs ?? 30_000;
    if (!Number.isSafeInteger(this.refreshIntervalMs) || this.refreshIntervalMs < 1 || this.refreshIntervalMs > 2_147_483_647) {
      throw new RangeError('Invalid emergency refresh interval');
    }
    this.state = Object.freeze({ status: 'idle', entries: Object.freeze([]), urgent: null,
      pendingResponseIds: Object.freeze([]), issue: null, now: this.now() });
  }
  getSnapshot = (): EmergencySnapshot => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  };
  async start(): Promise<void> {
    if (this.active) { await this.work; return; }
    this.active = true;
    const generation = ++this.generation;
    this.patch({ status: 'loading', issue: null });
    // Subscribe first. Live arrivals are coalesced into one bounded batch while
    // the durable history read is in flight; they are applied after that read.
    this.unsubscribe = this.engine.subscribe(event => this.onEvent(event, generation));
    await this.enqueue(async () => {
      await this.repository.initialize(this.deviceId);
      const history = await this.engine.historyWithCustody(1_000);
      if (!this.live(generation)) return;
      await this.repository.ingest(history);
      await this.reload(generation);
    }, generation);
    if (this.live(generation)) {
      this.flush(generation);
      this.timer = setInterval(() => {
        if (!this.live(generation)) return;
        const now = this.now();
        this.patch({ now, urgent: this.state.entries.find(entry => !entry.outgoing && !entry.dismissed && entry.expiresAt > now) ?? null });
        this.flush(generation);
      }, this.refreshIntervalMs);
    }
  }
  async stop(): Promise<void> {
    this.active = false;
    this.generation += 1;
    this.unsubscribe?.(); this.unsubscribe = null;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    await this.work;
    this.patch({ status: 'idle', pendingResponseIds: Object.freeze([]), urgent: null });
  }
  refresh = async (): Promise<void> => {
    if (!this.active) { await this.start(); return; }
    const generation = this.generation;
    this.patch({ issue: null });
    await this.enqueue(async () => {
      await this.repository.initialize(this.deviceId);
      await this.repository.ingest(await this.engine.historyWithCustody(1_000));
      await this.reload(generation);
    }, generation);
    this.flush(generation);
  };
  dismiss = async (sosId: string): Promise<void> => {
    if (!this.active) return;
    const generation = this.generation;
    await this.enqueue(async () => {
      await this.repository.dismiss(sosId);
      await this.reload(generation);
      if (this.alerts) {
        try { await boundedAlert(this.alerts.cancel(sosId)); }
        catch { if (this.live(generation)) this.patch({ issue: 'notification-unavailable' }); }
      }
    }, generation);
  };
  respond = async (sosId: string): Promise<EmergencyActionResult> => {
    if (!this.active || this.state.status !== 'ready') return { status: 'rejected', reason: 'unavailable' };
    const entry = this.state.entries.find(item => item.id === sosId);
    if (!entry || entry.outgoing) return { status: 'rejected', reason: 'invalid' };
    if (entry.responseId !== null) return { status: 'queued', messageId: entry.responseId };
    if (entry.expiresAt <= this.now()) return { status: 'rejected', reason: 'expired' };
    if (this.responding.has(sosId)) return { status: 'rejected', reason: 'busy' };
    this.responding.add(sosId); this.patch({ pendingResponseIds: Object.freeze([...this.responding]), issue: null });
    const generation = this.generation;
    try {
      // This sends only a bounded response statement. The caller's GPS is never
      // included, and radio custody can never be mistaken for a human response.
      const result = await this.engine.publish({ kind: 'sos-response', destination: entry.source,
        payload: { sosId, status: 'responding' } });
      if (result.status === 'full') {
        if (this.live(generation)) this.patch({ issue: 'queue-full' });
        return { status: 'rejected', reason: 'capacity' };
      }
      await this.enqueue(async () => {
        await this.repository.ingest([{ ...result.record, peerStored: false }]);
        await this.reload(generation);
      }, generation);
      return { status: 'queued', messageId: result.record.message.id };
    } catch {
      if (this.live(generation)) this.patch({ issue: 'response-unavailable' });
      return { status: 'rejected', reason: 'unavailable' };
    } finally {
      this.responding.delete(sosId);
      if (this.live(generation)) this.patch({ pendingResponseIds: Object.freeze([...this.responding]) });
    }
  };
  dismissIssue = (): void => { this.patch({ issue: null }); };
  private onEvent(event: DtnEvent, generation: number): void {
    if (!this.live(generation) || event.type !== 'accepted'
      || (event.record.message.kind !== 'sos' && event.record.message.kind !== 'sos-response')) return;
    // Bounded memory even when an adversarial peer floods accepted events. The
    // routing database remains authoritative for recovery through refresh().
    if (!this.pending.has(event.record.message.id) && this.pending.size >= 1_000) return;
    this.pending.set(event.record.message.id, { ...event.record, peerStored: false });
    this.flush(generation);
  }
  private flush(generation: number): void {
    if (this.flushQueued || !this.live(generation) || this.pending.size === 0) return;
    this.flushQueued = true;
    void this.enqueue(async () => {
      const entries = [...this.pending.values()];
      await this.repository.ingest(entries);
      for (const entry of entries) this.pending.delete(entry.message.id);
      await this.reload(generation);
    }, generation).finally(() => {
      this.flushQueued = false;
      // Failed writes retain the bounded batch for an explicit/periodic retry;
      // an immediate recursive retry would spin while storage is unavailable.
      if (this.state.status !== 'error' && this.pending.size > 0) this.flush(generation);
    });
  }
  private async reload(generation: number): Promise<void> {
    const entries = await this.repository.read();
    if (!this.live(generation)) return;
    const now = this.now();
    this.patch({ status: 'ready', entries, urgent: entries.find(entry => !entry.outgoing && !entry.dismissed && entry.expiresAt > now) ?? null, now });
    if (!this.alerts) return;
    // Persist notification claims before invoking native code. Per-SOS claims
    // survive restart and duplicate packets; inbox state survives a missed alert.
    let notificationAttempts = 0;
    for (const entry of entries) {
      if (!this.live(generation)) return;
      if (entry.outgoing || entry.dismissed || entry.expiresAt <= now) continue;
      if (!await this.repository.claimNotification(entry.id)) continue;
      // A recovered history can contain hundreds of emergencies. Keep native
      // work bounded; every item remains visible in the durable inbox.
      if (notificationAttempts >= 4) continue;
      notificationAttempts += 1;
      try { await boundedAlert(this.alerts.notifyIncoming({ id: entry.id, source: entry.source, text: entry.text })); }
      catch { if (this.live(generation)) this.patch({ issue: 'notification-unavailable' }); }
    }
  }
  private enqueue(operation: () => Promise<void>, generation: number): Promise<void> {
    const work = this.work.then(async () => { if (this.live(generation)) await operation(); });
    this.work = work.catch(() => { if (this.live(generation)) this.patch({ status: 'error', issue: 'storage-unavailable' }); });
    return this.work;
  }
  private live(generation: number): boolean { return this.active && generation === this.generation; }
  private now(): number {
    const value = this.clock.now();
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Invalid emergency clock');
    return value;
  }
  private patch(fields: Partial<EmergencySnapshot>): void {
    this.state = Object.freeze({ ...this.state, ...fields });
    for (const listener of [...this.listeners]) { try { listener(); } catch { /* An observer cannot break the inbox. */ } }
  }
}
async function boundedAlert(action: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([action, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Native notification timed out')), 3_000);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
