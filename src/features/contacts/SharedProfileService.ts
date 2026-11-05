import type { DtnEngine } from '../dtn/application/DtnEngine';
import type { Clock } from '../dtn/domain/ports';
import type { MeshMessage } from '../dtn/domain/types';
import { parseMessage } from '../dtn/domain/validation';
import { utf8Encode } from '../mesh/domain/wire';
import type { SecurityService } from '../security/application/SecurityService';
import type { SecurityVault } from '../security/domain/types';
import { normalizeName } from './ContactDirectory';
import { encodeProfileAnnouncement, parseProfileAnnouncement } from './profilePayload';

const RECORD = 'profile-sharing-v1';
const FINGERPRINT = /^pm1:[0-9a-f]{64}$(?![\s\S])/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/iu;
const MAX_PEERS = 256;
const MAX_PENDING = 256;
const MAX_OPERATIONS = 16;
const BATCH_SIZE = 32;
const HOUR = 60 * 60 * 1000;
const MAX_PUBLICATIONS = 12;

export interface SharedProfilePeer {
  readonly id: string;
  readonly name: string;
  readonly revision: number;
  readonly messageId: string;
  /** Original signed sender time, not proof of a real-world update time. */
  readonly createdAt: number;
}
export interface SharedProfileSnapshot {
  readonly loaded: boolean;
  readonly sharingEnabled: boolean;
  readonly busy: boolean;
  readonly error: boolean;
  /** Includes empty-name tombstones so their revision floor is never evicted. */
  readonly peers: readonly SharedProfilePeer[];
}
export interface SharedProfileServiceOptions {
  readonly engine: Pick<DtnEngine, 'deviceId' | 'publish' | 'history' | 'subscribe'>;
  readonly security: Pick<SecurityService, 'deviceId' | 'project'>;
  readonly vault: Pick<SecurityVault, 'read' | 'write'>;
  readonly getName: () => string;
  readonly clock?: Clock;
}
interface Metadata {
  readonly sharingEnabled: boolean;
  readonly nextRevision: number;
  readonly publications: readonly number[];
  readonly peers: readonly SharedProfilePeer[];
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError('Invalid shared profile record');
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) throw new TypeError('Invalid shared profile fields');
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property || !('value' in property)) throw new TypeError('Invalid shared profile property');
    result[key] = property.value;
  }
  return result;
}
function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
function timestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Optional public names belong to authenticated fingerprints, never pins,
 * encryption addresses, saved nicknames or proof of a person's identity. */
export class SharedProfileService {
  private readonly listeners = new Set<() => void>();
  private readonly candidates = new Map<string, MeshMessage>();
  private metadata: Metadata = { sharingEnabled: false, nextRevision: 1, publications: [], peers: [] };
  private state: SharedProfileSnapshot = Object.freeze({ loaded: false, sharingEnabled: false, busy: false, error: false, peers: Object.freeze([]) });
  private active = false;
  private generation = 0;
  private loaded = false;
  private failed = false;
  private pending = 0;
  private flushScheduled = false;
  private work: Promise<void> = Promise.resolve();
  private unsubscribe: (() => void) | null = null;
  private readonly clock: Clock;

  constructor(private readonly options: SharedProfileServiceOptions) {
    if (!FINGERPRINT.test(options.engine.deviceId) || options.engine.deviceId !== options.security.deviceId) {
      throw new TypeError('Shared profile owner must match the secure routing identity');
    }
    this.clock = options.clock ?? { now: () => Date.now() };
  }

  getSnapshot = (): SharedProfileSnapshot => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  start = (): Promise<void> => {
    if (this.active) return this.work;
    this.active = true;
    const generation = ++this.generation;
    this.loaded = false;
    this.failed = false;
    // Subscribe before reading history so arrivals during vault/history reads
    // are coalesced behind the initial snapshot instead of getting lost.
    try {
      this.unsubscribe = this.options.engine.subscribe(event => {
        if (this.live(generation) && event.type === 'accepted' && !event.local) this.receive(event.record.message, generation);
      });
    } catch { this.failed = true; }
    return this.enqueue(async () => { await this.load(generation); });
  };

  stop = (): Promise<void> => {
    this.active = false;
    this.generation += 1;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.candidates.clear();
    // Serialized writes finish before a subsequent start can reload metadata.
    return this.work;
  };

  refresh = (): Promise<void> => {
    if (!this.active) return this.start();
    const generation = this.generation;
    return this.enqueue(async () => { await this.load(generation); });
  };

