import type { MeshMessage, PeerId } from '../../dtn/domain/types';
import { isPeerId, parseMessage } from '../../dtn/domain/validation';
import type { ChatDeliveryState, ChatMessage, ConversationId, RoutingChatEntry } from './types';

export type ProjectedChatMessage = Omit<ChatMessage, 'sequence' | 'read'>;

function visibleConversation(message: MeshMessage, localDeviceId: PeerId): ConversationId | null {
  if (message.kind !== 'chat' && message.kind !== 'sos') return null;
  if (message.destination === '*') return '*';
  if (message.source === localDeviceId) return message.destination;
  if (message.destination === localDeviceId) return message.source;
  // Mesh relays carry other people's unicast packets; those are not local conversations.
  return null;
}

export function conversationFor(message: MeshMessage, localDeviceId: PeerId): ConversationId | null {
  if (!isPeerId(localDeviceId)) return null;
  const parsed = parseMessage(message);
  return parsed.ok ? visibleConversation(parsed.message, localDeviceId) : null;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Revalidate at the archive boundary; a malformed native/database record cannot
 * insert a relayed private conversation or retain a mutable payload reference. */
export function projectEntry(entry: RoutingChatEntry, localDeviceId: PeerId): ProjectedChatMessage | null {
  if (!isPeerId(localDeviceId) || entry === null || typeof entry !== 'object') return null;
  try {
    // Read data properties only, like the wire parser. Reject accessors without invoking them.
    const properties = Object.getOwnPropertyDescriptors(entry);
    const required = ['message', 'receivedAt', 'expiresAt', 'peerStored'] as const;
    if (required.some(key => !properties[key]?.enumerable || !Object.hasOwn(properties[key]!, 'value'))) return null;
    const receivedAt: unknown = properties.receivedAt!.value;
    const expiresAt: unknown = properties.expiresAt!.value;
    const peerStored: unknown = properties.peerStored!.value;
    if (!isTimestamp(receivedAt) || !isTimestamp(expiresAt) || expiresAt < receivedAt || typeof peerStored !== 'boolean') return null;
    const parsed = parseMessage(properties.message!.value);
    if (!parsed.ok || (parsed.message.kind !== 'chat' && parsed.message.kind !== 'sos')) return null;
    const message = parsed.message;
    const conversationId = visibleConversation(message, localDeviceId);
    if (conversationId === null) return null;
    return Object.freeze({
      id: message.id, conversationId, source: message.source, destination: message.destination,
      kind: message.kind, text: message.payload.text, createdAt: message.createdAt,
      receivedAt, expiresAt, outgoing: message.source === localDeviceId, peerStored,
      ...(message.kind === 'sos' && message.payload.location !== undefined ? { location: message.payload.location } : {}),
    });
  } catch {
    return null;
  }
}

/** A hop ACK establishes durable peer custody, never human receipt or reading.
 * Keep that historical fact after expiry; expiry only ends further forwarding. */
export function deliveryState(message: ChatMessage, localDeviceId: PeerId, now: number): ChatDeliveryState {
  if (message.source !== localDeviceId) return 'received';
  if (message.destination === localDeviceId) return 'saved-here';
  if (message.peerStored) return 'peer-stored';
  if (message.expiresAt <= now) return 'forwarding-ended';
  return 'queued';
}
