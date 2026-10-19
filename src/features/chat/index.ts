// Keep the Node-testable application API free of React Native side effects.
// Mobile hosts import screens/hooks from './ui' explicitly.
export { ChatService } from './application/ChatService';
export type { ChatServiceOptions } from './application/ChatService';
export { SqliteChatRepository } from './infrastructure/SqliteChatRepository';
export { conversationFor, deliveryState, projectEntry } from './domain/messages';
export type { ProjectedChatMessage } from './domain/messages';
export type { ChatEngine, ChatMesh, ChatRepository } from './domain/ports';
export type {
  ChatActionResult, ChatDeliveryState, ChatIssue, ChatMessage, ChatSnapshot,
  Conversation, ConversationId, RoutingChatEntry,
} from './domain/types';
