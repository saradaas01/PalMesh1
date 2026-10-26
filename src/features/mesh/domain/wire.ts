import { isPeerId, parseMessage } from '../../dtn/domain/validation';
import type { WireFrame } from './types';
import type { HandshakeAuthentication } from '../../security/domain/types';

export const DEFAULT_MAX_FRAME_BYTES = 20 * 1024;
export const DEFAULT_MAX_CHUNK_BYTES = 8192;
const MAX_FRAMES_PER_PUSH = 32;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/i;
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export class WireProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WireProtocolError';
  }
}

function byteLimit(value: number, label: string, allowZero = false): number {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1) || value > 0xffffffff) {
    throw new WireProtocolError(`${label} must be ${allowZero ? 'a nonnegative' : 'a positive'} 32-bit byte count.`);
  }
  return value;
}

/** Avoid serialization hooks and accessors supplied by untyped native callers. */
function fieldsOf(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new WireProtocolError('Wire frame must be a plain object.');
  }
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new WireProtocolError('Wire frame must be a plain object.');
  }
  const fields = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string') throw new WireProtocolError('Wire frame contains an unknown field.');
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
      throw new WireProtocolError('Wire frame must contain enumerable data properties.');
    }
    fields[key] = descriptor.value;
  }
  return fields;
}

function exactFields(fields: Record<string, unknown>, names: readonly string[]): void {
  if (Object.keys(fields).length !== names.length || names.some((name) => !Object.hasOwn(fields, name))) {
    throw new WireProtocolError('Wire frame contains missing or unknown fields.');
  }
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID_V4.test(value)) {
    throw new WireProtocolError(`${label} must be a UUID v4.`);
  }
  return value.toLowerCase();
}

function handshakeAuthentication(input: unknown): HandshakeAuthentication {
  const fields = fieldsOf(input);
  exactFields(fields, ['signingKey', 'encryptionKey', 'signature']);
  if (typeof fields.signingKey !== 'string' || !/^[0-9a-f]{64}$(?![\s\S])/.test(fields.signingKey)
    || typeof fields.encryptionKey !== 'string' || !/^[0-9a-f]{64}$(?![\s\S])/.test(fields.encryptionKey)
    || typeof fields.signature !== 'string' || !/^[0-9a-f]{128}$(?![\s\S])/.test(fields.signature)) {
    throw new WireProtocolError('Invalid handshake authentication.');
  }
  return Object.freeze({ signingKey: fields.signingKey, encryptionKey: fields.encryptionKey, signature: fields.signature });
}

/** Canonical fields authenticated by a session MAC. No serializer hooks or
 * object property-order assumptions enter the outer frame representation. */
export function sessionFrameContent(frame: WireFrame): string {
  if (frame.type === 'hello' || frame.type === 'hello-ack') throw new WireProtocolError('Handshake frames use signatures.');
  if (frame.type === 'ready') return JSON.stringify([frame.v, frame.type, frame.session]);
  if (frame.type === 'packet') return JSON.stringify([frame.v, frame.type, frame.session, frame.transferId, frame.packet]);
  return JSON.stringify([frame.v, frame.type, frame.session, frame.transferId, frame.messageId,
    frame.type === 'nack' ? frame.reason : null]);
}

