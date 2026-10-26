import type { Clock, IdGenerator, MeshTransport } from '../../dtn/domain/ports';
import type { MeshMessage, PeerId } from '../../dtn/domain/types';
import { isPeerId, parseMessage } from '../../dtn/domain/validation';
import type { PeerRegistry, RadioAdapter } from '../domain/ports';
import type { HandshakeSecurity } from '../../security/domain/types';
import type {
  DiscoveredEndpoint, MeshEvent, MeshReceiver, RadioEvent, RadioKind, RadioLink,
  RadioStatus, WireFrame,
} from '../domain/types';
import { DEFAULT_MAX_FRAME_BYTES, FrameDecoder, WireProtocolError, sessionFrameContent } from '../domain/wire';
import { FrameQueueFullError, FrameWriter } from './FrameWriter';
import { abortError, runBounded } from './async';

export interface MeshConfig {
  readonly maxPeers: number;
  readonly maxLinks: number;
  readonly maxDiscoveredEndpoints: number;
  readonly maxConcurrentConnections: number;
  readonly maxInboundPerLink: number;
  readonly maxInboundTotal: number;
  readonly maxPendingPerLink: number;
  readonly maxQueuedFrames: number;
  readonly reservedControlFrames: number;
  readonly maxFrameBytes: number;
  readonly maxChunkBytes: number;
  readonly handshakeTimeoutMs: number;
  readonly handshakeRetryMs: number;
  readonly maxHelloAttempts: number;
  readonly connectTimeoutMs: number;
  readonly writeTimeoutMs: number;
  readonly ackTimeoutMs: number;
  readonly discoveryRetryBaseMs: number;
  readonly discoveryRetryMaxMs: number;
  readonly endpointExpiryMs: number;
  readonly maintenanceIntervalMs: number;
  readonly peerRetentionMs: number;
  readonly peerSeenUpdateIntervalMs: number;
}

export const DEFAULT_MESH_CONFIG: Readonly<MeshConfig> = Object.freeze({
  maxPeers: 16, maxLinks: 32, maxDiscoveredEndpoints: 128, maxConcurrentConnections: 2,
  maxInboundPerLink: 4, maxInboundTotal: 32, maxPendingPerLink: 4,
  maxQueuedFrames: 16, reservedControlFrames: 4,
  maxFrameBytes: DEFAULT_MAX_FRAME_BYTES, maxChunkBytes: 8_192,
  handshakeTimeoutMs: 5_000, handshakeRetryMs: 1_000, maxHelloAttempts: 3, connectTimeoutMs: 30_000,
  writeTimeoutMs: 10_000, ackTimeoutMs: 3_000,
  discoveryRetryBaseMs: 1_000, discoveryRetryMaxMs: 30_000,
  endpointExpiryMs: 60_000, maintenanceIntervalMs: 1_000,
  peerRetentionMs: 7 * 24 * 60 * 60 * 1_000,
  peerSeenUpdateIntervalMs: 30_000,
});

export interface MeshCoordinatorOptions {
  readonly deviceId: PeerId;
  readonly radios: readonly RadioAdapter[];
  readonly registry: PeerRegistry;
  readonly ids: IdGenerator;
  readonly clock?: Clock;
  readonly config?: Partial<MeshConfig>;
  readonly security?: HandshakeSecurity;
}

interface EndpointState {
  readonly radio: RadioAdapter;
  readonly endpoint: DiscoveredEndpoint;
  lastSeenAt: number;
  attempts: number;
  nextAttemptAt: number;
  connecting: boolean;
  peerId: PeerId | undefined;
}

