import type { RadioAdapter } from '../../domain/ports';
import type { RadioEvent, RadioKind, RadioLink, RadioStatus } from '../../domain/types';
import { base64ToBytes, bytesToBase64 } from '../../domain/wire';
import { abortError, ignoreFailure, isRadioId, isRadioLink, isRadioStatus, OrderedRadioWrites, RadioEvents, RadioOperations } from './shared';

/** Structural contracts allow NativeModules/NativeEventEmitter injection from
 * the mobile host without importing React Native into the application layer. */
export interface NativeRadioModule {
  getStatus(): Promise<RadioStatus>;
  start(operationId: string): Promise<void>;
  stop(): Promise<void>;
  connect(endpointId: string, operationId: string): Promise<RadioLink>;
  disconnect(linkId: string): Promise<void>;
  write(linkId: string, base64: string, operationId: string): Promise<void>;
  cancel(operationId: string): void;
}

export interface NativeEventSource {
  addListener(eventName: string, listener: (event: unknown) => void): { remove(): void };
}

let nextInstance = 0;

export class NativeStreamRadio<TKind extends RadioKind> implements RadioAdapter {
  private readonly events = new RadioEvents();
  private readonly operations: RadioOperations;
  private readonly writes = new OrderedRadioWrites();
  private readonly pendingEndpoints = new Set<string>();
  private readonly cancelledEndpoints = new Set<string>();
  private readonly links = new Map<string, RadioLink>();
  private subscription: { remove(): void } | undefined;
  private running = false;
  private generation = 0;
  private stopping: Promise<void> | undefined;
  private starting: Promise<void> | undefined;
  private stopFailed = false;

  constructor(readonly kind: TKind, private readonly native: NativeRadioModule | undefined,
    private readonly emitter: NativeEventSource | undefined, private readonly eventName: string,
    private readonly label: string, private readonly maxChunkBytes: number, options: { operationTimeoutMs?: number } = {}) {
    this.operations = new RadioOperations(`${kind}-${++nextInstance}`, options.operationTimeoutMs ?? 30_000);
  }

  getStatus(): Promise<RadioStatus> { return this.status(); }

  private async status(signal?: AbortSignal): Promise<RadioStatus> {
    if (!this.native || !this.emitter) return { available: false, reason: 'unsupported' };
    const status = await this.operations.run(signal, () => this.native!.getStatus(), () => undefined);
    if (!isRadioStatus(status)) throw new Error(`Invalid native ${this.label} status`);
    return status;
  }

  subscribe(listener: (event: RadioEvent) => void): () => void { return this.events.subscribe(listener); }

  start(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(abortError());
    if (this.stopping) return this.stopping.then(() => this.start(signal));
    if (this.starting) {
      const pending = this.starting;
      // A concurrent caller joins readiness without taking ownership of the
      // first caller's discovery lifetime or cancelling its native operation.
      return this.operations.run(signal, () => pending, () => undefined);
    }
    if (this.running) return Promise.resolve();
    const pending = this.startOnce(signal).finally(() => { if (this.starting === pending) this.starting = undefined; });
    this.starting = pending;
    return pending;
  }

