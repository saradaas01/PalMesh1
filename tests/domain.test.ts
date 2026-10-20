import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canForward, forNextHop, isForLocal } from '../src/features/dtn/domain/routing';
import { createMessage, isPeerId, parseMessage } from '../src/features/dtn/domain/validation';
import type { MeshMessage, OutgoingMessage } from '../src/features/dtn/domain/types';

const ID = '12345678-1234-4234-8234-123456789abc';
const SOURCE = 'device:alpha';
const TARGET = 'device:beta';

function packet(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1, id: ID, source: SOURCE, destination: TARGET,
    createdAt: 1000, ttl: 10, kind: 'chat', payload: { text: 'Hello فلسطين' },
    ...overrides,
  };
}

function parsed(input: unknown): MeshMessage {
  const result = parseMessage(input);
  if (!result.ok) assert.fail(result.reason);
  return result.message;
}

test('accepts v1 packets and reconstructs canonical deeply frozen data', () => {
  const location = { latitude: 31.5, longitude: 34.47, timestamp: 999 };
  const input = packet({ id: ID.toUpperCase(), kind: 'sos', ttl: 15, payload: { text: 'Help', location } });
  const message = parsed(input);
  assert.equal(message.id, ID);
  assert.notEqual(message, input);
  assert.equal(Object.isFrozen(message), true);
  assert.equal(Object.isFrozen(message.payload), true);
  assert.equal(message.kind, 'sos');
  if (message.kind !== 'sos') return;
  assert.equal(Object.isFrozen(message.payload.location), true);
  assert.notEqual(message.payload.location, location);
  location.latitude = 0;
  input.ttl = 0;
  assert.equal(message.payload.location?.latitude, 31.5);
  assert.equal(message.ttl, 15);
});

test('uses fixed originating TTLs and broadcasts for SOS and location', () => {
  const chat = createMessage({ kind: 'chat', destination: TARGET, payload: { text: 'Hi' } }, ID, SOURCE, 50);
  const sos = createMessage({ kind: 'sos', payload: { text: 'Help' } }, ID, SOURCE, 50);
  const location = createMessage({
    kind: 'location', payload: { location: { latitude: -90, longitude: 180, timestamp: 0 } },
  }, ID, SOURCE, 50);
  assert.equal(chat.ttl, 10);
  assert.equal(chat.destination, TARGET);
  assert.equal(chat.createdAt, 50);
  assert.equal(sos.ttl, 15);
  assert.equal(sos.destination, '*');
  assert.equal(location.ttl, 10);
  assert.equal(location.destination, '*');
  assert.equal(createMessage({ kind: 'chat', destination: '*', payload: { text: 'Hi all' } }, ID, SOURCE, 0).destination, '*');
});

test('spends one hop per edge, including the final ttl=0 recipient', () => {
  const start = parsed(packet({ ttl: 2 }));
  const first = forNextHop(start);
  assert.ok(first);
  assert.equal(first.ttl, 1);
  assert.equal(start.ttl, 2);
  assert.equal(forNextHop(start)?.ttl, 1, 'fan-out to another peer has the same TTL');
  const final = forNextHop(first);
  assert.ok(final);
  assert.equal(final.ttl, 0);
  assert.equal(forNextHop(final), null);
  assert.equal(canForward(final, 'relay'), false);
  assert.equal(Object.isFrozen(final), true);
});

test('delivers broadcast, destination, and local-origin history while forwarding only eligible packets', () => {
  const direct = parsed(packet());
  assert.equal(canForward(direct, SOURCE), true);
  assert.equal(canForward(direct, 'relay'), true);
  assert.equal(canForward(direct, TARGET), false);
  assert.equal(isForLocal(direct, TARGET), true);
  assert.equal(isForLocal(direct, SOURCE), true);
  assert.equal(isForLocal(direct, 'relay'), false);
  const broadcast = parsed(packet({ destination: '*' }));
  assert.equal(isForLocal(broadcast, 'relay'), true);
  assert.equal(canForward(broadcast, 'relay'), true);
});

test('peer ids are opaque bounded ASCII identifiers with no wildcard or newline ambiguity', () => {
  for (const id of ['a', 'Device.1:b-c_d', 'a'.repeat(128)]) assert.equal(isPeerId(id), true, id);
  for (const id of ['', '*', '-peer', 'peer name', 'peer\n', 'peer\r', 'عربي', 'a'.repeat(129), 5, null]) {
    assert.equal(isPeerId(id), false, String(id));
  }
});

test('rejects malformed envelopes, UUID versions, unknown kinds, and excessive or fractional TTLs', () => {
  for (const overrides of [
    { version: 2 }, { version: '1' }, { id: 'not-a-uuid' },
    { id: ID.replace('-4234-', '-1234-') }, { id: `${ID}\n` },
    { id: ID.replace('-8234-', '-7234-') }, { source: '*' }, { source: 'peer\n' },
    { destination: '' }, { destination: {} }, { ttl: -1 }, { ttl: 11 }, { ttl: 0.5 },
    { ttl: Infinity }, { ttl: NaN }, { ttl: '10' }, { kind: 'unknown' },
    { createdAt: -1 }, { createdAt: 0.5 }, { createdAt: Infinity },
    { createdAt: Number.MAX_SAFE_INTEGER + 1 }, { extra: true },
    { kind: 'sos', ttl: 16 }, { kind: 'location', ttl: 15, payload: { location: { latitude: 0, longitude: 0, timestamp: 0 } } },
  ]) {
    assert.equal(parseMessage(packet(overrides)).ok, false, String(Object.keys(overrides)));
  }
  for (const key of Object.keys(packet())) {
    const incomplete = packet();
    delete incomplete[key];
    assert.equal(parseMessage(incomplete).ok, false, `missing ${key}`);
  }
  assert.equal(parseMessage(packet({ ttl: 0, createdAt: Number.MAX_SAFE_INTEGER })).ok, true);
});

