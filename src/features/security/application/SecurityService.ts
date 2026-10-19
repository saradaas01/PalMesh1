import { ed25519, x25519 } from '@noble/curves/ed25519';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { sha256 } from '@noble/hashes/sha256';
import { hkdf } from '@noble/hashes/hkdf';
import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils';
import { equalBytes } from '@noble/ciphers/utils';
import { hmac } from '@noble/hashes/hmac';
import type { Clock, PacketSecurity } from '../../dtn/domain/ports';
import type { MeshMessage, MessageSecurity, PeerId } from '../../dtn/domain/types';
import { NORMAL_TTL, SOS_TTL } from '../../dtn/domain/types';
import { parseMessage } from '../../dtn/domain/validation';
import { base64ToBytes, bytesToBase64, utf8Decode, utf8Encode } from '../../mesh/domain/wire';
import type { HandshakeAuthentication, HandshakeSecurity, PublicIdentity, SecurityVault } from '../domain/types';

const IDENTITY_RECORD = 'identity-v1';
const DIRECTORY_RECORD = 'peer-directory-v1';
const MAX_PEERS = 256;
const MAX_VERIFIED = 256;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const FUTURE_SKEW_MS = 5 * 60 * 1000;
const HEX_32 = /^[0-9a-f]{64}$(?![\s\S])/;
const HEX_64 = /^[0-9a-f]{128}$(?![\s\S])/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/;

export class SecurityError extends Error {
  constructor(message: string) { super(message); this.name = 'SecurityError'; }
}

function ownObject(input: unknown, names: readonly string[]): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)
    || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) {
    throw new SecurityError('Invalid secure storage record.');
  }
  const keys = Reflect.ownKeys(input);
  if (keys.length !== names.length || keys.some(key => typeof key !== 'string' || !names.includes(key))) {
    throw new SecurityError('Invalid secure storage fields.');
  }
  const fields: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of names) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !('value' in descriptor)) throw new SecurityError('Invalid secure storage property.');
    fields[key] = descriptor.value;
  }
  return fields;
}

function publicIdentity(input: unknown): PublicIdentity {
  const fields = ownObject(input, ['signingKey', 'encryptionKey']);
  if (typeof fields.signingKey !== 'string' || !HEX_32.test(fields.signingKey)
    || typeof fields.encryptionKey !== 'string' || !HEX_32.test(fields.encryptionKey)) {
    throw new SecurityError('Invalid public identity.');
  }
  return Object.freeze({ signingKey: fields.signingKey, encryptionKey: fields.encryptionKey });
}

export function identityFingerprint(identity: PublicIdentity): PeerId {
  const validated = publicIdentity(identity);
  return `pm1:${bytesToHex(sha256(concatBytes(utf8Encode('PalMesh identity v1'),
    hexToBytes(validated.signingKey), hexToBytes(validated.encryptionKey))))}`;
}

function hopHash(proof: Uint8Array): Uint8Array {
  return sha256(concatBytes(utf8Encode('PalMesh hop v1'), proof));
}

function handshakeBytes(peerId: PeerId, nonce: string, echo: string | undefined): Uint8Array {
  if (!UUID.test(nonce) || (echo !== undefined && !UUID.test(echo))) throw new SecurityError('Invalid handshake challenge.');
  return utf8Encode(JSON.stringify(['PalMesh handshake v1', echo === undefined ? 'hello' : 'hello-ack', peerId, nonce, echo ?? null]));
}

/** Explicit field order avoids depending on native object property order. TTL
 * and hopProof are excluded; the signed hash commitment constrains both. */
function signedBytes(message: MeshMessage, security: MessageSecurity): Uint8Array {
  return utf8Encode(JSON.stringify(['PalMesh packet v1', message.version, message.id, message.source,
    message.destination, message.createdAt, message.kind, message.payload, security.version,
    security.signingKey, security.encryptionKey, security.initialTtl, security.hopCommitment,
    security.encryption ? [security.encryption.recipientKey, security.encryption.nonce] : null]));
}

