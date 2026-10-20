import { BROADCAST, type MeshMessage, type PeerId } from './types';

/** A unicast destination consumes the packet. Other nodes may carry it even
 * when they have no route to that destination, as required by epidemic DTN. */
export function canForward(message: MeshMessage, localId: PeerId): boolean {
  return message.ttl > 0 && message.destination !== localId;
}

/** The sender spends one hop per network edge. All peers in a fan-out receive
 * the same decremented TTL; forwarding to many peers never spends extra hops.
 * A ttl=1 packet reaches its next recipient with ttl=0 and stops there. */
export function forNextHop(message: MeshMessage): MeshMessage | null {
  if (message.ttl <= 0) return null;
  return Object.freeze({ ...message, ttl: message.ttl - 1 });
}

export function isForLocal(message: MeshMessage, localId: PeerId): boolean {
  return message.destination === BROADCAST || message.destination === localId || message.source === localId;
}
