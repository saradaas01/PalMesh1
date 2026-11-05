import type { LocationFix, MeshMessage, MessagePriority, PeerId } from '../../dtn/domain/types';
import type { PriorityAssessment } from '../../ai/domain/types';

export type ConversationId = PeerId | '*';
export type ChatDeliveryState = 'received' | 'queued' | 'peer-stored' | 'forwarding-ended' | 'saved-here';

export interface RoutingChatEntry {
  readonly message: MeshMessage;
  readonly receivedAt: number;
  readonly expiresAt: number;
  readonly peerStored: boolean;
}

/** Sequence is local archive order, independent of an untrusted sender's clock. */
export interface ChatMessage {
  readonly id: string;
  readonly sequence: number;
  readonly conversationId: ConversationId;
  readonly source: PeerId;
  readonly destination: PeerId | '*';
  readonly kind: 'chat' | 'sos';
  readonly text: string;
  readonly createdAt: number;
  readonly receivedAt: number;
  readonly expiresAt: number;
  readonly outgoing: boolean;
  readonly peerStored: boolean;
  readonly read: boolean;
  readonly location?: LocationFix;
  /** Sender-signed chat priority; absent means normal. SOS has its own kind. */
  readonly priority?: MessagePriority;
}

export type UnreadUrgency = 'sos' | 'critical' | 'high';

export interface Conversation {
  readonly id: ConversationId;
  readonly lastMessage: ChatMessage;
  readonly unreadCount: number;
  /** Most urgent unread incoming message. Such conversations sort first. */
  readonly unreadUrgency?: UnreadUrgency;
}

export type ChatIssue = 'history-unavailable' | 'queue-full' | 'send-unavailable' | 'invalid-input' | 'routing-error' | 'recipient-unknown' | 'recipient-keys-unavailable' | 'sos-limited';

export interface ChatSnapshot {
  readonly status: 'idle' | 'loading' | 'ready' | 'error';
  readonly conversations: readonly Conversation[];
  readonly messages: readonly ChatMessage[];
  readonly selectedConversationId: ConversationId | null;
  readonly connectedPeers: readonly PeerId[];
  readonly draft: string;
  readonly pendingSend: boolean;
  readonly pendingSos: boolean;
  readonly hasOlderMessages: boolean;
  readonly issue: ChatIssue | null;
  readonly notice: { readonly kind: 'chat-queued' | 'sos-queued'; readonly messageId: string } | null;
  readonly now: number;
  /** On-device estimate for the current draft, or null without text/classifier. */
  readonly draftAssessment: PriorityAssessment | null;
  /** The user's explicit priority for the current draft; null follows the AI. */
  readonly priorityOverride: MessagePriority | null;
}

export type ChatActionResult =
  | { readonly status: 'queued'; readonly messageId: string }
  | { readonly status: 'rejected'; readonly reason: 'empty' | 'too-long' | 'capacity' | 'unavailable' | 'busy' | 'invalid' | 'limited' };