function validateFrame(input: unknown): WireFrame {
  try {
    const fields = fieldsOf(input);
    if (fields.v !== 1) throw new WireProtocolError('Unsupported wire protocol version.');
    let authenticationTag: string | undefined;
    if (Object.hasOwn(fields, 'authenticationTag')) {
      if (fields.type === 'hello' || fields.type === 'hello-ack' || typeof fields.authenticationTag !== 'string'
        || !/^[0-9a-f]{64}$(?![\s\S])/.test(fields.authenticationTag)) throw new WireProtocolError('Invalid frame authentication tag.');
      authenticationTag = fields.authenticationTag;
      delete fields.authenticationTag;
    }
    const tag = authenticationTag ? { authenticationTag } : {};
    switch (fields.type) {
      case 'hello':
      case 'hello-ack': {
        const type = fields.type;
        const authentication = Object.hasOwn(fields, 'authentication') ? handshakeAuthentication(fields.authentication) : undefined;
        if (authentication) delete fields.authentication;
        exactFields(fields, type === 'hello' ? ['v', 'type', 'peerId', 'nonce'] : ['v', 'type', 'peerId', 'nonce', 'echo']);
        if (!isPeerId(fields.peerId)) throw new WireProtocolError('Handshake peer id is invalid.');
        const nonce = uuid(fields.nonce, 'Handshake nonce');
        return type === 'hello'
          ? Object.freeze({ v: 1, type, peerId: fields.peerId, nonce, ...(authentication ? { authentication } : {}) })
          : Object.freeze({ v: 1, type, peerId: fields.peerId, nonce, echo: uuid(fields.echo, 'Handshake echo'), ...(authentication ? { authentication } : {}) });
      }
      case 'ready': {
        exactFields(fields, ['v', 'type', 'session']);
        return Object.freeze({ v: 1, type: 'ready', session: uuid(fields.session, 'Session nonce'), ...tag });
      }
      case 'packet': {
        exactFields(fields, ['v', 'type', 'session', 'transferId', 'packet']);
        const session = uuid(fields.session, 'Session nonce');
        const transferId = uuid(fields.transferId, 'Transfer id');
        const result = parseMessage(fields.packet);
        if (!result.ok) throw new WireProtocolError(`Invalid DTN packet: ${result.reason}`);
        return Object.freeze({ v: 1, type: 'packet', session, transferId, packet: result.message, ...tag });
      }
      case 'ack':
      case 'nack': {
        const type = fields.type;
        exactFields(fields, type === 'ack'
          ? ['v', 'type', 'session', 'transferId', 'messageId']
          : ['v', 'type', 'session', 'transferId', 'messageId', 'reason']);
        const session = uuid(fields.session, 'Session nonce');
        const transferId = uuid(fields.transferId, 'Transfer id');
        const messageId = uuid(fields.messageId, 'Message id');
        if (type === 'ack') return Object.freeze({ v: 1, type, session, transferId, messageId, ...tag });
        const reason = fields.reason;
        if (reason !== 'full' && reason !== 'invalid' && reason !== 'busy' && reason !== 'storage') {
          throw new WireProtocolError('Unrecognized negative acknowledgment reason.');
        }
        return Object.freeze({ v: 1, type, session, transferId, messageId, reason, ...tag });
      }
      default:
        throw new WireProtocolError('Unknown wire frame type.');
    }
  } catch (error) {
    if (error instanceof WireProtocolError) throw error;
    throw new WireProtocolError('Wire frame could not be validated.');
  }
}

/** Strict UTF-8 without Node, TextEncoder, or runtime-specific polyfills. */
export function utf8Encode(value: string): Uint8Array {
  if (typeof value !== 'string') throw new WireProtocolError('UTF-8 input must be a string.');
  let length = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) length += 1;
    else if (code <= 0x7ff) length += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low < 0xdc00 || low > 0xdfff || Number.isNaN(low)) {
        throw new WireProtocolError('UTF-8 input contains an unpaired surrogate.');
      }
      length += 4;
      index += 1;
    } else {
      if (code >= 0xdc00 && code <= 0xdfff) throw new WireProtocolError('UTF-8 input contains an unpaired surrogate.');
      length += 3;
    }
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (let index = 0; index < value.length; index += 1) {
    let code = value.charCodeAt(index);
    if (code <= 0x7f) bytes[offset++] = code;
    else if (code <= 0x7ff) {
      bytes[offset++] = 0xc0 | (code >>> 6);
      bytes[offset++] = 0x80 | (code & 0x3f);
    } else if (code >= 0xd800 && code <= 0xdbff) {
      code = 0x10000 + ((code - 0xd800) << 10) + (value.charCodeAt(++index) - 0xdc00);
      bytes[offset++] = 0xf0 | (code >>> 18);
      bytes[offset++] = 0x80 | ((code >>> 12) & 0x3f);
      bytes[offset++] = 0x80 | ((code >>> 6) & 0x3f);
      bytes[offset++] = 0x80 | (code & 0x3f);
    } else {
      bytes[offset++] = 0xe0 | (code >>> 12);
      bytes[offset++] = 0x80 | ((code >>> 6) & 0x3f);
      bytes[offset++] = 0x80 | (code & 0x3f);
    }
  }
  return bytes;
}