  setSharing = (enabled: boolean): Promise<void> => this.action(async generation => {
    if (typeof enabled !== 'boolean') throw new TypeError('Invalid profile sharing setting');
    // Consent is durable before any announcement, including the OFF decision
    // before a withdrawal. Retrying OFF explicitly retries that withdrawal.
    await this.persist({ ...this.metadata, sharingEnabled: enabled }, generation);
    await this.announce(enabled ? this.options.getName() : '', generation);
  });

  shareCurrent = (): Promise<void> => this.action(async generation => {
    if (this.metadata.sharingEnabled) await this.announce(this.options.getName(), generation);
  });

  private live(generation: number): boolean { return this.active && this.generation === generation; }

  private now(): number {
    const value = this.clock.now();
    if (!timestamp(value)) throw new RangeError('Invalid shared profile clock');
    return value;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    this.pending += 1;
    this.publishSnapshot();
    const result = this.work.then(operation);
    const completed = result.finally(() => { this.pending -= 1; this.publishSnapshot(); });
    this.work = completed.catch(() => undefined);
    return completed;
  }

  private action(operation: (generation: number) => Promise<void>): Promise<void> {
    if (!this.active || !this.loaded || this.pending >= MAX_OPERATIONS) {
      this.failed = true; this.publishSnapshot();
      return Promise.reject(new Error('Shared profiles unavailable or busy'));
    }
    const generation = this.generation;
    return this.enqueue(async () => {
      try {
        if (!this.live(generation) || !this.loaded) throw new Error('Shared profile session stopped');
        await operation(generation);
        if (this.live(generation)) this.failed = false;
      } catch (error) {
        if (this.live(generation)) this.failed = true;
        throw error;
      }
    });
  }

  private async announce(name: string, generation: number): Promise<void> {
    const revision = this.metadata.nextRevision;
    if (revision >= Number.MAX_SAFE_INTEGER) throw new RangeError('Shared profile revision exhausted');
    const text = encodeProfileAnnouncement(revision, name);
    const now = this.now();
    // Future reservations remain counted if the wall clock moves backwards.
    const publications = this.metadata.publications.filter(time => time > now - HOUR);
    if (publications.length >= MAX_PUBLICATIONS) throw new Error('Shared profile publication limit reached');
    await this.persist({ ...this.metadata, nextRevision: revision + 1, publications: [...publications, now] }, generation);
    if (!this.live(generation)) throw new Error('Shared profile session stopped');
    // Normal chat admission/retention/forwarding applies. No priority field,
    // classifier, reserved emergency slot or new wire kind is involved.
    const result = await this.options.engine.publish({ kind: 'chat', destination: '*', payload: { text } });
    if (result.status !== 'accepted') throw new Error('Shared profile announcement could not be queued');
  }

  private async persist(next: Metadata, generation: number): Promise<void> {
    if (!this.live(generation)) throw new Error('Shared profile session stopped');
    await this.options.vault.write(RECORD, JSON.stringify({ version: 1, owner: this.options.engine.deviceId, ...next }));
    this.metadata = next;
    if (this.live(generation)) this.publishSnapshot();
  }

  private readMetadata(text: string | null): Metadata {
    if (text === null) return { sharingEnabled: false, nextRevision: 1, publications: [], peers: [] };
    if (text.length > 256 * 1024 || utf8Encode(text).length > 256 * 1024) throw new TypeError('Oversized shared profile metadata');
    const value = exactRecord(JSON.parse(text) as unknown, ['version', 'owner', 'sharingEnabled', 'nextRevision', 'publications', 'peers']);
    if (value.version !== 1 || value.owner !== this.options.engine.deviceId || typeof value.sharingEnabled !== 'boolean'
      || !positiveInteger(value.nextRevision) || !Array.isArray(value.publications) || value.publications.length > MAX_PUBLICATIONS
      || value.publications.some(time => !timestamp(time)) || !Array.isArray(value.peers) || value.peers.length > MAX_PEERS) {
      throw new TypeError('Invalid shared profile metadata');
    }
    const seen = new Set<string>();
    const peers = value.peers.map((input: unknown): SharedProfilePeer => {
      const entry = exactRecord(input, ['id', 'name', 'revision', 'messageId', 'createdAt']);
      if (typeof entry.id !== 'string' || !FINGERPRINT.test(entry.id) || entry.id === value.owner || seen.has(entry.id)
        || typeof entry.name !== 'string' || normalizeName(entry.name) !== entry.name || !positiveInteger(entry.revision)
        || typeof entry.messageId !== 'string' || !UUID.test(entry.messageId) || !timestamp(entry.createdAt)) {
        throw new TypeError('Invalid shared profile binding');
      }
      seen.add(entry.id);
      return Object.freeze({ id: entry.id, name: entry.name, revision: entry.revision, messageId: entry.messageId, createdAt: entry.createdAt });
    });
    return { sharingEnabled: value.sharingEnabled, nextRevision: value.nextRevision, publications: value.publications as number[], peers };
  }

