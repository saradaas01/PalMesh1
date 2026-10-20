import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMessage, parseMessage } from '../src/features/dtn/domain/validation';
import type { MeshMessage } from '../src/features/dtn/domain/types';
import { conversationFor, deliveryState, projectEntry } from '../src/features/chat/domain/messages';
import type { ChatMessage, RoutingChatEntry } from '../src/features/chat/domain/types';

const LOCAL = 'local-device';
const REMOTE = 'remote-device';
const UUID = '12345678-1234-4234-8234-123456789abc';

function packet(source = REMOTE, destination = LOCAL): MeshMessage {
  return createMessage({ kind: 'chat', destination, payload: { text: 'مرحبا 🕊️' } }, UUID, source, 500);
}

function entry(message = packet()): RoutingChatEntry {
  return { message, receivedAt: 1_000, expiresAt: 2_000, peerStored: false };
}

function archived(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return { ...projectEntry(entry(packet(LOCAL, REMOTE)), LOCAL)!, sequence: 1, read: true, ...overrides };
}

test('direct incoming, direct outgoing, self and broadcast packets map to local conversations', () => {
  assert.equal(conversationFor(packet(), LOCAL), REMOTE);
  assert.equal(conversationFor(packet(LOCAL, REMOTE), LOCAL), REMOTE);
  assert.equal(conversationFor(packet(LOCAL, LOCAL), LOCAL), LOCAL);
  assert.equal(conversationFor(packet(REMOTE, '*'), LOCAL), '*');
  assert.equal(conversationFor(packet(LOCAL, '*'), LOCAL), '*');
});

test('relayed unicast, locations and malformed packets never enter chat history', () => {
  const relayed = packet(REMOTE, 'third-device');
  const location = createMessage({ kind: 'location', payload: { location: { latitude: 31.5, longitude: 34.47, timestamp: 500 } } }, UUID, REMOTE, 500);
  for (const message of [relayed, location, { ...packet(), id: 'bad' } as MeshMessage]) {
    assert.equal(conversationFor(message, LOCAL), null);
    assert.equal(projectEntry(entry(message), LOCAL), null);
  }
  assert.equal(conversationFor(packet(), 'invalid id'), null);
  assert.equal(projectEntry(entry(), 'invalid id'), null);
});

test('projection keeps canonical UUID, local arrival metadata, Arabic and emoji, and immutable SOS location', () => {
  const input = {
    version: 1, id: UUID.toUpperCase(), kind: 'sos', source: REMOTE, destination: '*', ttl: 15,
    createdAt: 9_999_999, payload: { text: 'نحتاج المساعدة 🕊️', location: { latitude: 31.5, longitude: 34.47, timestamp: 500 } },
  };
  const projection = projectEntry(entry(input as MeshMessage), LOCAL);
  assert.ok(projection);
  assert.equal(projection.id, UUID);
  assert.equal(projection.text, 'نحتاج المساعدة 🕊️');
  assert.equal(projection.receivedAt, 1_000);
  assert.equal(projection.createdAt, 9_999_999, 'sender clock does not determine local arrival order');
  assert.equal(projection.conversationId, '*');
  assert.equal(projection.outgoing, false);
  assert.equal(Object.isFrozen(projection), true);
  assert.equal(Object.isFrozen(projection.location), true);
  input.payload.location.latitude = 0;
  assert.equal(projection.location?.latitude, 31.5);
});

test('projection rejects invalid timestamps and custody metadata instead of coercing database/native values', () => {
  for (const value of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1, '1000', undefined]) {
    assert.equal(projectEntry({ ...entry(), receivedAt: value } as RoutingChatEntry, LOCAL), null);
    assert.equal(projectEntry({ ...entry(), expiresAt: value } as RoutingChatEntry, LOCAL), null);
  }
  assert.equal(projectEntry({ ...entry(), expiresAt: 999 }, LOCAL), null);
  assert.equal(projectEntry({ ...entry(), peerStored: 1 } as unknown as RoutingChatEntry, LOCAL), null);
});

test('projection rejects accessor fields without executing them and permits extra routing metadata', () => {
  let getterCalls = 0;
  const malicious = { ...entry() };
  Object.defineProperty(malicious, 'message', { enumerable: true, get() { getterCalls += 1; return packet(); } });
  assert.equal(projectEntry(malicious, LOCAL), null);
  assert.equal(getterCalls, 0);
  assert.ok(projectEntry({ ...entry(), forwardable: true } as RoutingChatEntry, LOCAL));
});

test('a local sender has queued and forwarding-ended states at the exact expiry boundary', () => {
  const message = archived();
  assert.equal(deliveryState(message, LOCAL, 1_999), 'queued');
  assert.equal(deliveryState(message, LOCAL, 2_000), 'forwarding-ended');
  assert.equal(deliveryState(message, LOCAL, 2_001), 'forwarding-ended');
});

test('peer custody remains true after forwarding ends and never claims recipient receipt', () => {
  assert.equal(deliveryState(archived({ peerStored: true }), LOCAL, 9_000), 'peer-stored');
});

test('incoming and self-addressed messages do not claim that they are queued for a network recipient', () => {
  assert.equal(deliveryState(archived({ source: REMOTE, destination: LOCAL, outgoing: false }), LOCAL, 9_000), 'received');
  assert.equal(deliveryState(archived({ destination: LOCAL }), LOCAL, 1_000), 'saved-here');
});

test('zero-hop local arrivals remain visible even when they cannot be forwarded', () => {
  const parsed = parseMessage({ ...packet(), ttl: 0 });
  assert.ok(parsed.ok);
  assert.ok(projectEntry(entry(parsed.message), LOCAL));
});