export function utf8Decode(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array)) throw new WireProtocolError('UTF-8 input must be bytes.');
  const parts: string[] = [];
  for (let index = 0; index < bytes.length;) {
    const first = bytes[index++]!;
    if (first <= 0x7f) {
      parts.push(String.fromCharCode(first));
      continue;
    }
    let code: number;
    let remaining: number;
    if (first >= 0xc2 && first <= 0xdf) { code = first & 0x1f; remaining = 1; }
    else if (first >= 0xe0 && first <= 0xef) { code = first & 0x0f; remaining = 2; }
    else if (first >= 0xf0 && first <= 0xf4) { code = first & 0x07; remaining = 3; }
    else throw new WireProtocolError('Invalid UTF-8 leading byte.');
    if (index + remaining > bytes.length) throw new WireProtocolError('Truncated UTF-8 sequence.');
    const second = bytes[index]!;
    if ((first === 0xe0 && second < 0xa0) || (first === 0xed && second >= 0xa0) ||
      (first === 0xf0 && second < 0x90) || (first === 0xf4 && second >= 0x90)) {
      throw new WireProtocolError('Noncanonical UTF-8 code point.');
    }
    for (let continuation = 0; continuation < remaining; continuation += 1) {
      const byte = bytes[index++]!;
      if (byte < 0x80 || byte > 0xbf) throw new WireProtocolError('Invalid UTF-8 continuation byte.');
      code = (code << 6) | (byte & 0x3f);
    }
    if (code <= 0xffff) parts.push(String.fromCharCode(code));
    else {
      code -= 0x10000;
      parts.push(String.fromCharCode(0xd800 + (code >>> 10), 0xdc00 + (code & 0x3ff)));
    }
  }
  return parts.join('');
}

/** Four-byte unsigned big-endian length followed by canonical UTF-8 JSON. */
export function encodeFrame(frame: WireFrame, maxFrameBytes = DEFAULT_MAX_FRAME_BYTES): Uint8Array {
  byteLimit(maxFrameBytes, 'Maximum frame size');
  const body = utf8Encode(JSON.stringify(validateFrame(frame)));
  if (body.length > maxFrameBytes) throw new WireProtocolError('Wire frame exceeds the maximum body size.');
  const encoded = new Uint8Array(body.length + 4);
  encoded[0] = body.length >>> 24;
  encoded[1] = (body.length >>> 16) & 0xff;
  encoded[2] = (body.length >>> 8) & 0xff;
  encoded[3] = body.length & 0xff;
  encoded.set(body, 4);
  return encoded;
}

/** A link owns one bounded reusable body buffer. No concatenation of fragments
 * occurs, so byte-at-a-time BLE delivery still takes linear copying work. */
export class FrameDecoder {
  private readonly header = new Uint8Array(4);
  private readonly body: Uint8Array;
  private headerLength = 0;
  private bodyLength = 0;
  private expectedLength = 0;
  private failed = false;

  constructor(
    private readonly maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
    private readonly maxChunkBytes = DEFAULT_MAX_CHUNK_BYTES,
  ) {
    byteLimit(maxFrameBytes, 'Maximum frame size');
    byteLimit(maxChunkBytes, 'Maximum chunk size');
    this.body = new Uint8Array(maxFrameBytes);
  }