interface PendingTransfer {
  readonly messageId: string;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

interface Session {
  readonly key: string;
  readonly generation: number;
  readonly radio: RadioAdapter;
  readonly link: RadioLink;
  readonly nonce: string;
  readonly controller: AbortController;
  readonly decoder: FrameDecoder;
  readonly writer: FrameWriter;
  readonly pending: Map<string, PendingTransfer>;
  readonly inbound: Map<string, string>;
  readonly handshakeTimer: ReturnType<typeof setTimeout>;
  helloRetryTimer: ReturnType<typeof setInterval> | null;
  helloAttempts: number;
  remoteHello: Extract<WireFrame, { type: 'hello' }> | undefined;
  remoteAck: Extract<WireFrame, { type: 'hello-ack' }> | undefined;
  remoteReady: boolean;
  ready: boolean;
  closed: boolean;
  lastRegistryAt: number;
}

type MeshListener = (event: MeshEvent) => void | Promise<void>;

class RemoteRejection extends Error {
  constructor(readonly reason: string) { super(`Peer did not accept packet: ${reason}`); }
}

class LocalCapacityError extends Error {}

/** Radio-independent sessions. The native app supplies security to authenticate
 * nonce challenges and every subsequent frame, including durable hop ACKs. */
export class MeshCoordinator implements MeshTransport {
  readonly deviceId: PeerId;
  readonly config: Readonly<MeshConfig>;
  private readonly radios: readonly RadioAdapter[];
  private readonly registry: PeerRegistry;
  private readonly ids: IdGenerator;
  private readonly clock: Clock;
  private readonly security: HandshakeSecurity | undefined;
  private readonly listeners = new Set<MeshListener>();
  private readonly sessions = new Map<string, Session>();
  private readonly endpoints = new Map<string, EndpointState>();
  private readonly statuses = new Map<RadioKind, RadioStatus>();
  private readonly activeRadios = new Set<RadioKind>();
  private readonly radioStarts = new Map<RadioKind, { generation: number; promise: Promise<void> }>();
  private readonly radioRetries = new Map<RadioKind, { attempts: number; nextAt: number }>();
  private receiver: MeshReceiver | undefined;
  private running = false;
  private generation = 0;
  private controller = new AbortController();
  private unsubscribers: (() => void)[] = [];
  private lifecycle: Promise<void> = Promise.resolve();
  private lifecycleIntent = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private connecting = 0;
  private inboundTotal = 0;
  private lastPeers: readonly PeerId[] = [];
  private maintenanceBusy = false;

  constructor(options: MeshCoordinatorOptions) {
    if (!isPeerId(options.deviceId)) throw new TypeError('Invalid local device ID');
    if (options.radios.length === 0 || options.radios.length > 2
      || new Set(options.radios.map(radio => radio.kind)).size !== options.radios.length
      || options.radios.some(radio => radio.kind !== 'wifi-direct' && radio.kind !== 'ble')) {
      throw new RangeError('Provide one adapter per supported radio kind');
    }
    this.deviceId = options.deviceId;
    this.radios = [...options.radios];
    this.registry = options.registry;
    this.ids = options.ids;
    this.clock = options.clock ?? { now: () => Date.now() };
    this.security = options.security;
    if (this.security && this.security.deviceId !== this.deviceId) throw new TypeError('Mesh security identity mismatch');
    this.config = Object.freeze({ ...DEFAULT_MESH_CONFIG, ...options.config });
    validateConfig(this.config);
  }

  bindReceiver(receiver: MeshReceiver): void {
    if (this.running) throw new Error('Bind the DTN receiver before starting discovery');
    this.receiver = receiver;
  }

