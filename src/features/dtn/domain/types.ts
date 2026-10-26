/** Stable, opaque device identifiers. A transport session ID is not a device ID. */
export type PeerId = string;
export type MessageId = string;
export const BROADCAST = '*' as const;
export const NORMAL_TTL = 10;
export const SOS_TTL = 15;

export interface LocationFix {
  readonly latitude: number;
  readonly longitude: number;
  readonly timestamp: number;
}

export interface ChatPayload {
  readonly text: string;
}

export interface SosPayload {
  readonly text: string;
  readonly location?: LocationFix;
}

export interface SosResponsePayload {
  readonly sosId: MessageId;
  /** A human statement of intent, never proof that help will arrive. */
  readonly status: 'responding';
}

export interface LocationPayload {
  readonly location: LocationFix;
}

/** Versioned authenticated wire metadata. Hex strings keep the domain free of
 * crypto dependencies. A mutable hash-chain proof authenticates the hop budget. */
export interface MessageSecurity {
  readonly version: 1;
  readonly signingKey: string;
  readonly encryptionKey: string;
  readonly signature: string;
  readonly initialTtl: number;
  readonly hopCommitment: string;
  readonly hopProof: string;
  readonly encryption?: { readonly recipientKey: string; readonly nonce: string };
}

interface Envelope {
  readonly version: 1;
  readonly id: MessageId;
  readonly source: PeerId;
  readonly destination: PeerId | typeof BROADCAST;
  readonly createdAt: number;
  /** Remaining network edges; decremented by the sender exactly once per hop. */
  readonly ttl: number;
  readonly security?: MessageSecurity;
}

export type MeshMessage = Envelope & (
  | { readonly kind: 'chat'; readonly payload: ChatPayload }
  | { readonly kind: 'sos'; readonly payload: SosPayload }
  | { readonly kind: 'sos-response'; readonly payload: SosResponsePayload }
  | { readonly kind: 'location'; readonly payload: LocationPayload }
);

export type OutgoingMessage =
  | { readonly kind: 'chat'; readonly destination: PeerId; readonly payload: ChatPayload }
  | { readonly kind: 'sos'; readonly payload: SosPayload }
  | { readonly kind: 'sos-response'; readonly destination: PeerId; readonly payload: SosResponsePayload }
  | { readonly kind: 'location'; readonly payload: LocationPayload };

export interface StoredMessage {
  readonly message: MeshMessage;
  /** Local arrival time, independent of an untrusted sender's clock. */
  readonly receivedAt: number;
  readonly expiresAt: number;
  readonly dedupExpiresAt: number;
  readonly forwardable: boolean;
}

/** Read-only projection of retained packets and durable hop custody. */
export interface RoutingHistoryEntry {
  readonly message: MeshMessage;
  readonly receivedAt: number;
  readonly expiresAt: number;
  readonly peerStored: boolean;
}

export interface StorageLimits {
  readonly maxMessages: number;
  readonly reservedEmergencyMessages: number;
  readonly maxSeenIds: number;
  readonly reservedEmergencySeenIds: number;
  readonly maxPeersPerMessage: number;
}

export type AcceptResult =
  | { readonly status: 'accepted'; readonly record: StoredMessage }
  | { readonly status: 'duplicate' }
  | { readonly status: 'full'; readonly resource: 'messages' | 'dedup' };

export interface DeliveryCandidate {
  readonly record: StoredMessage;
  readonly peerId: PeerId;
  readonly attempts: number;
  readonly nextAttemptAt: number;
}

export interface DeliveryFailure {
  readonly messageId: MessageId;
  readonly peerId: PeerId;
  readonly attempts: number;
  readonly nextAttemptAt: number;
  readonly now: number;
}

export type ReceiveResult = AcceptResult | { readonly status: 'invalid'; readonly reason: string };
export type PowerMode = 'normal' | 'conserve';

export type DtnEvent =
  | { readonly type: 'accepted'; readonly record: StoredMessage; readonly local: boolean }
  | { readonly type: 'duplicate'; readonly messageId: MessageId }
  | { readonly type: 'rejected'; readonly reason: string }
  | { readonly type: 'hop-acknowledged'; readonly messageId: MessageId; readonly peerId: PeerId }
  | { readonly type: 'retry-scheduled'; readonly messageId: MessageId; readonly peerId: PeerId; readonly nextAttemptAt: number }
  | { readonly type: 'error'; readonly operation: string; readonly error: unknown };
