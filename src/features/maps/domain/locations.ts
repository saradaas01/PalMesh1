import type { LocationFix, PeerId, StoredMessage } from '../../dtn/domain/types';
import { isPeerId, parseMessage } from '../../dtn/domain/validation';
import type { PeerLocation } from './types';

const DEFAULT_FUTURE_SKEW_MS = 5 * 60 * 1_000;

function timestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Native/database objects are untrusted too. Read data descriptors without
 * invoking accessors and require exactly the small location payload contract. */
export function validLocationFix(value: unknown): value is LocationFix {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 3 || keys.some(key => key !== 'latitude' && key !== 'longitude' && key !== 'timestamp')) return false;
    const fields = Object.getOwnPropertyDescriptors(value);
    if (['latitude', 'longitude', 'timestamp'].some(key => !fields[key]?.enumerable || !Object.hasOwn(fields[key]!, 'value'))) return false;
    const latitude: unknown = fields.latitude!.value;
    const longitude: unknown = fields.longitude!.value;
    const time: unknown = fields.timestamp!.value;
    return typeof latitude === 'number' && Number.isFinite(latitude) && latitude >= -90 && latitude <= 90
      && typeof longitude === 'number' && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180
      && timestamp(time);
  } catch {
    return false;
  }
}

/** Project only explicitly broadcast locations. A relay must not turn a private
 * unicast packet into a map marker. A newer sender clock is not proof of a fresh
 * report: bound skew by first local arrival as well as the current clock. */
export function projectPeerLocation(
  record: StoredMessage, localDeviceId: PeerId, now: number, maxFutureSkewMs = DEFAULT_FUTURE_SKEW_MS,
): PeerLocation | null {
  if (!isPeerId(localDeviceId) || !timestamp(now) || !timestamp(maxFutureSkewMs)
    || record === null || typeof record !== 'object') return null;
  try {
    const fields = Object.getOwnPropertyDescriptors(record);
    const required = ['message', 'receivedAt', 'expiresAt', 'dedupExpiresAt', 'forwardable'];
    if (required.some(key => !fields[key]?.enumerable || !Object.hasOwn(fields[key]!, 'value'))) return null;
    const receivedAt: unknown = fields.receivedAt!.value;
    const expiresAt: unknown = fields.expiresAt!.value;
    const dedupExpiresAt: unknown = fields.dedupExpiresAt!.value;
    if (!timestamp(receivedAt) || !timestamp(expiresAt) || !timestamp(dedupExpiresAt)
      || expiresAt < receivedAt || dedupExpiresAt < expiresAt || typeof fields.forwardable!.value !== 'boolean') return null;
    const parsed = parseMessage(fields.message!.value);
    if (!parsed.ok || parsed.message.destination !== '*' || parsed.message.source === localDeviceId) return null;
    const message = parsed.message;
    if (message.kind !== 'location' && message.kind !== 'sos') return null;
    const location = message.payload.location;
    if (!validLocationFix(location)) return null;
    // Subtraction avoids overflowing near Number.MAX_SAFE_INTEGER.
    if ((location.timestamp > now && location.timestamp - now > maxFutureSkewMs)
      || (location.timestamp > receivedAt && location.timestamp - receivedAt > maxFutureSkewMs)) return null;
    return Object.freeze({
      deviceId: message.source, location: Object.freeze({ ...location }), receivedAt,
      messageId: message.id, origin: message.kind,
    });
  } catch {
    return null;
  }
}

/** This is report age, never evidence that a peer is online or still at a fix. */
export function lastSeenLabel(receivedAt: number, now: number): string {
  if (!timestamp(receivedAt) || !timestamp(now)) throw new RangeError('Invalid last-report timestamp');
  const age = Math.max(0, now - receivedAt);
  if (age < 60_000) return 'just now';
  if (age < 3_600_000) return plural(Math.floor(age / 60_000), 'minute');
  if (age < 86_400_000) return plural(Math.floor(age / 3_600_000), 'hour');
  return plural(Math.floor(age / 86_400_000), 'day');
}

function plural(count: number, unit: string): string { return `${count} ${unit}${count === 1 ? '' : 's'} ago`; }