  subscribe(listener: MeshListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Permission/power failures are reported per radio. Local DTN queuing can
   * remain usable even when both radios are currently unavailable. */
  start(): Promise<void> {
    const intent = ++this.lifecycleIntent;
    return this.transition(async () => {
      if (intent !== this.lifecycleIntent) return;
      if (this.running) return;
      if (!this.receiver) throw new Error('A DTN receiver must be bound first');
      await this.registry.initialize();
      if (intent !== this.lifecycleIntent) return;
      await this.registry.prune(Math.max(0, this.now() - this.config.peerRetentionMs));
      if (intent !== this.lifecycleIntent) return;
      this.generation += 1;
      const generation = this.generation;
      this.controller = new AbortController();
      this.running = true;
      this.unsubscribers = this.radios.map(radio => radio.subscribe(event => {
        if (!this.running || this.generation !== generation) return;
        try { this.onRadioEvent(radio, event); }
        catch (error) { this.emit({ type: 'error', operation: 'radio-event', error }); }
      }));
      await Promise.all(this.radios.map(radio => this.startRadio(radio, generation)));
      if (this.running && generation === this.generation) {
        this.timer = setInterval(() => { this.maintain(); }, this.config.maintenanceIntervalMs);
        this.connectDiscovered();
      }
    });
  }

  /** Call after permission/power changes. It starts only unavailable adapters;
   * existing sessions are retained. No repeated permission prompts occur here. */
  refreshRadios(): Promise<void> {
    return this.transition(async () => {
      if (!this.running) throw new Error('Start mesh discovery first');
      await Promise.all(this.radios.filter(radio => !this.activeRadios.has(radio.kind))
        .map(radio => this.startRadio(radio, this.generation)));
      this.connectDiscovered();
    });
  }

  stop(): Promise<void> {
    // Abort native work immediately, including a start still awaiting a radio.
    this.lifecycleIntent += 1;
    this.controller.abort();
    return this.transition(async () => {
      this.running = false;
      this.generation += 1;
      this.controller.abort();
      if (this.timer !== null) clearInterval(this.timer);
      this.timer = null;
      for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
      for (const session of [...this.sessions.values()]) this.closeSession(session, abortError());
      this.endpoints.clear();
      this.activeRadios.clear();
      this.radioRetries.clear();
      this.updatePeers();
      await Promise.all(this.radios.map(async radio => {
        try {
          await runBounded(() => radio.stop(), [], this.config.connectTimeoutMs);
        } catch (error) { this.emit({ type: 'error', operation: 'radio-stop', error }); }
      }));
    });
  }

  connectedPeers(): readonly PeerId[] { return [...this.lastPeers]; }

  radioStatuses(): ReadonlyMap<RadioKind, RadioStatus> { return new Map(this.statuses); }

  /** Wi-Fi is preferred. Link/ACK failure can retry the same immutable packet
   * over BLE. The peer's durable UUID dedup makes an ACK-lost fallback safe. */
  async send(peerId: PeerId, packet: MeshMessage, signal: AbortSignal): Promise<void> {
    if (!this.running) throw new Error('Mesh discovery is not running');
    if (signal.aborted) throw abortError();
    const parsed = parseMessage(packet);
    if (!isPeerId(peerId) || !parsed.ok) throw new TypeError('Invalid peer or packet');
    const attempted = new Set<RadioKind>();
    let previous: RadioKind | undefined;
    let lastError: unknown = new Error('No handshaken link to peer');
    while (!signal.aborted && this.running) {
      const session = [...this.sessions.values()]
        .filter(candidate => candidate.ready && !candidate.closed && candidate.remoteHello?.peerId === peerId
          && !attempted.has(candidate.radio.kind))
        .sort((a, b) => radioRank(a.radio.kind) - radioRank(b.radio.kind) || a.key.localeCompare(b.key))[0];
      if (!session) break;
      attempted.add(session.radio.kind);
      if (previous) this.emit({ type: 'fallback', peerId, from: previous, to: session.radio.kind });
      try {
        await this.sendOnSession(session, parsed.message, signal);
        return;
      } catch (error) {
        lastError = error;
        if (signal.aborted) throw abortError();
        if (error instanceof WireProtocolError) throw error;
        if (error instanceof RemoteRejection && error.reason !== 'busy') throw error;
        if (!(error instanceof RemoteRejection || error instanceof LocalCapacityError || error instanceof FrameQueueFullError)) {
          this.closeSession(session, error);
        }
        previous = session.radio.kind;
      }
    }
    if (signal.aborted) throw abortError();
    throw lastError;
  }

  private startRadio(radio: RadioAdapter, generation: number): Promise<void> {
    const pending = this.radioStarts.get(radio.kind);
    if (pending?.generation === generation) return pending.promise;
    const promise = this.startRadioOnce(radio, generation).finally(() => {
      if (this.radioStarts.get(radio.kind)?.promise === promise) this.radioStarts.delete(radio.kind);
      if (this.running && generation === this.generation) {
        if (this.activeRadios.has(radio.kind)) this.radioRetries.delete(radio.kind);
        else {
          const attempts = Math.min(30, (this.radioRetries.get(radio.kind)?.attempts ?? 0) + 1);
          this.radioRetries.set(radio.kind, { attempts, nextAt: this.now() + Math.min(
            this.config.discoveryRetryMaxMs, this.config.discoveryRetryBaseMs * 2 ** (attempts - 1)) });
        }
      }
    });
    this.radioStarts.set(radio.kind, { generation, promise });
    return promise;
  }

  private async startRadioOnce(radio: RadioAdapter, generation: number): Promise<void> {
    try {
      const status = await runBounded(() => radio.getStatus(), [this.controller.signal], this.config.connectTimeoutMs);
      if (!this.running || generation !== this.generation) return;
      this.setStatus(radio.kind, status);
      if (!status.available) return;
      await runBounded(signal => radio.start(signal), [this.controller.signal], this.config.connectTimeoutMs);
      if (this.running && generation === this.generation) this.activeRadios.add(radio.kind);
    } catch (error) {
      if (this.running && generation === this.generation) {
        this.setStatus(radio.kind, { available: false, reason: 'unavailable' });
        this.emit({ type: 'error', operation: `start-${radio.kind}`, error });
      }
    }
  }

  private onRadioEvent(radio: RadioAdapter, event: RadioEvent): void {
    switch (event.type) {
      case 'discovered': this.discover(radio, event.endpoint); break;
      case 'connected': this.adoptLink(radio, event.link); break;
      case 'data': {
        const session = this.sessions.get(keyOf(radio.kind, event.linkId));
        if (!session) return;
        try {
          for (const frame of session.decoder.push(event.bytes)) {
            if (session.closed) break;
            this.onFrame(session, frame);
          }
        } catch (error) { this.closeSession(session, error); }
        break;
      }
      case 'disconnected': {
        const session = this.sessions.get(keyOf(radio.kind, event.linkId));
        if (session) this.closeSession(session, new Error('Radio link disconnected'));
        break;
      }
      case 'status':
        this.setStatus(radio.kind, event.status);
        if (!event.status.available) {
          this.activeRadios.delete(radio.kind);
          this.radioRetries.set(radio.kind, { attempts: 0, nextAt: this.now() + this.config.discoveryRetryBaseMs });
          for (const session of [...this.sessions.values()]) {
            if (session.radio === radio) this.closeSession(session, new Error('Radio unavailable'));
          }
        }
        break;
      case 'error': this.emit({ type: 'error', operation: radio.kind, error: event.error }); break;
    }
  }

  private discover(radio: RadioAdapter, endpoint: DiscoveredEndpoint): void {
    if (!opaqueId(endpoint.endpointId)) throw new TypeError('Invalid discovery endpoint');
    const key = keyOf(radio.kind, endpoint.endpointId);
    const existing = this.endpoints.get(key);
    if (existing) existing.lastSeenAt = this.now();
    else {
      if (this.endpoints.size >= this.config.maxDiscoveredEndpoints) {
        const victim = [...this.endpoints.entries()]
          .filter(([, state]) => !state.connecting && !this.hasEndpointLink(state))
          .sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt)[0];
        if (!victim) return;
        this.endpoints.delete(victim[0]);
      }
      this.endpoints.set(key, {
        radio, endpoint: { ...endpoint }, lastSeenAt: this.now(), attempts: 0,
        nextAttemptAt: 0, connecting: false, peerId: undefined,
      });
    }
    this.connectDiscovered();
  }