function additionalData(message: MeshMessage): Uint8Array {
  return utf8Encode(JSON.stringify(['PalMesh direct chat v1', message.version, message.id,
    message.source, message.destination, message.createdAt, message.kind]));
}

/** Uses upstream primitive implementations, but this application
 * protocol has not had an independent cryptographic audit. Static X25519 keys
 * allow offline queued messaging and do not provide forward secrecy. */
export class SecurityService implements PacketSecurity, HandshakeSecurity {
  private signingSecret: Uint8Array | undefined;
  private encryptionSecret: Uint8Array | undefined;
  private identity: PublicIdentity | undefined;
  private localId: PeerId | undefined;
  private readonly peers = new Map<PeerId, PublicIdentity>();
  private readonly pinnedPeers = new Set<PeerId>();
  private readonly verified = new Map<string, string>();
  private initialization: Promise<void> | undefined;
  private directoryWork: Promise<void> = Promise.resolve();
  private directoryError: unknown;
  private tokens = 64;
  private lastRefill = 0;

  constructor(private readonly vault: SecurityVault, private readonly clock: Clock = { now: () => Date.now() }) {}

  get deviceId(): PeerId {
    if (!this.localId) throw new SecurityError('Initialize secure identity before starting the app.');
    return this.localId;
  }

  get publicIdentity(): PublicIdentity {
    if (!this.identity) throw new SecurityError('Secure identity is unavailable.');
    return this.identity;
  }

  initialize(): Promise<void> {
    // A failed or corrupt vault does not silently mint a replacement identity.
    this.initialization ??= this.loadIdentity();
    return this.initialization;
  }

  authenticate(nonce: string, echo?: string): HandshakeAuthentication {
    const identity = this.publicIdentity;
    return Object.freeze({ ...identity,
      signature: bytesToHex(ed25519.sign(handshakeBytes(this.deviceId, nonce, echo), this.signingSecret!)),
    });
  }

  verifyHandshake(peerId: PeerId, nonce: string, echo: string | undefined, authentication: HandshakeAuthentication | undefined): void {
    if (!authentication) throw new SecurityError('Unauthenticated mesh peer.');
    const fields = ownObject(authentication, ['signingKey', 'encryptionKey', 'signature']);
    const identity = publicIdentity({ signingKey: fields.signingKey, encryptionKey: fields.encryptionKey });
    if (identityFingerprint(identity) !== peerId || typeof fields.signature !== 'string' || !HEX_64.test(fields.signature)) {
      throw new SecurityError('Handshake identity does not match its public keys.');
    }
    this.consumeVerification();
    if (!ed25519.verify(hexToBytes(fields.signature), handshakeBytes(peerId, nonce, echo), hexToBytes(identity.signingKey), { zip215: false })) {
      throw new SecurityError('Invalid handshake signature.');
    }
    this.remember(peerId, identity);
  }

  sessionTag(peerId: PeerId, localNonce: string, remoteNonce: string, content: string): string {
    const peer = this.peers.get(peerId);
    if (!peer || !UUID.test(localNonce) || !UUID.test(remoteNonce)) throw new SecurityError('Session peer is not authenticated.');
    const participants = [[this.deviceId, localNonce], [peerId, remoteNonce]]
      .sort((a, b) => a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0);
    const context = utf8Encode(JSON.stringify(['PalMesh session v1', participants]));
    const shared = x25519.getSharedSecret(this.encryptionSecret!, hexToBytes(peer.encryptionKey));
    const key = hkdf(sha256, shared, sha256(context), utf8Encode('PalMesh frame MAC v1'), 32);
    shared.fill(0);
    try { return bytesToHex(hmac(sha256, key, utf8Encode(content))); }
    finally { key.fill(0); }
  }

  verifySessionTag(peerId: PeerId, localNonce: string, remoteNonce: string, content: string, tag: string | undefined): void {
    if (!tag || !HEX_32.test(tag) || !equalBytes(hexToBytes(tag), hexToBytes(this.sessionTag(peerId, localNonce, remoteNonce, content)))) {
      throw new SecurityError('Invalid session authentication tag.');
    }
  }

