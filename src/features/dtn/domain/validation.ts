import {
  BROADCAST, NORMAL_TTL, SOS_TTL,
  type LocationFix, type MeshMessage, type MessageId, type MessageSecurity, type OutgoingMessage, type PeerId,
} from './types';

export const DEFAULT_MAX_PACKET_BYTES = 16 * 1024;

export type ParseMessageResult =
  | { readonly ok: true; readonly message: MeshMessage }
  | { readonly ok: false; readonly reason: string };

// The final negative lookahead is a true end-of-input check. JavaScript's `$`
// also matches before a final newline, which must not enter identifiers.
const PEER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$(?![\s\S])/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/i;
const ENVELOPE_KEYS = ['version', 'id', 'source', 'destination', 'createdAt', 'ttl', 'kind', 'payload'] as const;

class ValidationError extends Error {}

export function isPeerId(value: unknown): value is PeerId {
  return typeof value === 'string' && PEER_ID.test(value);
}

/** Read only own data properties. Never invoke accessors or stringify an
 * unvalidated packet: adapters may provide objects beyond JSON.parse results. */
function objectFields(
  value: unknown, required: readonly string[], optional: readonly string[] = [], label = 'Message',
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError(`${label} must be a plain object.`);
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ValidationError(`${label} must be a plain object.`);
  }
  const fields: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || (!required.includes(key) && !optional.includes(key))) {
      throw new ValidationError(`${label} contains an unknown field.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
      throw new ValidationError(`${label} must contain enumerable data properties.`);
    }
    fields[key] = descriptor.value;
  }
  for (const key of required) {
    if (!Object.hasOwn(fields, key)) throw new ValidationError(`${label}.${key} is required.`);
  }
  return fields;
}

function timestamp(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ValidationError(`${label} must be a nonnegative safe integer.`);
  }
  return value;
}

function textPayload(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096 || value.trim().length === 0) {
    throw new ValidationError('Payload text must contain 1–4096 characters and cannot be blank.');
  }
  return value;
}

function locationFix(value: unknown): LocationFix {
  const fields = objectFields(value, ['latitude', 'longitude', 'timestamp'], [], 'Location');
  const { latitude, longitude } = fields;
  if (typeof latitude !== 'number' || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new ValidationError('Location latitude must be a finite number between -90 and 90.');
  }
  if (typeof longitude !== 'number' || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new ValidationError('Location longitude must be a finite number between -180 and 180.');
  }
  return Object.freeze({ latitude, longitude, timestamp: timestamp(fields.timestamp, 'Location timestamp') });
}

type Content<T extends MeshMessage = MeshMessage> = T extends MeshMessage ? Pick<T, 'kind' | 'payload'> : never;

function content(kind: unknown, value: unknown, encrypted = false): Content {
  switch (kind) {
    case 'chat': {
      const fields = objectFields(value, ['text'], [], 'Chat payload');
      if (encrypted) {
        if (typeof fields.text !== 'string' || fields.text.length < 24 || fields.text.length > 24 * 1024
          || !/^[A-Za-z0-9+/]+={0,2}$(?![\s\S])/.test(fields.text)) {
          throw new ValidationError('Encrypted chat payload must contain bounded base64 ciphertext.');
        }
        return { kind, payload: Object.freeze({ text: fields.text }) };
      }
      return { kind, payload: Object.freeze({ text: textPayload(fields.text) }) };
    }
    case 'sos': {
      const fields = objectFields(value, ['text'], ['location'], 'SOS payload');
      const text = textPayload(fields.text);
      const payload = Object.hasOwn(fields, 'location')
        ? { text, location: locationFix(fields.location) }
        : { text };
      return { kind, payload: Object.freeze(payload) };
    }
    case 'sos-response': {
      const fields = objectFields(value, ['sosId', 'status'], [], 'SOS response payload');
      if (typeof fields.sosId !== 'string' || !UUID_V4.test(fields.sosId) || fields.status !== 'responding') {
        throw new ValidationError('SOS response must name a valid SOS UUID and responding status.');
      }
      return { kind, payload: Object.freeze({ sosId: fields.sosId.toLowerCase(), status: 'responding' as const }) };
    }
    case 'location': {
      const fields = objectFields(value, ['location'], [], 'Location payload');
      return { kind, payload: Object.freeze({ location: locationFix(fields.location) }) };
    }
    default:
      throw new ValidationError('Message kind must be chat, sos, sos-response, or location.');
  }
}

function securityMetadata(value: unknown): MessageSecurity {
  const fields = objectFields(value,
    ['version', 'signingKey', 'encryptionKey', 'signature', 'initialTtl', 'hopCommitment', 'hopProof'],
    ['encryption'], 'Security');
  const hex = (input: unknown, bytes: number): string => {
    if (typeof input !== 'string' || input.length !== bytes * 2 || !/^[0-9a-f]+$(?![\s\S])/.test(input)) {
      throw new ValidationError('Security field must contain canonical bounded hex.');
    }
    return input;
  };
  if (fields.version !== 1 || typeof fields.initialTtl !== 'number' || !Number.isInteger(fields.initialTtl)
    || fields.initialTtl < 1 || fields.initialTtl > SOS_TTL) throw new ValidationError('Unsupported security metadata.');
  let encryption: MessageSecurity['encryption'];
  if (Object.hasOwn(fields, 'encryption')) {
    const encrypted = objectFields(fields.encryption, ['recipientKey', 'nonce'], [], 'Encryption');
    encryption = Object.freeze({ recipientKey: hex(encrypted.recipientKey, 32), nonce: hex(encrypted.nonce, 24) });
  }
  return Object.freeze({
    version: 1, signingKey: hex(fields.signingKey, 32), encryptionKey: hex(fields.encryptionKey, 32),
    signature: hex(fields.signature, 64), initialTtl: fields.initialTtl,
    hopCommitment: hex(fields.hopCommitment, 32), hopProof: hex(fields.hopProof, 32),
    ...(encryption ? { encryption } : {}),
  });
}

/** UTF-8 byte length without TextEncoder, which is not available in every
 * React Native runtime. JSON.stringify has already escaped lone surrogates. */
function utf8Length(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length &&
      value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

function validatePacket(input: unknown, maxPacketBytes: number): MeshMessage {
  if (!Number.isSafeInteger(maxPacketBytes) || maxPacketBytes <= 0) {
    throw new ValidationError('Maximum packet size must be a positive safe integer.');
  }
  const fields = objectFields(input, ENVELOPE_KEYS, ['security']);
  if (fields.version !== 1) throw new ValidationError('Unsupported message version.');
  if (typeof fields.id !== 'string' || !UUID_V4.test(fields.id)) {
    throw new ValidationError('Message id must be a UUID v4.');
  }
  if (!isPeerId(fields.source)) throw new ValidationError('Message source must be a valid peer id.');
  if (fields.destination !== BROADCAST && !isPeerId(fields.destination)) {
    throw new ValidationError('Message destination must be a valid peer id or broadcast.');
  }
  const security = Object.hasOwn(fields, 'security') ? securityMetadata(fields.security) : undefined;
  if (security?.encryption && fields.kind !== 'chat') throw new ValidationError('Encryption is only supported for direct chat.');
  const parsedContent = content(fields.kind, fields.payload, Boolean(security?.encryption));
  if (parsedContent.kind === 'sos-response' && fields.destination === BROADCAST) {
    throw new ValidationError('SOS responses require a direct destination.');
  }
  const maximumTtl = parsedContent.kind === 'sos' || parsedContent.kind === 'sos-response' ? SOS_TTL : NORMAL_TTL;
  if (typeof fields.ttl !== 'number' || !Number.isInteger(fields.ttl) || fields.ttl < 0 || fields.ttl > maximumTtl) {
    throw new ValidationError(`Message ttl must be an integer from 0 to ${maximumTtl}.`);
  }
  // Reconstruct the wire object, so later mutation of transport input cannot
  // change persisted packets, queue priority, destination, or location.
  const message: MeshMessage = Object.freeze({
    version: 1 as const,
    id: fields.id.toLowerCase(),
    source: fields.source,
    destination: fields.destination,
    createdAt: timestamp(fields.createdAt, 'Message createdAt'),
    ttl: fields.ttl,
    ...parsedContent,
    ...(security ? { security } : {}),
  });
  if (utf8Length(JSON.stringify(message)) > maxPacketBytes) {
    throw new ValidationError('Message exceeds the maximum serialized packet size.');
  }
  return message;
}

export function parseMessage(input: unknown, maxPacketBytes = DEFAULT_MAX_PACKET_BYTES): ParseMessageResult {
  try {
    return { ok: true, message: validatePacket(input, maxPacketBytes) };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof ValidationError ? error.message : 'Message could not be validated.',
    };
  }
}

export function createMessage(
  input: OutgoingMessage, id: MessageId, source: PeerId, now: number,
  maxPacketBytes = DEFAULT_MAX_PACKET_BYTES,
): MeshMessage {
  // Outgoing messages are runtime inputs too. A spread here could otherwise
  // let untyped callers override engine-owned TTL, UUID, source, or version.
  const base = objectFields(input, ['kind', 'payload'], ['destination'], 'Outgoing message');
  const direct = base.kind === 'chat' || base.kind === 'sos-response';
  const fields = direct
    ? objectFields(input, ['kind', 'payload', 'destination'], [], 'Outgoing message')
    : objectFields(input, ['kind', 'payload'], [], 'Outgoing message');
  return validatePacket({
    version: 1,
    id,
    source,
    destination: direct ? fields.destination : BROADCAST,
    createdAt: now,
    ttl: fields.kind === 'sos' || fields.kind === 'sos-response' ? SOS_TTL : NORMAL_TTL,
    kind: fields.kind,
    payload: fields.payload,
  }, maxPacketBytes);
}
