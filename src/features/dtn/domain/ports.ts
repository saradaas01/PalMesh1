import type {
  AcceptResult, DeliveryCandidate, DeliveryFailure, MeshMessage, MessageId,
  PeerId, RoutingHistoryEntry, StorageLimits, StoredMessage,
} from './types';

/** accept must atomically persist the packet, seen ID, and previous-hop receipt. */
export interface DtnStore {
  initialize(): Promise<void>;
  accept(record: StoredMessage, receivedFrom: PeerId | null, limits: StorageLimits, now: number): Promise<AcceptResult>;
  getMessage(id: MessageId): Promise<StoredMessage | null>;
  listHistory(limit: number): Promise<readonly StoredMessage[]>;
  listHistoryWithCustody(limit: number): Promise<readonly RoutingHistoryEntry[]>;
  /** Due packets first: SOS before ordinary traffic, then oldest first. If none
   * are due, return the earliest future retry. Ignore expired/terminal packets,
   * source peers, acknowledged peers, and exhausted peer tracking budgets. */
  getNextDelivery(peers: readonly PeerId[], now: number, emergencyOnly: boolean, maxPeersPerMessage: number): Promise<DeliveryCandidate | null>;
  markAcknowledged(messageId: MessageId, peerId: PeerId, now: number): Promise<void>;
  markFailed(failure: DeliveryFailure): Promise<void>;
  prune(now: number): Promise<void>;
}

export interface MeshTransport {
  /** Resolve ONLY after the peer has durably accepted this UUID or acknowledged
   * a duplicate. A socket write / BLE characteristic write is not that ACK.
   * Implementations must cancel pending I/O when the signal is aborted. */
  send(peerId: PeerId, packet: MeshMessage, signal: AbortSignal): Promise<void>;
}

export interface Clock {
  now(): number;
}

/** Use a native cryptographically secure UUID v4 generator in the host app. */
export interface IdGenerator {
  next(): MessageId;
}

/** Optional for the reusable engine; required by the native application.
 * The durable routing store always receives sealed packets. Only endpoint
 * projections may expose decrypted direct-message content to application code. */
export interface PacketSecurity {
  readonly deviceId: PeerId;
  seal(message: MeshMessage): Promise<MeshMessage>;
  verify(message: MeshMessage): Promise<void>;
  project(message: MeshMessage): Promise<MeshMessage | null>;
  forNextHop(message: MeshMessage): MeshMessage | null;
}