  private connectDiscovered(): void {
    if (!this.running || this.controller.signal.aborted) return;
    const now = this.now();
    for (const state of [...this.endpoints.values()].sort((a, b) => radioRank(a.radio.kind) - radioRank(b.radio.kind))) {
      if (this.connecting >= this.config.maxConcurrentConnections || this.sessions.size >= this.config.maxLinks) break;
      if (state.connecting || state.nextAttemptAt > now || this.hasEndpointLink(state)
        || !this.activeRadios.has(state.radio.kind)) continue;
      if (state.peerId && [...this.sessions.values()].some(session => session.ready
        && session.radio.kind === state.radio.kind && session.remoteHello?.peerId === state.peerId)) continue;
      void this.connectEndpoint(state);
    }
  }

  private async connectEndpoint(state: EndpointState): Promise<void> {
    state.connecting = true;
    this.connecting += 1;
    const generation = this.generation;
    try {
      const link = await runBounded(signal => state.radio.connect(state.endpoint.endpointId, signal),
        [this.controller.signal], this.config.connectTimeoutMs);
      if (!this.running || generation !== this.generation) {
        void state.radio.disconnect(link.id).catch(() => {});
        return;
      }
      this.adoptLink(state.radio, link);
    } catch (error) {
      if (this.running && generation === this.generation) {
        this.emit({ type: 'error', operation: 'peer-connect', error });
      }
    } finally {
      state.connecting = false;
      state.attempts = Math.min(state.attempts + 1, 30);
      state.nextAttemptAt = this.now() + Math.min(this.config.discoveryRetryMaxMs,
        this.config.discoveryRetryBaseMs * 2 ** (state.attempts - 1));
      this.connecting -= 1;
    }
  }