  async seal(message: MeshMessage): Promise<MeshMessage> {
    if (message.source !== this.deviceId || message.security) throw new SecurityError('Cannot sign a foreign or already sealed packet.');
    const identity = this.publicIdentity;
    const seed = await this.entropy(32);
    let commitment = seed;
    for (let i = 0; i < message.ttl; i += 1) commitment = hopHash(commitment);
    let unsigned: MeshMessage = message;
    let encryption: MessageSecurity['encryption'];
    if (message.kind === 'chat') {
      if (message.destination === '*' || message.destination === this.deviceId) throw new SecurityError('Secure chat requires another device identity.');
      await this.directoryWork;
      if (this.directoryError) throw new SecurityError('Peer-key persistence is unavailable.');
      const recipient = this.peers.get(message.destination);
      if (!recipient) throw new SecurityError('Recipient public keys are unknown. Connect to that device or import its verified identity first.');
      const nonce = await this.entropy(24);
      encryption = Object.freeze({ recipientKey: recipient.encryptionKey, nonce: bytesToHex(nonce) });
      const key = this.chatKey(this.encryptionSecret!, recipient.encryptionKey, message);
      try {
        const cipher = xchacha20poly1305(key, nonce, additionalData(message));
        unsigned = { ...message, payload: { text: bytesToBase64(cipher.encrypt(utf8Encode(message.payload.text))) } };
      } finally { key.fill(0); }
    }
    const security: MessageSecurity = {
      version: 1, ...identity, signature: '0'.repeat(128), initialTtl: message.ttl,
      hopCommitment: bytesToHex(commitment), hopProof: bytesToHex(seed), ...(encryption ? { encryption } : {}),
    };
    const signature = bytesToHex(ed25519.sign(signedBytes(unsigned, security), this.signingSecret!));
    seed.fill(0);
    const parsed = parseMessage({ ...unsigned, security: { ...security, signature } });
    if (!parsed.ok) throw new SecurityError(parsed.reason);
    return parsed.message;
  }

  async verify(message: MeshMessage): Promise<void> {
    const security = message.security;
    if (!security) throw new SecurityError('Unsigned packets are rejected.');
    const maximum = message.kind === 'sos' || message.kind === 'sos-response' ? SOS_TTL : NORMAL_TTL;
    if (security.initialTtl !== maximum || message.ttl > security.initialTtl) throw new SecurityError('Invalid signed hop budget.');
    const now = this.now();
    if (message.createdAt > now + FUTURE_SKEW_MS || message.createdAt < now - MAX_AGE_MS) {
      throw new SecurityError('Signed packet is expired or its clock is too far ahead.');
    }
    if (identityFingerprint({ signingKey: security.signingKey, encryptionKey: security.encryptionKey }) !== message.source) {
      throw new SecurityError('Packet source does not match its signing keys.');
    }
    if ((message.kind === 'chat') !== Boolean(security.encryption) || (message.kind === 'chat' && message.destination === '*')) {
      throw new SecurityError('Direct chats require end-to-end encryption.');
    }
    let proof = hexToBytes(security.hopProof);
    for (let i = 0; i < message.ttl; i += 1) proof = hopHash(proof);
    if (!equalBytes(proof, hexToBytes(security.hopCommitment))) throw new SecurityError('Hop proof does not match the remaining TTL.');
    const data = signedBytes(message, security);
    const digest = bytesToHex(sha256(data));
    if (this.verified.get(security.signature) !== digest) {
      this.consumeVerification();
      if (!ed25519.verify(hexToBytes(security.signature), data, hexToBytes(security.signingKey), { zip215: false })) {
        throw new SecurityError('Invalid packet signature.');
      }
      if (this.verified.size >= MAX_VERIFIED) this.verified.delete(this.verified.keys().next().value!);
      this.verified.set(security.signature, digest);
    }
    this.remember(message.source, { signingKey: security.signingKey, encryptionKey: security.encryptionKey });
    // Validate AEAD before acknowledging a packet addressed to this endpoint.
    if (message.kind === 'chat' && message.destination === this.deviceId) this.decrypt(message);
  }

