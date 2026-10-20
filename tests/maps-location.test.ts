import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { lastSeenLabel, projectPeerLocation, validLocationFix } from '../src/features/maps/domain/locations';
import type { LocationFix, MeshMessage, OutgoingMessage, StoredMessage } from '../src/features/dtn/domain/types';
import { createMessage } from '../src/features/dtn/domain/validation';

const FIX: LocationFix = { latitude: 31.5, longitude: 34.4, timestamp: 1_000 };
function record(input: OutgoingMessage = { kind: 'location', payload: { location: FIX } }, source = 'bob'): StoredMessage {
  return {
    message: createMessage(input, randomUUID(), source, 1_000), receivedAt: 1_000,
    expiresAt: 11_000, dedupExpiresAt: 21_000, forwardable: true,
  };
}

test('location validation accepts geographic bounds and safe timestamp zero, rejecting nonfinite and malformed fixes', () => {
  assert.equal(validLocationFix({ latitude: -90, longitude: -180, timestamp: 0 }), true);
  assert.equal(validLocationFix({ latitude: 90, longitude: 180, timestamp: Number.MAX_SAFE_INTEGER }), true);
  for (const invalid of [null, [], {}, { ...FIX, latitude: 90.01 }, { ...FIX, latitude: NaN },
    { ...FIX, longitude: -180.01 }, { ...FIX, longitude: Infinity }, { ...FIX, timestamp: -1 },
    { ...FIX, timestamp: 1.5 }, { ...FIX, timestamp: Number.MAX_SAFE_INTEGER + 1 },
    { ...FIX, accuracy: 10 }, { ...FIX, latitude: '31.5' }]) assert.equal(validLocationFix(invalid), false);
});

test('location validation rejects getters and exotic native objects without invoking accessors', () => {
  let reads = 0;
  const getter = { ...FIX };
  Object.defineProperty(getter, 'latitude', { enumerable: true, get() { reads += 1; return 31.5; } });
  assert.equal(validLocationFix(getter), false);
  assert.equal(validLocationFix(Object.create(FIX) as unknown), false);
  assert.equal(validLocationFix(new Date()), false);
  assert.equal(reads, 0);
});

test('projects only broadcast location and SOS fixes with explicit source provenance', () => {
  const location = projectPeerLocation(record(), 'alice', 2_000);
  assert.deepEqual(location?.location, FIX);
  assert.equal(location?.deviceId, 'bob');
  assert.equal(location?.origin, 'location');
  assert.equal(location?.receivedAt, 1_000);
  const sos = projectPeerLocation(record({ kind: 'sos', payload: { text: 'Help', location: FIX } }), 'alice', 2_000);
  assert.equal(sos?.origin, 'sos');
  assert.equal(projectPeerLocation(record({ kind: 'sos', payload: { text: 'No fix' } }), 'alice', 2_000), null);
  assert.equal(projectPeerLocation(record({ kind: 'chat', destination: '*', payload: { text: 'Not a location' } }), 'alice', 2_000), null);
  assert.equal(projectPeerLocation(record(undefined, 'alice'), 'alice', 2_000), null);
  const privatePacket = record();
  assert.equal(projectPeerLocation({ ...privatePacket, message: { ...privatePacket.message, destination: 'carol' } }, 'alice', 2_000), null);
});

test('preserves old last-known fixes even after routing expiry while rejecting invalid local metadata and UUIDs', () => {
  const input = record();
  assert.ok(projectPeerLocation(input, 'alice', 100_000));
  for (const invalid of [
    { ...input, receivedAt: -1 }, { ...input, receivedAt: 1.1 }, { ...input, expiresAt: 999 },
    { ...input, dedupExpiresAt: 10_000 }, { ...input, expiresAt: NaN },
    { ...input, message: { ...input.message, id: 'not-a-uuid' } },
    { ...input, message: { ...input.message, source: 'invalid source' } },
  ]) assert.equal(projectPeerLocation(invalid, 'alice', 100_000), null);
  assert.equal(projectPeerLocation(input, 'invalid local ID', 1_000), null);
  assert.equal(projectPeerLocation(input, 'alice', -1), null);
});

test('bounds future GPS clocks against both now and first local receipt, including exact skew boundary', () => {
  const withTime = (timestamp: number) => record({ kind: 'location', payload: { location: { ...FIX, timestamp } } });
  assert.ok(projectPeerLocation(withTime(301_000), 'alice', 1_000));
  assert.equal(projectPeerLocation(withTime(301_001), 'alice', 1_000), null);
  // A long-held snapshot must not legitimize a fix that was far in the future
  // at its original local arrival, even when today's clock has caught up.
  assert.equal(projectPeerLocation(withTime(400_000), 'alice', 1_000_000), null);
  assert.ok(projectPeerLocation(withTime(1_000), 'alice', 1_000, 0));
  assert.equal(projectPeerLocation(withTime(1_001), 'alice', 1_000, 0), null);
  assert.equal(projectPeerLocation(withTime(1_000), 'alice', 1_000, -1), null);
});

test('creates immutable independent marker snapshots and canonical message identifiers', () => {
  const location = { ...FIX };
  const original = record();
  const message: MeshMessage = { ...original.message, kind: 'location', id: original.message.id.toUpperCase(), payload: { location } };
  const projected = projectPeerLocation({ ...original, message }, 'alice', 1_000)!;
  location.latitude = 0;
  assert.equal(projected.location.latitude, 31.5);
  assert.equal(projected.messageId, original.message.id.toLowerCase());
  assert.equal(Object.isFrozen(projected), true);
  assert.equal(Object.isFrozen(projected.location), true);
});

test('rejects accessor-backed routing metadata without executing it', () => {
  let reads = 0;
  const input = record();
  Object.defineProperty(input, 'receivedAt', { enumerable: true, get() { reads += 1; return 1_000; } });
  assert.equal(projectPeerLocation(input, 'alice', 1_000), null);
  assert.equal(reads, 0);
});

test('formats report age with boundary-aware singular units and clamps future receipts', () => {
  const now = 10 * 86_400_000;
  const cases: readonly [number, string][] = [
    [-1_000, 'just now'], [0, 'just now'], [59_999, 'just now'], [60_000, '1 minute ago'],
    [120_000, '2 minutes ago'], [3_600_000, '1 hour ago'], [7_200_000, '2 hours ago'],
    [86_400_000, '1 day ago'], [3 * 86_400_000, '3 days ago'],
  ];
  for (const [age, label] of cases) assert.equal(lastSeenLabel(now - age, now), label);
  assert.throws(() => lastSeenLabel(-1, now), RangeError);
  assert.throws(() => lastSeenLabel(0, NaN), RangeError);
});
