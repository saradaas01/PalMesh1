export class SecurityError extends Error {
  constructor(message: string) { super(message); this.name = 'SecurityError'; }
}

/** Safe classification for application recovery; never inspect exception text. */
export class RecipientKeyError extends SecurityError {
  constructor(readonly reason: 'unknown' | 'unavailable') {
    super(reason === 'unknown' ? 'Recipient public keys are unknown.' : 'Peer-key persistence is unavailable.');
    this.name = 'RecipientKeyError';
  }
}

/** Established key material is missing/corrupt. Keep this distinct from a
 * temporarily locked native vault so bootstrap can offer safe recovery steps. */
export class SecurityRecoveryError extends SecurityError {
  constructor(message: string) { super(message); this.name = 'SecurityRecoveryError'; }
}