  async project(message: MeshMessage): Promise<MeshMessage | null> {
    if (message.kind !== 'chat') return message;
    if (message.source !== this.deviceId && message.destination !== this.deviceId) return null;
    // Signature verification happens at admission, and retained wire objects
    // are validated by SQLite. Decryption still authenticates on every read.
    return this.decrypt(message);
  }

  forNextHop(message: MeshMessage): MeshMessage | null {
    if (message.ttl <= 0) return null;
    if (!message.security) throw new SecurityError('Cannot forward an unsigned packet.');
    return Object.freeze({ ...message, ttl: message.ttl - 1,
      security: Object.freeze({ ...message.security, hopProof: bytesToHex(hopHash(hexToBytes(message.security.hopProof))) }),
    });
  }

  /** Share the full self-certifying record offline (for example via a QR code).
   * Calling this establishes a cryptographic address, not human verification. */
  async importPeer(identity: PublicIdentity): Promise<PeerId> {
    const validated = publicIdentity(identity);
    const id = identityFingerprint(validated);
    if (id === this.deviceId) throw new SecurityError('Cannot import the local identity as a peer.');
    this.remember(id, validated, true);
    await this.directoryWork;
    if (this.directoryError) throw new SecurityError('Unable to persist recipient keys.');
    return id;
  }

  private decrypt(message: MeshMessage): MeshMessage {
    if (message.kind !== 'chat' || !message.security?.encryption) throw new SecurityError('Invalid encrypted chat.');
    const security = message.security;
    const encrypted = security.encryption!;
    const incoming = message.destination === this.deviceId;
    if (incoming && encrypted.recipientKey !== this.publicIdentity.encryptionKey) throw new SecurityError('Ciphertext targets a different recipient key.');
    const otherKey = incoming ? security.encryptionKey : encrypted.recipientKey;
    const key = this.chatKey(this.encryptionSecret!, otherKey, message);
    try {
      const plaintext = xchacha20poly1305(key, hexToBytes(encrypted.nonce), additionalData(message))
        .decrypt(base64ToBytes(message.payload.text, 16 * 1024));
      try {
        const text = utf8Decode(plaintext);
        if (text.trim().length === 0 || text.length > 4096) throw new SecurityError('Decrypted chat is invalid.');
        // A projection deliberately drops wire security metadata: its plaintext
        // must never be mistaken for a packet that may enter the routing queue.
        const { security: _security, ...envelope } = message;
        return Object.freeze({ ...envelope, payload: Object.freeze({ text }) });
      } finally { plaintext.fill(0); }
    } catch { throw new SecurityError('Unable to authenticate direct-message ciphertext.'); }
    finally { key.fill(0); }
  }

  private chatKey(secret: Uint8Array, publicKey: string, message: MeshMessage): Uint8Array {
    let shared: Uint8Array;
    try { shared = x25519.getSharedSecret(secret, hexToBytes(publicKey)); }
    catch { throw new SecurityError('Invalid peer encryption key.'); }
    try { return hkdf(sha256, shared, sha256(additionalData(message)), utf8Encode('PalMesh X25519 XChaCha20-Poly1305 v1'), 32); }
    finally { shared.fill(0); }
  }