  push(chunk: Uint8Array): readonly WireFrame[] {
    if (this.failed) throw new WireProtocolError('Decoder is unusable until reset.');
    try {
      if (!(chunk instanceof Uint8Array)) throw new WireProtocolError('Wire chunk must be bytes.');
      // Validate the native event size before copying or examining its contents.
      if (chunk.length > this.maxChunkBytes) throw new WireProtocolError('Wire chunk exceeds the maximum size.');
      const frames: WireFrame[] = [];
      let offset = 0;
      while (offset < chunk.length) {
        if (this.headerLength < 4) {
          const size = Math.min(4 - this.headerLength, chunk.length - offset);
          this.header.set(chunk.subarray(offset, offset + size), this.headerLength);
          this.headerLength += size;
          offset += size;
          if (this.headerLength !== 4) continue;
          this.expectedLength = this.header[0]! * 0x1000000 + this.header[1]! * 0x10000 +
            this.header[2]! * 0x100 + this.header[3]!;
          if (this.expectedLength === 0 || this.expectedLength > this.maxFrameBytes) {
            throw new WireProtocolError('Wire frame length is outside the permitted range.');
          }
        }
        const size = Math.min(this.expectedLength - this.bodyLength, chunk.length - offset);
        this.body.set(chunk.subarray(offset, offset + size), this.bodyLength);
        this.bodyLength += size;
        offset += size;
        if (this.bodyLength === this.expectedLength) {
          if (frames.length >= MAX_FRAMES_PER_PUSH) throw new WireProtocolError('Too many wire frames in one chunk.');
          let input: unknown;
          try { input = JSON.parse(utf8Decode(this.body.subarray(0, this.bodyLength))) as unknown; }
          catch (error) {
            if (error instanceof WireProtocolError) throw error;
            throw new WireProtocolError('Wire frame contains invalid JSON.');
          }
          frames.push(validateFrame(input));
          this.headerLength = 0;
          this.bodyLength = 0;
          this.expectedLength = 0;
        }
      }
      return Object.freeze(frames);
    } catch (error) {
      this.failed = true;
      if (error instanceof WireProtocolError) throw error;
      throw new WireProtocolError('Wire chunk could not be decoded.');
    }
  }

  reset(): void {
    this.headerLength = 0;
    this.bodyLength = 0;
    this.expectedLength = 0;
    this.failed = false;
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array)) throw new WireProtocolError('Base64 input must be bytes.');
  const parts: string[] = [];
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    parts.push(BASE64_ALPHABET[first >>> 2]!, BASE64_ALPHABET[((first & 3) << 4) | ((second ?? 0) >>> 4)]!,
      second === undefined ? '=' : BASE64_ALPHABET[((second & 15) << 2) | ((third ?? 0) >>> 6)]!,
      third === undefined ? '=' : BASE64_ALPHABET[third & 63]!);
  }
  return parts.join('');
}

function base64Digit(code: number): number {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  if (code === 43) return 62;
  if (code === 47) return 63;
  return -1;
}

/** Native base64 events are untrusted. Check size and canonical pad bits before
 * allocation; permissive platform decoders otherwise hide malformed packets. */
export function base64ToBytes(value: string, maxBytes = DEFAULT_MAX_CHUNK_BYTES): Uint8Array {
  byteLimit(maxBytes, 'Maximum decoded base64 size', true);
  if (typeof value !== 'string' || value.length % 4 !== 0 || value.length > Math.ceil(maxBytes / 3) * 4) {
    throw new WireProtocolError('Invalid or oversized base64 input.');
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const length = value.length / 4 * 3 - padding;
  if (length > maxBytes) throw new WireProtocolError('Decoded base64 exceeds the maximum size.');
  for (let index = 0; index < value.length - padding; index += 1) {
    if (base64Digit(value.charCodeAt(index)) < 0) throw new WireProtocolError('Invalid base64 character.');
  }
  if ((padding === 2 && (base64Digit(value.charCodeAt(value.length - 3)) & 15) !== 0) ||
    (padding === 1 && (base64Digit(value.charCodeAt(value.length - 2)) & 3) !== 0)) {
    throw new WireProtocolError('Noncanonical base64 padding bits.');
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (let index = 0; index < value.length; index += 4) {
    const first = base64Digit(value.charCodeAt(index));
    const second = base64Digit(value.charCodeAt(index + 1));
    const third = base64Digit(value.charCodeAt(index + 2));
    const fourth = base64Digit(value.charCodeAt(index + 3));
    bytes[offset++] = (first << 2) | (second >>> 4);
    if (offset < length) bytes[offset++] = ((second & 15) << 4) | (third >>> 2);
    if (offset < length) bytes[offset++] = ((third & 3) << 6) | fourth;
  }
  return bytes;
}
