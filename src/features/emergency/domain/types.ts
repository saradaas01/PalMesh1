import type { LocationFix, PeerId } from '../../dtn/domain/types';

export interface EmergencyResponse {
  readonly id: string;
  readonly responder: PeerId;
  readonly receivedAt: number;
  /** This records a person's intention; it cannot confirm assistance. */
  readonly status: 'responding';
}
export interface EmergencyEntry {
  readonly id: string;
  readonly source: PeerId;
  readonly text: string;
  readonly createdAt: number;
  readonly receivedAt: number;
  readonly expiresAt: number;
  readonly outgoing: boolean;
  readonly dismissed: boolean;
  readonly responseId: string | null;
  readonly responses: readonly EmergencyResponse[];
  readonly location?: LocationFix;
}
export interface EmergencySnapshot {
  readonly status: 'idle' | 'loading' | 'ready' | 'error';
  readonly entries: readonly EmergencyEntry[];
  /** Most recent unreviewed incoming SOS. Rendering it must preserve global SOS access. */
  readonly urgent: EmergencyEntry | null;
  readonly pendingResponseIds: readonly string[];
  readonly issue: 'storage-unavailable' | 'response-unavailable' | 'queue-full' | 'notification-unavailable' | null;
  readonly now: number;
}
export type EmergencyActionResult =
  | { readonly status: 'queued'; readonly messageId: string }
  | { readonly status: 'rejected'; readonly reason: 'unavailable' | 'capacity' | 'busy' | 'invalid' | 'expired' };