  private async startOnce(signal: AbortSignal): Promise<void> {
    if (this.stopping) await this.stopping;
    if (signal.aborted) throw abortError();
    if (this.running) return;
    if (this.stopFailed) throw new Error(`Native ${this.label} teardown failed; recreate the native radio before restarting`);
    const generation = ++this.generation;
    const status = await this.status(signal);
    if (generation !== this.generation || signal.aborted) throw abortError();
    this.events.emit({ type: 'status', status });
    if (!status.available) throw new Error(`${this.label} unavailable: ${status.reason ?? 'unavailable'}`);
    this.running = true;
    let subscription: { remove(): void };
    try {
      subscription = this.emitter!.addListener(this.eventName, event => {
        if (this.running && generation === this.generation) this.onNativeEvent(event);
      });
    } catch (error) {
      if (generation === this.generation) ignoreFailure(() => this.stop());
      throw error;
    }
    if (!this.running || generation !== this.generation || signal.aborted) {
      subscription.remove();
      if (generation === this.generation) ignoreFailure(() => this.stop());
      throw abortError();
    }
    this.subscription = subscription;
    const onAbort = (): void => { if (generation === this.generation) ignoreFailure(() => this.stop()); };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      await this.operations.run(signal, id => this.native!.start(id), id => this.native!.cancel(id));
      if (!this.running || generation !== this.generation) throw abortError();
    } catch (error) {
      if (generation === this.generation) ignoreFailure(() => this.stop());
      throw error;
    } finally {
      // The discovery lifetime continues until the caller's signal is aborted,
      // including after start() resolves. stop() removes this listener below.
      if (generation === this.generation && this.running) {
        const previous = this.subscription!;
        this.subscription = { remove: () => { signal.removeEventListener('abort', onAbort); previous.remove(); } };
      } else signal.removeEventListener('abort', onAbort);
    }
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.running = false;
    ++this.generation;
    this.subscription?.remove();
    this.subscription = undefined;
    this.operations.cancelAll();
    for (const link of this.links.values()) this.events.emit({ type: 'disconnected', linkId: link.id });
    this.links.clear();
    if (!this.native) return Promise.resolve();
    const stop = this.operations.run(undefined, () => this.native!.stop(), () => undefined);
    this.stopping = stop.catch(error => { this.stopFailed = true; throw error; }).finally(() => { this.stopping = undefined; });
    return this.stopping;
  }

  async connect(endpointId: string, signal: AbortSignal): Promise<RadioLink> {
    if (!this.running) throw new Error(`${this.label} is not started`);
    if (!isRadioId(endpointId)) throw new Error(`Invalid ${this.label} endpoint`);
    if (signal.aborted) throw abortError();
    if (this.pendingEndpoints.has(endpointId) || [...this.links.values()].some(link => link.endpointId === endpointId)) throw new Error(`${this.label} endpoint already connecting or connected`);
    if (this.links.size + this.pendingEndpoints.size >= 64) throw new Error(`${this.label} connection capacity reached`);
    const generation = this.generation;
    this.pendingEndpoints.add(endpointId);
    let launched = false;
    let link: RadioLink;
    try {
      link = await this.operations.run(signal, async id => {
        launched = true;
        try { return await this.native!.connect(endpointId, id); }
        finally { this.pendingEndpoints.delete(endpointId); this.cancelledEndpoints.delete(endpointId); }
      }, id => {
        this.cancelledEndpoints.add(endpointId);
        this.native!.cancel(id);
        for (const existing of this.links.values()) if (existing.endpointId === endpointId) ignoreFailure(() => this.disconnect(existing.id));
      }, late => {
        if (isRadioLink(late)) ignoreFailure(() => this.native!.disconnect(late.id));
      });
    } catch (error) {
      if (!launched) { this.pendingEndpoints.delete(endpointId); this.cancelledEndpoints.delete(endpointId); }
      throw error;
    }
    if (!isRadioLink(link) || link.maxChunkBytes > this.maxChunkBytes || link.endpointId !== endpointId) {
      if (isRadioLink(link)) ignoreFailure(() => this.native!.disconnect(link.id));
      throw new Error(`Invalid native ${this.label} link`);
    }
    if (!this.running || this.generation !== generation || signal.aborted) {
      ignoreFailure(() => this.native!.disconnect(link.id));
      throw abortError();
    }
    this.links.set(link.id, { ...link });
    return { ...link };
  }

  async disconnect(linkId: string): Promise<void> {
    if (!isRadioId(linkId)) throw new Error(`Invalid ${this.label} link ID`);
    this.operations.cancelOwner(linkId);
    const existed = this.links.delete(linkId);
    if (existed) this.events.emit({ type: 'disconnected', linkId });
    if (this.native) await this.operations.run(undefined, () => this.native!.disconnect(linkId), () => undefined);
  }

  async write(linkId: string, bytes: Uint8Array, signal: AbortSignal): Promise<void> {
    const link = this.links.get(linkId);
    if (!this.running || !link) throw new Error(`${this.label} link is closed`);
    if (bytes.length < 1 || bytes.length > link.maxChunkBytes) throw new Error(`${this.label} chunk exceeds link limit`);
    // This only confirms an ordered native socket write, never DTN persistence.
    const payload = bytesToBase64(bytes);
    await this.operations.run(signal, (id, isActive) => this.writes.run(linkId, () => {
      if (!isActive() || !this.running || this.links.get(linkId) !== link || signal.aborted) throw abortError();
      return this.native!.write(linkId, payload, id);
    }), id => this.native!.cancel(id), undefined, linkId);
  }

  private onNativeEvent(event: unknown): void {
    try {
      if (typeof event !== 'object' || event === null) throw new Error(`Invalid native ${this.label} event`);
      const e = event as Record<string, unknown>;
      switch (e.type) {
        case 'discovered': {
          if (typeof e.endpoint !== 'object' || e.endpoint === null) throw new Error('Invalid discovered endpoint');
          const endpoint = e.endpoint as Record<string, unknown>;
          if (!isRadioId(endpoint.endpointId) || (endpoint.rssi !== undefined
            && (typeof endpoint.rssi !== 'number' || !Number.isFinite(endpoint.rssi) || endpoint.rssi < -200 || endpoint.rssi > 20))) throw new Error('Invalid discovered endpoint');
          this.events.emit({ type: 'discovered', endpoint: { endpointId: endpoint.endpointId,
            ...(typeof endpoint.rssi === 'number' ? { rssi: endpoint.rssi } : {}) } });
          return;
        }
        case 'connected': {
          if (!isRadioLink(e.link) || e.link.maxChunkBytes > this.maxChunkBytes) throw new Error('Invalid connected link');
          const link = e.link;
          if (this.cancelledEndpoints.has(link.endpointId)) { ignoreFailure(() => this.native!.disconnect(link.id)); return; }
          if (this.links.size >= 64 && !this.links.has(link.id)) {
            ignoreFailure(() => this.native!.disconnect(link.id));
            throw new Error(`${this.label} link capacity reached`);
          }
          this.links.set(e.link.id, { ...e.link });
          this.events.emit({ type: 'connected', link: { ...e.link } });
          return;
        }
        case 'data': {
          if (!isRadioId(e.linkId) || typeof e.base64 !== 'string') throw new Error('Invalid native data event');
          const link = this.links.get(e.linkId);
          if (!link) return;
          if (e.base64.length > Math.ceil(this.maxChunkBytes / 3) * 4) throw new Error('Oversized native data');
          const bytes = base64ToBytes(e.base64);
          if (bytes.length < 1 || bytes.length > link.maxChunkBytes) throw new Error('Native data exceeds link limit');
          this.events.emit({ type: 'data', linkId: e.linkId, bytes });
          return;
        }
        case 'disconnected': {
          if (!isRadioId(e.linkId)) throw new Error('Invalid disconnected link');
          this.operations.cancelOwner(e.linkId);
          if (this.links.delete(e.linkId)) this.events.emit({ type: 'disconnected', linkId: e.linkId });
          return;
        }
        case 'status':
          if (!isRadioStatus(e.status)) throw new Error('Invalid native radio status');
          this.events.emit({ type: 'status', status: e.status });
          if (!e.status.available) ignoreFailure(() => this.stop());
          return;
        case 'error':
          if (typeof e.message !== 'string' || e.message.length > 2048) throw new Error('Invalid native radio error');
          this.events.emit({ type: 'error', error: new Error(e.message) });
          return;
        default: throw new Error(`Unknown native ${this.label} event`);
      }
    } catch (error) { this.events.emit({ type: 'error', error }); }
  }
}
