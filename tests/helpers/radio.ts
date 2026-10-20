import type { RadioAdapter } from '../../src/features/mesh/domain/ports';
import type { RadioEvent, RadioKind, RadioLink, RadioStatus } from '../../src/features/mesh/domain/types';

/** A byte-level simulated native radio, not a production transport. Each end
 * observes its own radio link ID and radio endpoint ID, distinct from peer IDs. */
export class TestRadio implements RadioAdapter {
  private readonly listeners = new Set<(event: RadioEvent) => void>();
  private readonly links = new Map<string, { remote: TestRadio; remoteLinkId: string; link: RadioLink }>();
  private sequence = 0;
  readonly writes: { readonly linkId: string; readonly bytes: Uint8Array }[] = [];
  readonly connected: string[] = [];
  available: RadioStatus = { available: true };
  started = false;
  dropWrites = false;
  failWrites = false;
  fragmentBytes = 0;
  connectCalls = 0;

  constructor(
    readonly kind: RadioKind,
    readonly address: string,
    private readonly network: Map<string, TestRadio>,
    readonly chunkSize = kind === 'ble' ? 64 : 4_096,
  ) { network.set(`${kind}:${address}`, this); }

  async getStatus(): Promise<RadioStatus> { return this.available; }
  subscribe(listener: (event: RadioEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  async start(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error('aborted');
    this.started = true;
  }
  async stop(): Promise<void> {
    this.started = false;
    for (const id of [...this.links.keys()]) await this.disconnect(id);
  }
  discover(address: string): void { this.emit({ type: 'discovered', endpoint: { endpointId: address } }); }
  emit(event: RadioEvent): void { for (const listener of [...this.listeners]) listener(event); }

  async connect(endpointId: string, signal: AbortSignal): Promise<RadioLink> {
    this.connectCalls += 1;
    if (signal.aborted || !this.started) throw new Error('radio unavailable');
    const remote = this.network.get(`${this.kind}:${endpointId}`);
    if (!remote?.started) throw new Error('remote unavailable');
    const token = `${this.address}-${++this.sequence}`;
    const localLink = { id: `out-${token}`, endpointId, maxChunkBytes: this.chunkSize };
    const remoteLink = { id: `in-${token}`, endpointId: this.address, maxChunkBytes: remote.chunkSize };
    this.links.set(localLink.id, { remote, remoteLinkId: remoteLink.id, link: localLink });
    remote.links.set(remoteLink.id, { remote: this, remoteLinkId: localLink.id, link: remoteLink });
    this.connected.push(localLink.id);
    remote.connected.push(remoteLink.id);
    remote.emit({ type: 'connected', link: remoteLink });
    this.emit({ type: 'connected', link: localLink });
    return localLink;
  }

  async disconnect(linkId: string): Promise<void> {
    const paired = this.links.get(linkId);
    if (!paired) return;
    this.links.delete(linkId);
    paired.remote.links.delete(paired.remoteLinkId);
    this.emit({ type: 'disconnected', linkId });
    paired.remote.emit({ type: 'disconnected', linkId: paired.remoteLinkId });
  }

  async write(linkId: string, bytes: Uint8Array, signal: AbortSignal): Promise<void> {
    if (signal.aborted || this.failWrites) throw new Error('radio write failed');
    const paired = this.links.get(linkId);
    if (!paired) throw new Error('link unavailable');
    if (bytes.byteLength > this.chunkSize) throw new Error('oversized native write');
    this.writes.push({ linkId, bytes: bytes.slice() });
    await Promise.resolve();
    if (signal.aborted) throw new Error('aborted');
    if (this.dropWrites) return;
    const size = this.fragmentBytes || bytes.length;
    for (let offset = 0; offset < bytes.length; offset += size) {
      paired.remote.emit({ type: 'data', linkId: paired.remoteLinkId, bytes: bytes.slice(offset, offset + size) });
    }
  }
}
