/** Safe, actionable bootstrap categories. Raw native failures, database paths,
 * key material and arbitrary exception messages must never enter app state. */
export type BootstrapErrorCode =
  | 'secure-storage-unavailable'
  | 'encryption-unavailable'
  | 'data-recovery-required'
  | 'identity-recovery-required'
  | 'provisioning-incomplete';

const MESSAGES: Readonly<Record<BootstrapErrorCode, string>> = Object.freeze({
  'secure-storage-unavailable': 'Secure device storage is unavailable. Unlock the device and retry.',
  'encryption-unavailable': 'This build cannot provide the required encrypted storage.',
  'data-recovery-required': 'Existing local data or its encryption key requires recovery. Preserve the installation.',
  'identity-recovery-required': 'The established device identity requires recovery. Preserve existing data and keys.',
  'provisioning-incomplete': 'Secure installation setup did not finish. Existing data and keys were preserved.',
});

export class BootstrapError extends Error {
  constructor(readonly code: BootstrapErrorCode) {
    super(MESSAGES[code]);
    this.name = 'BootstrapError';
  }
}