  private adoptLink(radio: RadioAdapter, link: RadioLink): void {
    const key = keyOf(radio.kind, link.id);
    if (this.sessions.has(key)) return;
    if (!this.running || this.sessions.size >= this.config.maxLinks || !opaqueId(link.id)
      || !opaqueId(link.endpointId) || !Number.isSafeInteger(link.maxChunkBytes)
      || link.maxChunkBytes < 1 || link.maxChunkBytes > this.config.maxChunkBytes) {
      void radio.disconnect(link.id).catch(() => {});
      return;
    }
    const controller = new AbortController();
    const nonce = this.nextId();
    const session: Session = {
      key, generation: this.generation, radio, link: { ...link }, nonce, controller,
      decoder: new FrameDecoder(this.config.maxFrameBytes, this.config.maxChunkBytes),
      writer: new FrameWriter({
        radio, link, signal: controller.signal, writeTimeoutMs: this.config.writeTimeoutMs,
        maxFrameBytes: this.config.maxFrameBytes, maxQueuedFrames: this.config.maxQueuedFrames,
        reservedControlFrames: this.config.reservedControlFrames,
        onFailure: error => { this.closeSession(session, error); },
      }),
      pending: new Map(), inbound: new Map(), remoteHello: undefined, remoteAck: undefined, remoteReady: false,
      ready: false, closed: false, lastRegistryAt: 0, helloRetryTimer: null, helloAttempts: 1,
      handshakeTimer: setTimeout(() => { this.closeSession(session, new Error('Handshake timed out')); }, this.config.handshakeTimeoutMs),
    };
    this.sessions.set(key, session);
    this.control(session, { v: 1, type: 'hello', peerId: this.deviceId, nonce });
    session.helloRetryTimer = setInterval(() => {
      if (!this.live(session) || session.remoteReady || session.helloAttempts >= this.config.maxHelloAttempts) {
        if (session.helloRetryTimer !== null) clearInterval(session.helloRetryTimer);
        session.helloRetryTimer = null;
        return;
      }
      session.helloAttempts += 1;
      this.control(session, { v: 1, type: 'hello', peerId: this.deviceId, nonce });
      if (session.ready) this.control(session, { v: 1, type: 'ready', session: session.remoteHello!.nonce });
    }, this.config.handshakeRetryMs);
  }

  private onFrame(session: Session, frame: WireFrame): void {
    if (!this.live(session)) return;
    if (this.security) {
      try {
        if (frame.type === 'hello' || frame.type === 'hello-ack') {
          this.security.verifyHandshake(frame.peerId, frame.nonce, frame.type === 'hello-ack' ? frame.echo : undefined, frame.authentication);
        } else {
          if (!session.remoteHello) throw new Error('Frame arrived before an authenticated handshake');
          this.security.verifySessionTag(session.remoteHello.peerId, session.nonce, session.remoteHello.nonce,
            sessionFrameContent(frame), frame.authenticationTag);
        }
      } catch (error) { this.closeSession(session, error); return; }
    }
    if (frame.type === 'hello') {
      if (frame.peerId === this.deviceId || (session.remoteHello &&
        (session.remoteHello.peerId !== frame.peerId || session.remoteHello.nonce !== frame.nonce))) {
        this.closeSession(session, new Error('Peer identity changed or looped to this device'));
        return;
      }
      session.remoteHello = frame;
      const endpoint = this.endpoints.get(keyOf(session.radio.kind, session.link.endpointId));
      if (endpoint) endpoint.peerId = frame.peerId;
      this.control(session, { v: 1, type: 'hello-ack', peerId: this.deviceId, nonce: session.nonce, echo: frame.nonce });
      this.finishHandshake(session);
      if (session.ready) this.control(session, { v: 1, type: 'ready', session: frame.nonce });
      return;
    }
    if (frame.type === 'hello-ack') {
      if (frame.echo !== session.nonce || frame.peerId === this.deviceId) {
        this.closeSession(session, new Error('Handshake nonce mismatch'));
        return;
      }
      if (session.remoteAck && (session.remoteAck.peerId !== frame.peerId || session.remoteAck.nonce !== frame.nonce)) {
        this.closeSession(session, new Error('Handshake identity mismatch'));
        return;
      }
      session.remoteAck = frame;
      this.finishHandshake(session);
      return;
    }
    if (!session.ready || frame.session !== session.nonce) {
      this.closeSession(session, new Error('Packet arrived without a matching ready session'));
      return;
    }
    if (frame.type === 'ready') {
      session.remoteReady = true;
      clearTimeout(session.handshakeTimer);
      if (session.helloRetryTimer !== null) clearInterval(session.helloRetryTimer);
      session.helloRetryTimer = null;
      // Closing another physical stream can overtake this stream's hello ACK.
      // Only retire duplicates once the remote confirms it has published this
      // session as ready; neither DTN engine then observes a false peer loss.
      for (const duplicate of [...this.sessions.values()]) {
        if (duplicate !== session && duplicate.ready && duplicate.radio.kind === session.radio.kind
          && duplicate.remoteHello?.peerId === session.remoteHello?.peerId
          && sessionRank(session) < sessionRank(duplicate)) {
          this.closeSession(duplicate, new Error('Replaced duplicate radio session'));
        }
      }
      return;
    }
    if (frame.type === 'ack' || frame.type === 'nack') {
      const pending = session.pending.get(frame.transferId);
      if (!pending || pending.messageId !== frame.messageId) return;
      if (frame.type === 'ack') pending.resolve();
      else pending.reject(new RemoteRejection(frame.reason));
    } else this.receivePacket(session, frame);
  }

