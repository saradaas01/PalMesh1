import type { LocationFix, MeshMessage, PeerId } from '../../dtn/domain/types';

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
}

export interface Conversation {
  readonly id: ConversationId;
  readonly lastMessage: ChatMessage;
  readonly unreadCount: number;
}

export type ChatIssue = 'history-unavailable' | 'queue-full' | 'send-unavailable' | 'invalid-input' | 'routing-error';

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
}

export type ChatActionResult =
  | { readonly status: 'queued'; readonly messageId: string }
  | { readonly status: 'rejected'; readonly reason: 'empty' | 'too-long' | 'capacity' | 'unavailable' | 'busy' | 'invalid' };
