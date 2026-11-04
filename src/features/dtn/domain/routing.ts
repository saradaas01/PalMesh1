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

/** Queue rank, lowest first. SOS and SOS responses always precede chat, and
 * chat priorities never borrow the SOS hop budget or reserved storage. */
export const EMERGENCY_RANK = 0;
export const NORMAL_RANK = 3;

export function priorityRank(message: MeshMessage): number {
  if (message.kind === 'sos' || message.kind === 'sos-response') return EMERGENCY_RANK;
  if (message.kind !== 'chat') return NORMAL_RANK;
  switch (message.priority) {
    case 'critical': return 1;
    case 'high': return 2;
    case 'low': return 4;
    default: return NORMAL_RANK;
  }
}