test('rejects blank, oversized, mistyped, or unknown payload fields', () => {
  for (const payload of [null, [], {}, { text: '' }, { text: ' \n\t' }, { text: 5 },
    { text: 'x'.repeat(4097) }, { text: 'Hi', secret: 'hidden' }]) {
    assert.equal(parseMessage(packet({ payload })).ok, false);
  }
  assert.equal(parseMessage(packet({ payload: { text: 'x'.repeat(4096) } })).ok, true);
  assert.equal(parseMessage(packet({ payload: { text: ' spaces preserved ' } })).ok, true);
  assert.equal(parseMessage(packet({ kind: 'sos', payload: { text: 'Help', location: undefined } })).ok, false);
});

test('validates finite coordinate bounds and integer last-known timestamps', () => {
  const location = { latitude: 31.5, longitude: 34.47, timestamp: 0 };
  for (const overrides of [
    { latitude: -90.1 }, { latitude: 90.1 }, { latitude: NaN }, { latitude: Infinity },
    { latitude: '31' }, { longitude: -180.1 }, { longitude: 180.1 }, { longitude: -Infinity },
    { timestamp: -1 }, { timestamp: 1.2 }, { timestamp: Number.MAX_SAFE_INTEGER + 1 }, { extra: true },
  ]) {
    const fix = { ...location, ...overrides };
    assert.equal(parseMessage(packet({ kind: 'location', payload: { location: fix } })).ok, false);
    assert.equal(parseMessage(packet({ kind: 'sos', payload: { text: 'Help', location: fix } })).ok, false);
  }
  assert.equal(parseMessage(packet({ kind: 'location', payload: { location: { latitude: -90, longitude: -180, timestamp: 0 } } })).ok, true);
  assert.equal(parseMessage(packet({ kind: 'location', payload: { location: { latitude: 90, longitude: 180, timestamp: 0 } } })).ok, true);
});

test('measures canonical serialized UTF-8 bytes, including escaped and multibyte text', () => {
  for (const text of ['Hello', 'فلسطين', '😀🕊️', '\ud800', '\u0000\n', '\u0800'.repeat(100)]) {
    const input = packet({ payload: { text } });
    const message = parsed(input);
    const bytes = Buffer.byteLength(JSON.stringify(message), 'utf8');
    assert.equal(parseMessage(input, bytes).ok, true);
    assert.equal(parseMessage(input, bytes - 1).ok, false);
  }
  assert.equal(parseMessage(packet({ payload: { text: '\u0000'.repeat(4096) } })).ok, false);
  for (const limit of [0, -1, NaN, Infinity, 0.5]) assert.equal(parseMessage(packet(), limit).ok, false);
});

test('rejects accessors, executable serialization hooks, hidden fields, symbols, cycles, and exotic objects', () => {
  let executed = false;
  const getter = packet();
  Object.defineProperty(getter, 'id', { enumerable: true, get: () => { executed = true; return ID; } });
  assert.equal(parseMessage(getter).ok, false);
  assert.equal(executed, false);
  assert.equal(parseMessage(packet({ toJSON: () => { executed = true; return packet(); } })).ok, false);
  assert.equal(executed, false);
  const hidden = packet();
  Object.defineProperty(hidden, 'extra', { enumerable: false, value: 1 });
  assert.equal(parseMessage(hidden).ok, false);
  const symbol = packet();
  Object.defineProperty(symbol, Symbol('hidden'), { value: 1 });
  assert.equal(parseMessage(symbol).ok, false);
  const cycle = packet();
  cycle.payload = cycle;
  assert.equal(parseMessage(cycle).ok, false);
  for (const input of [null, undefined, [], new Date(), new Map(), 1n, 'packet', Object.create(packet())]) {
    assert.equal(parseMessage(input).ok, false);
  }
  const throwingProxy = new Proxy({}, { getPrototypeOf: () => { throw new Error('untrusted'); } });
  assert.deepEqual(parseMessage(throwingProxy), { ok: false, reason: 'Message could not be validated.' });
  assert.equal(parseMessage(Object.assign(Object.create(null), packet())).ok, true);
});

test('runtime outgoing validation prevents overriding engine-owned envelope fields', () => {
  const valid = { kind: 'chat', destination: TARGET, payload: { text: 'Hi' } } as const;
  for (const extra of [{ ttl: 100 }, { source: 'spoof' }, { id: ID }, { version: 2 }, { createdAt: 0 }]) {
    assert.throws(() => createMessage({ ...valid, ...extra } as OutgoingMessage, ID, SOURCE, 0));
  }
  assert.throws(() => createMessage({ kind: 'chat', payload: { text: 'Hi' } } as unknown as OutgoingMessage, ID, SOURCE, 0));
  assert.throws(() => createMessage({ kind: 'sos', destination: TARGET, payload: { text: 'Help' } } as unknown as OutgoingMessage, ID, SOURCE, 0));
  assert.throws(() => createMessage(valid, 'invalid-uuid', SOURCE, 0));
  assert.throws(() => createMessage(valid, ID, '*', 0));
  assert.throws(() => createMessage(valid, ID, SOURCE, -1));
  assert.throws(() => createMessage(valid, ID, SOURCE, 0, 1));
});
