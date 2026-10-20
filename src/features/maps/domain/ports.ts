import type { AcceptResult, DtnEvent, LocationFix, OutgoingMessage, PeerId, StoredMessage } from '../../dtn/domain/types';
import type { GpsResult, LocationArchive, OfflineMapDescriptor, PeerLocation } from './types';

export interface LocationEngine {
  readonly deviceId: PeerId;
  subscribe(listener: (event: DtnEvent) => void): () => void;
  history(limit?: number): Promise<readonly StoredMessage[]>;
  publish(input: OutgoingMessage): Promise<Exclude<AcceptResult, { readonly status: 'duplicate' }>>;
}

export interface LocationRepository {
  initialize(localDeviceId: PeerId): Promise<void>;
  saveLocal(location: LocationFix): Promise<void>;
  /** Only a strictly newer fix replaces a peer's stored report. */
  upsertPeers(peers: readonly PeerLocation[]): Promise<void>;
  read(): Promise<LocationArchive>;
}

/** Implementations must settle promptly on abort and never keep a GPS watch. */
export interface LocationSource {
  read(signal: AbortSignal): Promise<GpsResult>;
}

/** A native, read-only MBTiles host. Ownership belongs to one maps service. */
export interface OfflineMapSource {
  open(signal: AbortSignal): Promise<OfflineMapDescriptor>;
  close(): Promise<void>;
}