  private finishHandshake(session: Session): void {
    const hello = session.remoteHello;
    const ack = session.remoteAck;
    if (!hello || !ack || session.ready || session.closed) return;
    if (hello.nonce !== ack.nonce || hello.peerId !== ack.peerId) {
      this.closeSession(session, new Error('Handshake identities do not agree'));
      return;
    }
    const matching = [...this.sessions.values()].filter(candidate => candidate.ready
      && candidate.remoteHello?.peerId === hello.peerId);
    if (matching.length === 0 && this.lastPeers.length >= this.config.maxPeers) {
      this.closeSession(session, new Error('Peer capacity reached'));
      return;
    }
    // Both endpoints choose the same physical connection if simultaneous
    // discovery produces duplicate links of one radio kind.
    const duplicate = matching.find(candidate => candidate.radio.kind === session.radio.kind);
    if (duplicate) {
      if (sessionRank(duplicate) < sessionRank(session)) {
        this.closeSession(session, new Error('Duplicate radio session'));
        return;
      }
      // Keep the old physical link until the remote's ready confirmation. Data
      // and that confirmation are ordered after the hello ACK on this stream.
    }
    session.ready = true;
    const endpoint = this.endpoints.get(keyOf(session.radio.kind, session.link.endpointId));
    if (endpoint) { endpoint.attempts = 0; endpoint.lastSeenAt = this.now(); }
    this.updatePeers();
    this.control(session, { v: 1, type: 'ready', session: hello.nonce });
    this.emit({ type: 'peer-ready', peerId: hello.peerId, radio: session.radio.kind });
    this.touchPeer(session, true);
  }

  private receivePacket(session: Session, frame: Extract<WireFrame, { type: 'packet' }>): void {
    const receiver = this.receiver;
    const peerId = session.remoteHello?.peerId;
    if (!receiver || !peerId) return;
    const existing = session.inbound.get(frame.transferId);
    if (existing) {
      if (existing !== frame.packet.id) this.closeSession(session, new Error('Transfer ID reused for another packet'));
      return; // The original receive() will ACK after its transaction commits.
    }
    if (session.inbound.size >= this.config.maxInboundPerLink || this.inboundTotal >= this.config.maxInboundTotal) {
      this.control(session, {
        v: 1, type: 'nack', session: session.remoteHello!.nonce,
        transferId: frame.transferId, messageId: frame.packet.id, reason: 'busy',
      });
      return;
    }
    session.inbound.set(frame.transferId, frame.packet.id);
    this.inboundTotal += 1;
    void (async () => {
      try {
        const result = await receiver.receive(peerId, frame.packet);
        if (!this.live(session)) return;
        this.touchPeer(session);
        const base = { v: 1 as const, session: session.remoteHello!.nonce, transferId: frame.transferId, messageId: frame.packet.id };
        if (result.status === 'accepted' || result.status === 'duplicate') {
          this.control(session, { ...base, type: 'ack' });
        } else this.control(session, { ...base, type: 'nack', reason: result.status === 'full' ? 'full' : 'invalid' });
      } catch (error) {
        if (!this.live(session)) return;
        this.emit({ type: 'error', operation: 'packet-storage', error });
        this.control(session, {
          v: 1, type: 'nack', session: session.remoteHello!.nonce,
          transferId: frame.transferId, messageId: frame.packet.id, reason: 'storage',
        });
      } finally {
        session.inbound.delete(frame.transferId);
        this.inboundTotal -= 1;
      }
    })();
  }

