import type { MeshMessage, PeerId, ReceiveResult } from '../../dtn/domain/types';
import type { HandshakeAuthentication } from '../../security/domain/types';

export type RadioKind = 'wifi-direct' | 'ble';
export const PALMESH_BLE_SERVICE = 'c62d6a00-7e41-4cc2-9d31-c7a81ef11310';
export const PALMESH_BLE_WRITE = 'c62d6a01-7e41-4cc2-9d31-c7a81ef11310';
export const PALMESH_BLE_NOTIFY = 'c62d6a02-7e41-4cc2-9d31-c7a81ef11310';

export interface RadioStatus {
  readonly available: boolean;
  readonly reason?: 'unsupported' | 'permission-denied' | 'powered-off' | 'unavailable';
}

export interface DiscoveredEndpoint {
  /** Opaque radio identifier. Never use this as the DTN device ID. */
  readonly endpointId: string;
  readonly rssi?: number;
}

export interface RadioLink {
  readonly id: string;
  readonly endpointId: string;
  /** ATT payload size (MTU - 3) for BLE, bounded socket-write size for Wi-Fi. */
  readonly maxChunkBytes: number;
}

export type RadioEvent =
  | { readonly type: 'discovered'; readonly endpoint: DiscoveredEndpoint }
  | { readonly type: 'connected'; readonly link: RadioLink }
  | { readonly type: 'data'; readonly linkId: string; readonly bytes: Uint8Array }
  | { readonly type: 'disconnected'; readonly linkId: string }
  | { readonly type: 'status'; readonly status: RadioStatus }
  | { readonly type: 'error'; readonly error: unknown };

export interface PeerRecord {
  readonly peerId: PeerId;
  readonly lastSeenAt: number;
  readonly radios: readonly RadioKind[];
}

export type WireFrame = (
  | { readonly v: 1; readonly type: 'hello'; readonly peerId: PeerId; readonly nonce: string; readonly authentication?: HandshakeAuthentication }
  | { readonly v: 1; readonly type: 'hello-ack'; readonly peerId: PeerId; readonly nonce: string; readonly echo: string; readonly authentication?: HandshakeAuthentication }
  | { readonly v: 1; readonly type: 'ready'; readonly session: string }
  | { readonly v: 1; readonly type: 'packet'; readonly session: string; readonly transferId: string; readonly packet: MeshMessage }
  | { readonly v: 1; readonly type: 'ack'; readonly session: string; readonly transferId: string; readonly messageId: string }
  | { readonly v: 1; readonly type: 'nack'; readonly session: string; readonly transferId: string; readonly messageId: string; readonly reason: 'full' | 'invalid' | 'busy' | 'storage' }
) & { readonly authenticationTag?: string };

export interface MeshReceiver {
  receive(previousHop: PeerId, packet: MeshMessage): Promise<ReceiveResult>;
  setConnectedPeers(peers: readonly PeerId[]): void;
}

export type MeshEvent =
  | { readonly type: 'peers'; readonly peers: readonly PeerId[] }
  | { readonly type: 'radio-status'; readonly radio: RadioKind; readonly status: RadioStatus }
  | { readonly type: 'peer-ready'; readonly peerId: PeerId; readonly radio: RadioKind }
  | { readonly type: 'fallback'; readonly peerId: PeerId; readonly from: RadioKind; readonly to: RadioKind }
  | { readonly type: 'error'; readonly operation: string; readonly error: unknown };