  private async loadIdentity(): Promise<void> {
    const raw = await this.vault.read(IDENTITY_RECORD);
    let signing: Uint8Array;
    let encryption: Uint8Array;
    if (raw === null) {
      signing = await this.entropy(32);
      encryption = await this.entropy(32);
      await this.vault.write(IDENTITY_RECORD, JSON.stringify({ version: 1,
        signingSecret: bytesToHex(signing), encryptionSecret: bytesToHex(encryption) }));
    } else {
      if (raw.length > 1024) throw new SecurityError('Secure identity record is oversized.');
      const fields = ownObject(JSON.parse(raw) as unknown, ['version', 'signingSecret', 'encryptionSecret']);
      if (fields.version !== 1 || typeof fields.signingSecret !== 'string' || !HEX_32.test(fields.signingSecret)
        || typeof fields.encryptionSecret !== 'string' || !HEX_32.test(fields.encryptionSecret)) {
        throw new SecurityError('Secure identity record is corrupt or unsupported.');
      }
      signing = hexToBytes(fields.signingSecret);
      encryption = hexToBytes(fields.encryptionSecret);
    }
    const directory = await this.vault.read(DIRECTORY_RECORD);
    if (directory !== null) {
      if (directory.length > 100 * 1024) throw new SecurityError('Peer key directory is oversized.');
      const entries: unknown = JSON.parse(directory);
      if (!Array.isArray(entries) || entries.length > MAX_PEERS) throw new SecurityError('Invalid peer key directory.');
      for (const entry of entries) {
        const fields = ownObject(entry, ['signingKey', 'encryptionKey', 'pinned']);
        if (typeof fields.pinned !== 'boolean') throw new SecurityError('Invalid persisted contact state.');
        const identity = publicIdentity({ signingKey: fields.signingKey, encryptionKey: fields.encryptionKey });
        const id = identityFingerprint(identity);
        if (this.peers.has(id)) throw new SecurityError('Duplicate persisted peer identity.');
        this.peers.set(id, identity);
        if (fields.pinned) this.pinnedPeers.add(id);
      }
    }
    this.signingSecret = signing;
    this.encryptionSecret = encryption;
    this.identity = Object.freeze({ signingKey: bytesToHex(ed25519.getPublicKey(signing)),
      encryptionKey: bytesToHex(x25519.getPublicKey(encryption)) });
    this.localId = identityFingerprint(this.identity);
  }

  private remember(peerId: PeerId, identity: PublicIdentity, pin = false): void {
    if (peerId === this.deviceId) return;
    if (this.peers.has(peerId)) {
      if (!pin || this.pinnedPeers.has(peerId)) return;
    } else {
      if (this.peers.size >= MAX_PEERS) {
        const evicted = [...this.peers.keys()].find(id => !this.pinnedPeers.has(id));
        if (!evicted) {
          if (pin) throw new SecurityError('Saved contact capacity reached.');
          return;
        }
        this.peers.delete(evicted);
      }
      this.peers.set(peerId, Object.freeze({ ...identity }));
    }
    if (pin) this.pinnedPeers.add(peerId);
    // One bounded snapshot and a coalesced writer avoid unbounded promise/data
    // accumulation during discovery floods. Public key persistence errors make
    // subsequent direct-message publication fail closed.
    if (this.directoryQueued) return;
    this.directoryQueued = true;
    this.directoryWork = this.directoryWork.then(async () => {
      this.directoryQueued = false;
      await this.vault.write(DIRECTORY_RECORD, JSON.stringify([...this.peers.entries()]
        .map(([id, keys]) => ({ ...keys, pinned: this.pinnedPeers.has(id) }))));
      this.directoryError = undefined;
    }).catch(error => { this.directoryQueued = false; this.directoryError = error; });
  }
  private directoryQueued = false;

  private async entropy(length: number): Promise<Uint8Array> {
    const bytes = await this.vault.randomBytes(length);
    if (!(bytes instanceof Uint8Array) || bytes.length !== length) throw new SecurityError('Operating-system entropy is unavailable.');
    return new Uint8Array(bytes);
  }

  private consumeVerification(): void {
    const now = this.now();
    this.tokens = Math.min(64, this.tokens + Math.max(0, now - this.lastRefill) * 64 / 1000);
    this.lastRefill = now;
    if (this.tokens < 1) throw new SecurityError('Signature verification capacity reached.');
    this.tokens -= 1;
  }

  private now(): number {
    const value = this.clock.now();
    if (!Number.isSafeInteger(value) || value < 0) throw new SecurityError('Invalid security clock.');
    return value;
  }
}