  private async load(generation: number): Promise<void> {
    try {
      const metadata = this.readMetadata(await this.options.vault.read(RECORD));
      if (!this.live(generation)) return;
      this.metadata = metadata;
      this.loaded = true;
      this.failed = this.unsubscribe === null;
      this.publishSnapshot();
    } catch {
      if (this.live(generation)) { this.loaded = false; this.failed = true; }
      return; // Optional metadata must never prevent normal messaging startup.
    }
    try {
      const history = await this.options.engine.history(1000);
      if (!Array.isArray(history) || history.length > 1000) throw new TypeError('Invalid shared profile history');
      // History is already bounded by DTN. Every candidate still gets a fresh
      // signature projection here, including retained public packets.
      for (let offset = 0; offset < history.length && this.live(generation); offset += BATCH_SIZE) {
        await this.apply(history.slice(offset, offset + BATCH_SIZE).map(record => record.message), generation);
      }
    } catch { if (this.live(generation)) this.failed = true; }
  }

  private candidate(input: unknown): MeshMessage | null {
    const parsed = parseMessage(input);
    if (!parsed.ok) return null;
    const message = parsed.message;
    if (message.kind !== 'chat' || message.destination !== '*' || message.priority !== undefined
      || !message.security || message.security.encryption || message.source === this.options.engine.deviceId
      || !FINGERPRINT.test(message.source) || !parseProfileAnnouncement(message.payload.text)) return null;
    return message;
  }

  private receive(input: unknown, generation: number): void {
    const message = this.candidate(input);
    if (!message || this.candidates.has(message.id) || this.candidates.size >= MAX_PENDING) return;
    this.candidates.set(message.id, message);
    this.scheduleFlush(generation);
  }

  private scheduleFlush(generation: number): void {
    if (this.flushScheduled || !this.live(generation)) return;
    this.flushScheduled = true;
    void this.enqueue(async () => {
      try {
        if (!this.live(generation) || !this.loaded) return;
        const batch = [...this.candidates.values()].slice(0, BATCH_SIZE);
        for (const message of batch) this.candidates.delete(message.id);
        await this.apply(batch, generation);
      } catch { if (this.live(generation)) this.failed = true; }
      finally {
        this.flushScheduled = false;
        if (this.candidates.size && this.live(generation) && this.loaded) this.scheduleFlush(generation);
      }
    });
  }

  private async apply(inputs: readonly unknown[], generation: number): Promise<void> {
    const peers = new Map(this.metadata.peers.map(peer => [peer.id, peer]));
    let changed = false;
    for (const input of inputs) {
      if (!this.live(generation)) return;
      const message = this.candidate(input);
      if (!message) continue;
      let verified: MeshMessage | null;
      try { verified = await this.options.security.project(message); }
      catch { continue; }
      if (!this.live(generation)) return;
      const projected = this.candidate(verified);
      if (!projected || projected.kind !== 'chat') continue;
      const profile = parseProfileAnnouncement(projected.payload.text);
      if (!profile) continue;
      const previous = peers.get(projected.source);
      if (previous && profile.revision <= previous.revision) continue;
      if (!previous && peers.size >= MAX_PEERS) continue; // Never evict a replay floor.
      peers.set(projected.source, Object.freeze({ id: projected.source, name: profile.name, revision: profile.revision,
        messageId: projected.id, createdAt: projected.createdAt }));
      changed = true;
    }
    if (changed) await this.persist({ ...this.metadata, peers: [...peers.values()] }, generation);
  }

  private publishSnapshot(): void {
    this.state = Object.freeze({ loaded: this.loaded, sharingEnabled: this.metadata.sharingEnabled,
      busy: this.pending > 0, error: this.failed,
      peers: Object.freeze(this.metadata.peers.map(peer => Object.freeze({ ...peer }))) });
    for (const listener of this.listeners) { try { listener(); } catch { /* A UI listener cannot invalidate durable state. */ } }
  }
}
