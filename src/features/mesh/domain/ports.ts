import type { PeerId } from '../../dtn/domain/types';
import type { PeerRecord, RadioEvent, RadioKind, RadioLink, RadioStatus } from './types';

export interface RadioAdapter {
  readonly kind: RadioKind;
  getStatus(): Promise<RadioStatus>;
  subscribe(listener: (event: RadioEvent) => void): () => void;
  /** Start discovery and accepting inbound links. Wi-Fi Direct and BLE
   * advertising/GATT hosting must be implemented by the native adapter. */
  start(signal: AbortSignal): Promise<void>;
  stop(): Promise<void>;
  connect(endpointId: string, signal: AbortSignal): Promise<RadioLink>;
  disconnect(linkId: string): Promise<void>;
  /** Ordered, backpressured bytes. Resolve after the native write completes;
   * the mesh protocol separately awaits durable packet acknowledgments. */
  write(linkId: string, bytes: Uint8Array, signal: AbortSignal): Promise<void>;
}

export interface PeerRegistry {
  initialize(): Promise<void>;
  recordSeen(peerId: PeerId, radio: RadioKind, now: number): Promise<void>;
  recentPeers(limit: number): Promise<readonly PeerRecord[]>;
  prune(before: number): Promise<void>;
}
