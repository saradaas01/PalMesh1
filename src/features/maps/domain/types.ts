import type { LocationFix, MessageId, PeerId, PowerMode } from '../../dtn/domain/types';

export interface PeerLocation {
  readonly deviceId: PeerId;
  readonly location: LocationFix;
  /** Local first receipt of this fix; not proof of current connectivity. */
  readonly receivedAt: number;
  readonly messageId: MessageId;
  readonly origin: 'location' | 'sos';
}

export interface LocationArchive {
  readonly localLocation: LocationFix | null;
  readonly peers: readonly PeerLocation[];
}

export interface OfflineMapDescriptor {
  /** Token-protected loopback URL, never an external tile service. */
  readonly tileUrlTemplate: string;
  /** Optional bundled SDF fonts, on the same token-protected host as tiles. */
  readonly glyphUrlTemplate?: string;
  readonly bounds: readonly [number, number, number, number];
  readonly minZoom: number;
  readonly maxZoom: number;
  readonly sourceLayers: readonly string[];
  readonly attribution: string;
}

export type GpsResult =
  | { readonly status: 'fix'; readonly location: LocationFix }
  | { readonly status: 'denied' | 'unavailable' | 'cancelled' };

export type LocationIssue = 'storage-unavailable' | 'gps-denied' | 'gps-unavailable'
  | 'queue-full' | 'broadcast-unavailable' | 'routing-error';

export interface MapsSnapshot extends LocationArchive {
  readonly status: 'idle' | 'loading' | 'ready' | 'error';
  readonly mapStatus: 'loading' | 'ready' | 'unavailable';
  readonly map: OfflineMapDescriptor | null;
  readonly sharing: boolean;
  readonly powerMode: PowerMode;
  readonly locating: boolean;
  readonly pendingSos: boolean;
  readonly issue: LocationIssue | null;
  readonly notice: 'location-queued' | 'sos-queued' | null;
  readonly now: number;
}

export type LocationActionResult =
  | { readonly status: 'queued'; readonly messageId: MessageId }
  | { readonly status: 'updated' }
  | { readonly status: 'rejected'; readonly reason: 'busy' | 'unavailable' | 'capacity' | 'no-location' };
