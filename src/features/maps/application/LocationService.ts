import type { Clock } from '../../dtn/domain/ports';
import type { DtnEvent, LocationFix, PeerId, PowerMode, StoredMessage } from '../../dtn/domain/types';
import { isPeerId, parseMessage } from '../../dtn/domain/validation';
import type { LocationEngine, LocationRepository, LocationSource, OfflineMapSource } from '../domain/ports';
import { projectPeerLocation, validLocationFix } from '../domain/locations';
import { validateOfflineMapDescriptor } from '../domain/offlineMap';
import type { LocationActionResult, MapsSnapshot, PeerLocation } from '../domain/types';

export interface LocationServiceOptions {
  readonly engine: LocationEngine;
  readonly repository: LocationRepository;
  readonly source: LocationSource;
  readonly mapSource?: OfflineMapSource;
  readonly clock?: Clock;
  readonly broadcastIntervalMs?: number;
  readonly refreshIntervalMs?: number;
  readonly sosText?: string;
}

/** GPS sharing is explicit, foreground-only, and independent of tile availability.
 * The routing DB remains authoritative for queuing; an archive failure never
 * delays SOS. One runtime owns this service and its native map source. */
export class LocationService {
  readonly deviceId: PeerId;
  private readonly engine: LocationEngine;
  private readonly repository: LocationRepository;
  private readonly source: LocationSource;
  private readonly mapSource: OfflineMapSource | undefined;
  private readonly clock: Clock;
  private readonly broadcastIntervalMs: number;
  private readonly refreshIntervalMs: number;
  private readonly sosText: string;
  private readonly listeners = new Set<() => void>();
  private readonly pendingPeers = new Map<PeerId, PeerLocation>();
  private pendingLocal: LocationFix | null = null;
  private state: MapsSnapshot;
  private active = false;
  private visible = true;
  private generation = 0;
  private initialized = false;
  private archiveScheduled = false;
  private archiveFailed = false;
  private unsubscribe: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private gps: AbortController | null = null;
  private maps: AbortController | null = null;
  private mapOpening = false;
  private nextBroadcastAt = 0;
  private lifecycleIntent = 0;
  private lifecycle: Promise<void> = Promise.resolve();
  private work: Promise<void> = Promise.resolve();

  constructor(options: LocationServiceOptions) {
    if (!isPeerId(options.engine.deviceId)) throw new TypeError('Invalid local location identity');
    this.deviceId = options.engine.deviceId;
    this.engine = options.engine;
    this.repository = options.repository;
    this.source = options.source;
    this.mapSource = options.mapSource;
    this.clock = options.clock ?? { now: () => Date.now() };
    this.broadcastIntervalMs = options.broadcastIntervalMs ?? 60_000;
    this.refreshIntervalMs = options.refreshIntervalMs ?? 30_000;
    this.sosText = options.sosText ?? 'I need help';
    for (const interval of [this.broadcastIntervalMs, this.refreshIntervalMs]) {
      if (!Number.isSafeInteger(interval) || interval < 1_000 || interval > 2_147_483_647) throw new RangeError('Invalid location interval');
    }
    if (typeof this.sosText !== 'string' || !this.sosText.trim() || this.sosText.length > 4_096) throw new RangeError('Invalid SOS text');
    this.state = Object.freeze({
      status: 'idle', mapStatus: 'unavailable', map: null, localLocation: null,
      peers: Object.freeze([]), sharing: false, powerMode: 'normal', locating: false,
      pendingSos: false, issue: null, notice: null, now: this.now(),
    });
  }