  private async sendOnSession(session: Session, packet: MeshMessage, signal: AbortSignal): Promise<void> {
    if (session.pending.size >= this.config.maxPendingPerLink) throw new LocalCapacityError('Pending transfer capacity reached');
    const transferId = this.nextId();
    let entry!: PendingTransfer;
    const ack = new Promise<void>((resolve, reject) => { entry = { messageId: packet.id, resolve, reject, timer: null }; });
    // ACK/cancellation may arrive while write() is still pending.
    void ack.catch(() => {});
    const cancel = () => { entry.reject(abortError()); };
    signal.addEventListener('abort', cancel, { once: true });
    session.pending.set(transferId, entry);
    try {
      if (signal.aborted || session.closed) throw abortError();
      const outgoing: WireFrame = {
        v: 1, type: 'packet', session: session.remoteHello!.nonce, transferId, packet,
      };
      await session.writer.send(this.protectFrame(session, outgoing), false, signal);
      // A timer scheduled after an early ACK is harmless and removed in finally.
      entry.timer = setTimeout(() => { entry.reject(new Error('Durable hop ACK timed out')); }, this.config.ackTimeoutMs);
      await ack;
      this.touchPeer(session);
    } finally {
      if (entry.timer !== null) clearTimeout(entry.timer);
      signal.removeEventListener('abort', cancel);
      session.pending.delete(transferId);
    }
  }

  private control(session: Session, frame: WireFrame): void {
    try { void session.writer.send(this.protectFrame(session, frame), true).catch(error => { this.closeSession(session, error); }); }
    catch (error) { this.closeSession(session, error); }
  }

  private protectFrame(session: Session, frame: WireFrame): WireFrame {
    if (!this.security) return frame;
    if (frame.type === 'hello' || frame.type === 'hello-ack') {
      return { ...frame, authentication: this.security.authenticate(frame.nonce, frame.type === 'hello-ack' ? frame.echo : undefined) };
    }
    if (!session.remoteHello) throw new Error('Cannot send before authenticating the remote identity');
    return { ...frame, authenticationTag: this.security.sessionTag(session.remoteHello.peerId, session.nonce,
      session.remoteHello.nonce, sessionFrameContent(frame)) };
  }

  private closeSession(session: Session, error: unknown): void {
    if (session.closed) return;
    session.closed = true;
    session.ready = false;
    clearTimeout(session.handshakeTimer);
    if (session.helloRetryTimer !== null) clearInterval(session.helloRetryTimer);
    session.helloRetryTimer = null;
    this.sessions.delete(session.key);
    const endpoint = this.endpoints.get(keyOf(session.radio.kind, session.link.endpointId));
    if (endpoint) {
      // Scan APIs can report a device only once. Keep a formerly live endpoint
      // eligible for reconnect even if the original discovery was minutes ago.
      endpoint.lastSeenAt = this.now();
      endpoint.nextAttemptAt = Math.max(endpoint.nextAttemptAt, this.now() + this.config.discoveryRetryBaseMs);
    }
    session.controller.abort();
    session.writer.close(error);
    for (const pending of session.pending.values()) {
      if (pending.timer !== null) clearTimeout(pending.timer);
      pending.reject(error);
    }
    session.pending.clear();
    session.decoder.reset();
    this.updatePeers();
    void session.radio.disconnect(session.link.id).catch(disconnectError => {
      this.emit({ type: 'error', operation: 'link-disconnect', error: disconnectError });
    });
  }

  private live(session: Session): boolean {
    return this.running && !session.closed && session.generation === this.generation
      && this.sessions.get(session.key) === session;
  }

  private hasEndpointLink(state: EndpointState): boolean {
    return [...this.sessions.values()].some(session => session.radio === state.radio
      && session.link.endpointId === state.endpoint.endpointId);
  }

  private updatePeers(): void {
    const peers = [...new Set([...this.sessions.values()]
      .filter(session => session.ready && !session.closed)
      .map(session => session.remoteHello!.peerId))].sort();
    if (peers.length === this.lastPeers.length && peers.every((peer, index) => peer === this.lastPeers[index])) return;
    this.lastPeers = Object.freeze(peers);
    try { this.receiver?.setConnectedPeers(this.lastPeers); }
    catch (error) { this.emit({ type: 'error', operation: 'peer-update', error }); }
    this.emit({ type: 'peers', peers: this.lastPeers });
  }

