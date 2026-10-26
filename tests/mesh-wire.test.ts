import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMessage } from '../src/features/dtn/domain/validation';
import type { WireFrame } from '../src/features/mesh/domain/types';
import {
  base64ToBytes, bytesToBase64, DEFAULT_MAX_FRAME_BYTES, encodeFrame, FrameDecoder,
  utf8Decode, utf8Encode, WireProtocolError,
} from '../src/features/mesh/domain/wire';

const NONCE = '00000000-0000-4000-8000-000000000001';
const TRANSFER = '00000000-0000-4000-8000-000000000002';
const MESSAGE = '00000000-0000-4000-8000-000000000003';
const HELLO: WireFrame = { v: 1, type: 'hello', peerId: 'device:alpha', nonce: NONCE };
const ACK: WireFrame = { v: 1, type: 'ack', session: NONCE, transferId: TRANSFER, messageId: MESSAGE };

function rawBody(bytes: Uint8Array): Uint8Array {
  const encoded = new Uint8Array(bytes.length + 4);
  new DataView(encoded.buffer).setUint32(0, bytes.length, false);
  encoded.set(bytes, 4);
  return encoded;
}

function rawJson(value: unknown): Uint8Array { return rawBody(utf8Encode(JSON.stringify(value))); }

function concatenate(...chunks: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

function decodeAll(encoded: Uint8Array, chunkBytes = 20): readonly WireFrame[] {
  const decoder = new FrameDecoder();
  const frames: WireFrame[] = [];
  for (let index = 0; index < encoded.length; index += chunkBytes) {
    frames.push(...decoder.push(encoded.subarray(index, index + chunkBytes)));
  }
  return frames;
}

test('mesh wire round-trips every v1 frame and freezes reconstructed fields', () => {
  const packet = createMessage({ kind: 'sos', payload: {
    text: 'نحتاج المساعدة 🕊️', location: { latitude: 31.5, longitude: 34.47, timestamp: 99 },
  } }, MESSAGE, 'device:alpha', 100);
  const frames: WireFrame[] = [
    HELLO,
    { v: 1, type: 'hello-ack', peerId: 'device:beta', nonce: TRANSFER, echo: NONCE },
    { v: 1, type: 'ready', session: NONCE },
    { v: 1, type: 'packet', session: NONCE, transferId: TRANSFER, packet },
    ACK,
    ...(['full', 'invalid', 'busy', 'storage'] as const).map((reason): WireFrame => ({
      ...ACK, type: 'nack', reason,
    })),
  ];
  for (const frame of frames) {
    const encoded = encodeFrame(frame);
    assert.equal(new DataView(encoded.buffer).getUint32(0, false), encoded.length - 4);
    const decoded = decodeAll(encoded)[0]!;
    assert.deepEqual(decoded, frame);
    assert.equal(Object.isFrozen(decoded), true);
    if (decoded.type === 'packet') {
      assert.equal(Object.isFrozen(decoded.packet), true);
      assert.equal(Object.isFrozen(decoded.packet.payload), true);
    }
  }
});

test('mesh wire handles every possible single split and byte-at-a-time BLE fragments', () => {
  const encoded = encodeFrame(HELLO);
  for (let split = 0; split <= encoded.length; split += 1) {
    const decoder = new FrameDecoder();
    assert.deepEqual([...decoder.push(encoded.subarray(0, split)), ...decoder.push(encoded.subarray(split))], [HELLO]);
  }
  assert.deepEqual(decodeAll(encoded, 1), [HELLO]);
});

test('mesh wire handles coalesced frames and a partial next frame across chunks', () => {
  const first = encodeFrame(HELLO);
  const second = encodeFrame(ACK);
  const third = encodeFrame({ ...HELLO, peerId: 'device:gamma' });
  const decoder = new FrameDecoder();
  assert.deepEqual(decoder.push(concatenate(first, second, third.subarray(0, 7))), [HELLO, ACK]);
  assert.deepEqual(decoder.push(third.subarray(7)), [{ ...HELLO, peerId: 'device:gamma' }]);
  assert.deepEqual(decoder.push(new Uint8Array()), []);
});

test('mesh wire canonicalizes UUID case in all identity fields and nested messages', () => {
  const upper = 'ABCDEFAB-CDEF-4ABC-8ABC-ABCDEFABCDEF';
  for (const frame of [
    { ...HELLO, nonce: upper },
    { v: 1, type: 'hello-ack', peerId: 'peer', nonce: upper, echo: upper },
    { v: 1, type: 'ready', session: upper },
    { ...ACK, session: upper, transferId: upper, messageId: upper },
    { v: 1, type: 'packet', session: upper, transferId: upper, packet: {
      version: 1, id: upper, source: 'source', destination: '*', createdAt: 0,
      ttl: 0, kind: 'chat', payload: { text: 'Hello' },
    } },
  ]) {
    const encoded = encodeFrame(frame as WireFrame);
    assert.equal(utf8Decode(encoded.subarray(4)).includes(upper), false);
    assert.equal(utf8Decode(encoded.subarray(4)).includes(upper.toLowerCase()), true);
  }
});

test('mesh wire enforces the exact UTF-8 body limit independent of its four-byte prefix', () => {
  const bytes = encodeFrame(HELLO);
  const size = bytes.length - 4;
  assert.deepEqual(encodeFrame(HELLO, size), bytes);
  assert.throws(() => encodeFrame(HELLO, size - 1), WireProtocolError);
  assert.deepEqual(new FrameDecoder(size).push(bytes), [HELLO]);
  assert.throws(() => new FrameDecoder(size - 1).push(bytes.subarray(0, 4)), WireProtocolError);
  assert.equal(DEFAULT_MAX_FRAME_BYTES, 20 * 1024);
  for (const limit of [0, -1, NaN, Infinity, 0.5, 0x100000000]) {
    assert.throws(() => encodeFrame(HELLO, limit), WireProtocolError);
    assert.throws(() => new FrameDecoder(limit), WireProtocolError);
    assert.throws(() => new FrameDecoder(undefined, limit), WireProtocolError);
  }
});

test('mesh wire rejects zero, oversized and unsigned-high-bit body lengths before body copying', () => {
  for (const prefix of [[0, 0, 0, 0], [0, 0, 80, 1], [128, 0, 0, 0], [255, 255, 255, 255]]) {
    const decoder = new FrameDecoder();
    assert.throws(() => decoder.push(Uint8Array.from(prefix)), WireProtocolError);
    assert.throws(() => decoder.push(encodeFrame(HELLO)), /until reset/);
    decoder.reset();
    assert.deepEqual(decoder.push(encodeFrame(HELLO)), [HELLO]);
  }
});

test('mesh wire rejects oversized native chunks and does not continue after a framing error', () => {
  const decoder = new FrameDecoder(undefined, 20);
  assert.throws(() => decoder.push(new Uint8Array(21)), /chunk exceeds/);
  assert.throws(() => decoder.push(new Uint8Array()), /until reset/);
  decoder.reset();
  const result: WireFrame[] = [];
  const encoded = encodeFrame(HELLO);
  for (let index = 0; index < encoded.length; index += 20) result.push(...decoder.push(encoded.subarray(index, index + 20)));
  assert.deepEqual(result, [HELLO]);
  assert.throws(() => new FrameDecoder().push([] as unknown as Uint8Array), WireProtocolError);
});

test('mesh wire bounds complete frames per native event to prevent event-loop flooding', () => {
  const encoded = encodeFrame(HELLO);
  assert.equal(new FrameDecoder().push(concatenate(...Array.from({ length: 32 }, () => encoded))).length, 32);
  const fragmented = new FrameDecoder();
  assert.equal(fragmented.push(concatenate(
    ...Array.from({ length: 32 }, () => encoded), encoded.subarray(0, 6),
  )).length, 32);
  assert.deepEqual(fragmented.push(encoded.subarray(6)), [HELLO]);
  const decoder = new FrameDecoder();
  assert.throws(() => decoder.push(concatenate(...Array.from({ length: 33 }, () => encoded))), /Too many/);
  assert.throws(() => decoder.push(encoded), /until reset/);
});

test('mesh wire rejects malformed JSON, unsupported versions, unknown fields, and invalid frame shapes', () => {
  for (const input of [null, [], true, 'hello', {}, { ...HELLO, v: 2 }, { ...HELLO, v: '1' },
    { ...HELLO, type: 'unknown' }, { ...HELLO, extra: true }, { ...HELLO, nonce: undefined },
    { ...HELLO, peerId: '*' }, { ...HELLO, peerId: 'peer\n' },
    { ...ACK, session: 'not-a-uuid' }, { ...ACK, transferId: `${TRANSFER}\n` },
    { ...ACK, messageId: MESSAGE.replace('-4000-', '-1000-') },
    { ...ACK, type: 'nack', reason: 'nope' }, { ...ACK, type: 'nack' },
    { v: 1, type: 'ready' }, { v: 1, type: 'ready', session: `${NONCE}\n` },
    { v: 1, type: 'ready', session: NONCE, peerId: 'peer' },
    { v: 1, type: 'hello-ack', peerId: 'peer', nonce: NONCE, echo: 0 },
  ]) {
    assert.throws(() => new FrameDecoder().push(rawJson(input)), WireProtocolError, JSON.stringify(input));
    assert.throws(() => encodeFrame(input as WireFrame), WireProtocolError, JSON.stringify(input));
  }
  const decoder = new FrameDecoder();
  assert.throws(() => decoder.push(rawBody(utf8Encode('{"v":'))), /invalid JSON/);
  assert.throws(() => decoder.push(encodeFrame(HELLO)), /until reset/);
});

test('mesh wire reuses DTN packet validation including its independent 16 KiB bound', () => {
  const packet = createMessage({ kind: 'chat', destination: 'peer', payload: { text: 'hello' } }, MESSAGE, 'source', 0);
  const frame: WireFrame = { v: 1, type: 'packet', session: NONCE, transferId: TRANSFER, packet };
  for (const badPacket of [null, { ...packet, ttl: 11 }, { ...packet, extra: true },
    { ...packet, payload: { text: '\u0000'.repeat(4096) } },
  ]) {
    assert.throws(() => encodeFrame({ ...frame, packet: badPacket } as WireFrame), /Invalid DTN packet/);
    const bytes = rawJson({ ...frame, packet: badPacket });
    const decoder = new FrameDecoder(32768, 32768);
    assert.throws(() => decoder.push(bytes), /Invalid DTN packet/);
  }
});

test('mesh wire does not execute accessors or serialization hooks and rejects exotic properties', () => {
  let called = false;
  const getter = { ...HELLO };
  Object.defineProperty(getter, 'nonce', { enumerable: true, get() { called = true; return NONCE; } });
  const hook = { ...HELLO, toJSON() { called = true; return HELLO; } };
  const hidden = { ...HELLO };
  Object.defineProperty(hidden, 'secret', { value: 'hidden' });
  const symbol = { ...HELLO, [Symbol('secret')]: true };
  const inherited = Object.assign(Object.create({ inherited: true }) as object, HELLO);
  for (const input of [getter, hook, hidden, symbol, inherited, new Date()]) {
    assert.throws(() => encodeFrame(input as WireFrame), WireProtocolError);
  }
  assert.equal(called, false);
  const packet = createMessage({ kind: 'chat', destination: 'peer', payload: { text: 'Hi' } }, MESSAGE, 'source', 0);
  const frame = { v: 1, type: 'packet', session: NONCE, transferId: TRANSFER, packet: { ...packet, payload: {
    get text() { called = true; return 'Hi'; },
  } } };
  assert.throws(() => encodeFrame(frame as WireFrame), WireProtocolError);
  assert.equal(called, false);
  assert.deepEqual(decodeAll(encodeFrame(Object.assign(Object.create(null) as WireFrame, HELLO))), [HELLO]);
});

test('mesh UTF-8 matches standard encoders for ASCII, Arabic, emoji, and Unicode boundary code points', () => {
  for (const value of ['', 'PalMesh', 'فلسطين', '🕊️😀', '\u0000\u007f\u0080\u07ff\u0800\ud7ff\ue000\uffff',
    String.fromCodePoint(0x10000, 0x10ffff), 'مساعدة '.repeat(500),
  ]) {
    const bytes = utf8Encode(value);
    assert.deepEqual(bytes, Uint8Array.from(Buffer.from(value, 'utf8')));
    assert.equal(utf8Decode(bytes), value);
  }
  for (const value of ['\ud800', '\udfff', '\ud800a', '\ud800\ud800']) {
    assert.throws(() => utf8Encode(value), WireProtocolError);
  }
});

test('mesh UTF-8 rejects overlong, truncated, surrogate, out-of-range, and invalid continuation sequences', () => {
  for (const bytes of [
    [0x80], [0xbf], [0xc0, 0x80], [0xc1, 0xbf], [0xc2], [0xc2, 0x20],
    [0xe0, 0x80, 0x80], [0xe0, 0x9f, 0xbf], [0xe1, 0x80], [0xe1, 0x80, 0x7f],
    [0xed, 0xa0, 0x80], [0xed, 0xbf, 0xbf], [0xf0, 0x80, 0x80, 0x80],
    [0xf0, 0x8f, 0xbf, 0xbf], [0xf0, 0x90, 0x80], [0xf4, 0x90, 0x80, 0x80],
    [0xf5, 0x80, 0x80, 0x80], [0xff], [0xf0, 0x90, 0xc0, 0x80],
  ]) assert.throws(() => utf8Decode(Uint8Array.from(bytes)), WireProtocolError, bytes.join(','));
  const prefix = utf8Encode('{"v":1,"type":"hello","peerId":"');
  const suffix = utf8Encode(`","nonce":"${NONCE}"}`);
  const malformed = rawBody(concatenate(prefix, Uint8Array.from([0xc0, 0xaf]), suffix));
  const decoder = new FrameDecoder();
  assert.throws(() => decoder.push(malformed), /UTF-8/);
  assert.throws(() => decoder.push(encodeFrame(HELLO)), /until reset/);
});

test('mesh base64 matches standard canonical vectors and round-trips every byte and padding remainder', () => {
  for (const [value, expected] of [['', ''], ['f', 'Zg=='], ['fo', 'Zm8='], ['foo', 'Zm9v'],
    ['foob', 'Zm9vYg=='], ['fooba', 'Zm9vYmE='], ['foobar', 'Zm9vYmFy'], ['فلسطين 🕊️', ''],
  ]) {
    const bytes = utf8Encode(value!);
    const encoded = bytesToBase64(bytes);
    assert.equal(encoded, expected || Buffer.from(bytes).toString('base64'));
    assert.deepEqual(base64ToBytes(encoded, bytes.length), bytes);
  }
  for (let length = 1; length <= 1024; length += 1) {
    const bytes = Uint8Array.from({ length }, (_, index) => index & 255);
    const encoded = bytesToBase64(bytes);
    assert.equal(encoded, Buffer.from(bytes).toString('base64'));
    assert.deepEqual(base64ToBytes(encoded, length), bytes);
  }
});

test('mesh base64 rejects whitespace, alternate alphabets, missing/extra padding, and nonzero padding bits', () => {
  for (const input of ['A', 'AA', 'AAA', 'A===', '====', '=AAA', 'AA=A', 'AA==AAAA', 'AAAA=',
    ' AA==', 'AA==\n', 'AA\t==', 'AA\r\n==', 'AA-_', 'AA😀', 'AB==', 'A/==', 'AAB=', 'AA/=',
  ]) assert.throws(() => base64ToBytes(input), WireProtocolError, input);
  assert.throws(() => base64ToBytes(null as unknown as string), WireProtocolError);
  assert.throws(() => bytesToBase64([] as unknown as Uint8Array), WireProtocolError);
});

test('mesh base64 applies native event bounds before allocating and accepts the exact byte limit', () => {
  const maximum = new Uint8Array(8192).fill(255);
  assert.deepEqual(base64ToBytes(bytesToBase64(maximum)), maximum);
  assert.throws(() => base64ToBytes(bytesToBase64(new Uint8Array(8193))), /exceeds|oversized/);
  assert.deepEqual(base64ToBytes('', 0), new Uint8Array());
  assert.deepEqual(base64ToBytes('AA==', 1), new Uint8Array(1));
  assert.throws(() => base64ToBytes('AAA=', 1), /exceeds/);
  assert.throws(() => base64ToBytes('AA==', 0), /oversized/);
  for (const limit of [-1, NaN, Infinity, 0.5, 0x100000000]) {
    assert.throws(() => base64ToBytes('', limit), WireProtocolError);
  }
});
