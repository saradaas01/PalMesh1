import type { DtnEvent, OutgoingMessage, AcceptResult, PeerId } from '../../dtn/domain/types';
import type { MeshEvent } from '../../mesh/domain/types';
import type { ChatMessage, Conversation, ConversationId, RoutingChatEntry } from './types';

export interface ChatRepository {
  initialize(): Promise<void>;
  /** Archive only user-visible chat/SOS. First payload wins; custody is monotonic. */
  upsert(entries: readonly RoutingChatEntry[], localDeviceId: PeerId): Promise<void>;
  markPeerStored(messageId: string): Promise<void>;
  markRead(conversationId: ConversationId, throughSequence: number): Promise<void>;
  listConversations(): Promise<readonly Conversation[]>;
  /** Most recent limit messages, returned in ascending local sequence order. */
  listMessages(conversationId: ConversationId, limit: number): Promise<readonly ChatMessage[]>;
}

export interface ChatEngine {
  readonly deviceId: PeerId;
  subscribe(listener: (event: DtnEvent) => void): () => void;
  historyWithCustody(limit?: number): Promise<readonly RoutingChatEntry[]>;
  publish(input: OutgoingMessage): Promise<Exclude<AcceptResult, { readonly status: 'duplicate' }>>;
}

export interface ChatMesh {
  connectedPeers(): readonly PeerId[];
  subscribe(listener: (event: MeshEvent) => void): () => void;
}