  private maintain(): void {
    if (!this.running) return;
    const now = this.now();
    for (const [key, state] of this.endpoints) {
      if (!state.connecting && !this.hasEndpointLink(state) && now - state.lastSeenAt >= this.config.endpointExpiryMs) {
        this.endpoints.delete(key);
      }
    }
    // Adapters may remove power listeners during teardown. Read-only polling
    // recovers them without foreground/resume events or permission prompts.
    // One bounded attempt per radio and exponential backoff prevent floods.
    for (const radio of this.radios) {
      if (this.activeRadios.has(radio.kind) || this.radioStarts.has(radio.kind)
        || this.statuses.get(radio.kind)?.reason === 'unsupported'
        || (this.radioRetries.get(radio.kind)?.nextAt ?? 0) > now) continue;
      const generation = this.generation;
      void this.startRadio(radio, generation).then(() => {
        if (this.running && generation === this.generation) this.connectDiscovered();
      });
    }
    this.connectDiscovered();
    if (!this.maintenanceBusy) {
      this.maintenanceBusy = true;
      void this.registry.prune(Math.max(0, now - this.config.peerRetentionMs))
        .catch(error => { this.emit({ type: 'error', operation: 'peer-prune', error }); })
        .finally(() => { this.maintenanceBusy = false; });
    }
  }

  private touchPeer(session: Session, force = false): void {
    const peerId = session.remoteHello?.peerId;
    const now = this.now();
    if (!peerId || (!force && now - session.lastRegistryAt < this.config.peerSeenUpdateIntervalMs)) return;
    session.lastRegistryAt = now;
    const endpoint = this.endpoints.get(keyOf(session.radio.kind, session.link.endpointId));
    if (endpoint) endpoint.lastSeenAt = now;
    void this.registry.recordSeen(peerId, session.radio.kind, now)
      .catch(error => { this.emit({ type: 'error', operation: 'peer-registry', error }); });
  }

  private setStatus(kind: RadioKind, status: RadioStatus): void {
    this.statuses.set(kind, { ...status });
    this.emit({ type: 'radio-status', radio: kind, status });
  }

  private nextId(): string {
    const value = this.ids.next();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/i.test(value)) {
      throw new TypeError('A secure UUID v4 generator is required');
    }
    return value.toLowerCase();
  }

  private now(): number {
    const value = this.clock.now();
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Invalid mesh clock timestamp');
    return value;
  }

  private transition(operation: () => Promise<void>): Promise<void> {
    const result = this.lifecycle.then(operation);
    this.lifecycle = result.catch(() => {});
    return result;
  }

  private emit(event: MeshEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        const observed = listener(event);
        if (observed) void Promise.resolve(observed).catch(() => {});
      } catch { /* A UI observer must not break discovery or packet custody. */ }
    }
  }
}

function keyOf(kind: RadioKind, id: string): string { return `${kind}:${id}`; }
function radioRank(kind: RadioKind): number { return kind === 'wifi-direct' ? 0 : 1; }
function sessionRank(session: Session): string { return [session.nonce, session.remoteHello!.nonce].sort().join(':'); }
function opaqueId(value: string): boolean { return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value); }

function validateConfig(config: MeshConfig): void {
  for (const [key, value] of Object.entries(config)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw new RangeError(`Invalid mesh configuration: ${key}`);
  }
  if (config.maxPeers > 64 || config.maxLinks > 128 || config.maxLinks < config.maxPeers
    || config.maxDiscoveredEndpoints > 1_024 || config.maxConcurrentConnections > 8
    || config.maxConcurrentConnections > config.maxLinks || config.maxPendingPerLink > 32
    || config.maxInboundPerLink > 32 || config.maxInboundTotal > 256
    || config.maxQueuedFrames > 64 || config.reservedControlFrames >= config.maxQueuedFrames
    || config.maxHelloAttempts > 8 || config.maxFrameBytes > 64 * 1_024 || config.maxChunkBytes > 8_192
    || config.discoveryRetryMaxMs < config.discoveryRetryBaseMs) {
    throw new RangeError('Inconsistent or excessive mesh configuration');
  }
}