  getSnapshot = (): MapsSnapshot => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  start(): Promise<void> {
    const intent = ++this.lifecycleIntent;
    return this.transition(async () => {
      if (this.active || intent !== this.lifecycleIntent) return;
      this.active = true;
      this.archiveFailed = false;
      const generation = ++this.generation;
      this.patch({ status: 'loading', sharing: false, issue: null });
      // Enqueue initialization first, but subscribe before its first history
      // read. Incoming reports are coalesced behind that snapshot, not lost.
      const initial = this.enqueue(() => this.synchronize(generation), generation);
      this.attach(generation);
      void this.openMap(generation);
      await initial;
      if (!this.live(generation)) return;
      this.timer = setInterval(() => {
        if (!this.live(generation)) return;
        this.patch({ now: this.now() });
        this.archiveFailed = false;
        if (!this.initialized || this.unsubscribe === null) void this.refresh();
        else this.flushArchive(generation);
        if (this.state.sharing && this.visible && this.state.powerMode === 'normal'
          && this.now() >= this.nextBroadcastAt) void this.capture(true, true);
      }, Math.min(this.broadcastIntervalMs, this.refreshIntervalMs));
    });
  }

  stop(): Promise<void> {
    this.lifecycleIntent += 1;
    this.active = false;
    this.generation += 1;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.cancelGps();
    this.maps?.abort();
    this.maps = null;
    this.mapOpening = false;
    this.detach();
    this.patch({ status: 'idle', sharing: false, locating: false, pendingSos: false, mapStatus: 'unavailable', map: null });
    const close = this.mapSource?.close().catch(() => {}) ?? Promise.resolve();
    return this.transition(async () => { await this.work; await close; });
  }

  setVisible = (visible: boolean): void => {
    if (typeof visible !== 'boolean') throw new TypeError('Invalid location visibility');
    this.visible = visible;
    if (!visible) this.cancelGps();
    // Resuming does not override the configured broadcast cadence.
  };

  setPowerMode = (powerMode: PowerMode): void => {
    if (powerMode !== 'normal' && powerMode !== 'conserve') throw new TypeError('Invalid location power mode');
    this.patch({ powerMode });
    if (powerMode === 'conserve') this.cancelGps();
  };

  setSharing = async (sharing: boolean): Promise<void> => {
    if (typeof sharing !== 'boolean') throw new TypeError('Invalid location sharing setting');
    if (!this.active || sharing === this.state.sharing) return;
    this.patch({ sharing, notice: null });
    if (!sharing) { this.cancelGps(); return; }
    if (this.visible && this.state.powerMode === 'normal') await this.capture(true, true);
  };

  refresh = async (): Promise<void> => {
    if (!this.active) { await this.start(); return; }
    const generation = this.generation;
    this.archiveFailed = false;
    this.patch({ issue: null });
    if (this.unsubscribe === null) this.attach(generation);
    if (this.state.mapStatus !== 'ready') void this.openMap(generation);
    await this.enqueue(() => this.synchronize(generation), generation);
  };

  refreshLocal = (): Promise<LocationActionResult> => this.capture(false, false);
  shareOnce = (): Promise<LocationActionResult> => this.capture(true, false);
  dismissIssue = (): void => { this.patch({ issue: null }); };
  dismissNotice = (): void => { this.patch({ notice: null }); };

  sendSos = async (text = this.sosText): Promise<LocationActionResult> => {
    if (!this.active) {
      this.patch({ issue: 'broadcast-unavailable' });
      return { status: 'rejected', reason: 'unavailable' };
    }
    if (this.state.pendingSos) return { status: 'rejected', reason: 'busy' };
    const generation = this.generation;
    this.patch({ pendingSos: true, issue: null, notice: null });
    try {
      // Use the timestamped last-known fix. Never wait for GPS, tiles, or the
      // separate location archive before queuing a priority-15-hop SOS.
      const location = this.state.localLocation;
      const result = await this.engine.publish({ kind: 'sos', payload: {
        text, ...(location && this.safeLocal(location) ? { location } : {}),
      } });
      if (result.status === 'full') {
        if (this.live(generation)) this.patch({ issue: 'queue-full' });
        return { status: 'rejected', reason: 'capacity' };
      }
      if (this.live(generation)) this.patch({ notice: 'sos-queued' });
      return { status: 'queued', messageId: result.record.message.id };
    } catch {
      if (this.live(generation)) this.patch({ issue: 'broadcast-unavailable' });
      return { status: 'rejected', reason: 'unavailable' };
    } finally {
      if (this.live(generation)) this.patch({ pendingSos: false });
    }
  };

