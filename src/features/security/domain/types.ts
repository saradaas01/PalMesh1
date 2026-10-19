import type { PeerId } from '../../dtn/domain/types';

export interface PublicIdentity {
  readonly signingKey: string;
  readonly encryptionKey: string;
}

export interface HandshakeAuthentication extends PublicIdentity {
  readonly signature: string;
}

export interface SecurityVault {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  /** Must use the operating system CSPRNG. Never substitute Math.random. */
  randomBytes(length: number): Promise<Uint8Array>;
}

/** Self-certifying identities prove possession of a key, not a person's name,
 * role, or trustworthiness. Compare fingerprints in person before trusting one. */
export interface HandshakeSecurity {
  readonly deviceId: PeerId;
  authenticate(nonce: string, echo?: string): HandshakeAuthentication;
  verifyHandshake(peerId: PeerId, nonce: string, echo: string | undefined, authentication: HandshakeAuthentication | undefined): void;
  /** A per-session MAC protects durable hop ACKs and all post-handshake frames. */
  sessionTag(peerId: PeerId, localNonce: string, remoteNonce: string, content: string): string;
  verifySessionTag(peerId: PeerId, localNonce: string, remoteNonce: string, content: string, tag: string | undefined): void;
}