  private async capture(broadcast: boolean, automatic: boolean): Promise<LocationActionResult> {
    if (!this.active || !this.visible) return { status: 'rejected', reason: 'unavailable' };
    if (this.gps !== null) return { status: 'rejected', reason: 'busy' };
    if (automatic && (!this.state.sharing || this.state.powerMode === 'conserve' || this.now() < this.nextBroadcastAt)) {
      return { status: 'rejected', reason: 'busy' };
    }
    const generation = this.generation;
    const controller = new AbortController();
    this.gps = controller;
    if (broadcast) this.nextBroadcastAt = this.now() + this.broadcastIntervalMs;
    this.patch({ locating: true, issue: null, notice: null });
    try {
      const result = await this.source.read(controller.signal);
      if (!this.live(generation) || controller.signal.aborted || !this.visible) return { status: 'rejected', reason: 'unavailable' };
      if (result.status !== 'fix' || !this.safeLocal(result.location)) {
        if (result.status !== 'cancelled') this.patch({ issue: result.status === 'denied' ? 'gps-denied' : 'gps-unavailable' });
        return { status: 'rejected', reason: 'no-location' };
      }
      const fix = Object.freeze({ ...result.location });
      const current = this.state.localLocation;
      if (current === null || fix.timestamp > current.timestamp) {
        this.patch({ localLocation: fix, now: this.now() });
        this.pendingLocal = fix;
        this.flushArchive(generation);
      }
      if (!broadcast) return { status: 'updated' };
      // A disabled sharing toggle cancels automatic work; explicit one-off
      // sharing remains usable in conservation mode when the user requests it.
      if (automatic && (!this.state.sharing || this.state.powerMode !== 'normal')) return { status: 'rejected', reason: 'unavailable' };
      const accepted = await this.engine.publish({ kind: 'location', payload: { location: this.state.localLocation ?? fix } });
      if (accepted.status === 'full') {
        if (this.live(generation)) this.patch({ issue: 'queue-full' });
        return { status: 'rejected', reason: 'capacity' };
      }
      if (this.live(generation)) this.patch({ notice: 'location-queued' });
      return { status: 'queued', messageId: accepted.record.message.id };
    } catch {
      if (this.live(generation) && !controller.signal.aborted) this.patch({ issue: broadcast ? 'broadcast-unavailable' : 'gps-unavailable' });
      return { status: 'rejected', reason: 'unavailable' };
    } finally {
      if (this.gps === controller) {
        this.gps = null;
        if (this.live(generation)) this.patch({ locating: false });
      }
    }
  }

  private async synchronize(generation: number): Promise<void> {
    await this.repository.initialize(this.deviceId);
    if (!this.live(generation)) return;
    this.initialized = true;
    await this.reload(generation);
    const records = await this.engine.history(1_000);
    if (!this.live(generation)) return;
    for (const record of records) this.acceptRecord(record, generation);
    this.flushArchive(generation);
  }

  private acceptRecord(record: StoredMessage, generation: number): void {
    const now = this.now();
    const peer = projectPeerLocation(record, this.deviceId, now);
    if (peer) {
      const previous = this.pendingPeers.get(peer.deviceId);
      if (!previous || peer.location.timestamp > previous.location.timestamp) {
        if (previous || this.pendingPeers.size < 1_000) this.pendingPeers.set(peer.deviceId, peer);
        else this.patch({ issue: 'storage-unavailable' });
      }
    } else {
      const parsed = parseMessage(record.message);
      if (parsed.ok && parsed.message.source === this.deviceId && parsed.message.destination === '*') {
        const location = parsed.message.kind === 'location' || parsed.message.kind === 'sos' ? parsed.message.payload.location : undefined;
        if (location && this.safeLocal(location) && (!this.state.localLocation || location.timestamp > this.state.localLocation.timestamp)) {
          this.pendingLocal = location;
          this.patch({ localLocation: location });
        }
      }
    }
    this.flushArchive(generation);
  }

  private flushArchive(generation: number): void {
    if (!this.live(generation) || this.archiveScheduled || this.archiveFailed || (!this.pendingPeers.size && this.pendingLocal === null)) return;
    this.archiveScheduled = true;
    void this.enqueue(async () => {
      let completed = false;
      try {
        if (!this.initialized) return;
        const local = this.pendingLocal;
        const peers = [...this.pendingPeers.values()].slice(0, 100);
        if (local) await this.repository.saveLocal(local);
        if (peers.length) await this.repository.upsertPeers(peers);
        if (this.pendingLocal === local) this.pendingLocal = null;
        for (const peer of peers) if (this.pendingPeers.get(peer.deviceId) === peer) this.pendingPeers.delete(peer.deviceId);
        await this.reload(generation);
        completed = true;
      } catch (error) { this.archiveFailed = true; throw error; }
      finally {
        this.archiveScheduled = false;
        if (completed) this.flushArchive(generation);
      }
    }, generation).then(() => { if (!this.live(generation)) this.archiveScheduled = false; });
  }

  private async reload(generation: number): Promise<void> {
    const archive = await this.repository.read();
    if (!this.live(generation)) return;
    const stored = archive.localLocation;
    const current = this.state.localLocation;
    const localLocation = stored && this.safeLocal(stored) && (!current || stored.timestamp > current.timestamp) ? stored : current;
    this.patch({
      localLocation, peers: Object.freeze([...archive.peers]),
      status: this.unsubscribe === null ? 'error' : 'ready', now: this.now(),
      ...(this.unsubscribe === null ? { issue: 'storage-unavailable' as const }
        : this.state.issue === 'storage-unavailable' ? { issue: null } : {}),
    });
  }

  private async openMap(generation: number): Promise<void> {
    if (!this.mapSource || this.mapOpening || !this.live(generation)) return;
    this.mapOpening = true;
    const controller = new AbortController();
    this.maps = controller;
    this.patch({ mapStatus: 'loading', map: null });
    try {
      const map = validateOfflineMapDescriptor(await this.mapSource.open(controller.signal));
      if (this.live(generation) && !controller.signal.aborted) this.patch({ mapStatus: 'ready', map });
    } catch {
      if (this.live(generation)) this.patch({ mapStatus: 'unavailable', map: null });
    } finally {
      if (this.maps === controller) { this.maps = null; this.mapOpening = false; }
    }
  }

  private attach(generation: number): void {
    this.detach();
    try {
      this.unsubscribe = this.engine.subscribe((event: DtnEvent) => {
        if (!this.live(generation)) return;
        if (event.type === 'accepted') this.acceptRecord(event.record, generation);
        else if (event.type === 'error') this.patch({ issue: 'routing-error' });
      });
    } catch { this.patch({ status: 'error', issue: 'storage-unavailable' }); }
  }

  private detach(): void {
    try { this.unsubscribe?.(); } catch { /* Generation guards reject stale callbacks. */ }
    this.unsubscribe = null;
  }

  private cancelGps(): void {
    this.gps?.abort();
    this.gps = null;
    if (this.state.locating) this.patch({ locating: false });
  }
  private safeLocal(location: unknown): location is LocationFix {
    return validLocationFix(location) && location.timestamp <= this.now() + 300_000;
  }
  private live(generation: number): boolean { return this.active && this.generation === generation; }
  private now(): number {
    const now = this.clock.now();
    if (!Number.isSafeInteger(now) || now < 0) throw new RangeError('Invalid location clock');
    return now;
  }
  private enqueue(operation: () => Promise<void>, generation = this.generation): Promise<void> {
    const next = this.work.then(async () => { if (this.live(generation)) await operation(); });
    this.work = next.catch(() => {
      if (this.live(generation)) this.patch({ issue: 'storage-unavailable', status: this.initialized ? 'ready' : 'error' });
    });
    return this.work;
  }
  private transition(operation: () => Promise<void>): Promise<void> {
    const next = this.lifecycle.then(operation);
    this.lifecycle = next.catch(() => {});
    return next;
  }
  private patch(patch: Partial<MapsSnapshot>): void {
    this.state = Object.freeze({ ...this.state, ...patch });
    for (const listener of [...this.listeners]) { try { listener(); } catch { /* UI cannot block location handling. */ } }
  }
}
