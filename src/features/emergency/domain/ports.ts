import type { AcceptResult, DtnEvent, OutgoingMessage, PeerId, RoutingHistoryEntry } from '../../dtn/domain/types';
import type { EmergencyEntry } from './types';

/** Only connect an authenticated local-projection engine: relay control packets
 * and unverified radio bytes must never be presented as responder statements. */
export interface EmergencyEngine {
  readonly deviceId: PeerId;
  subscribe(listener: (event: DtnEvent) => void): () => void;
  historyWithCustody(limit?: number): Promise<readonly RoutingHistoryEntry[]>;
  publish(input: OutgoingMessage): Promise<Exclude<AcceptResult, { readonly status: 'duplicate' }>>;
}
export interface EmergencyRepository {
  initialize(localDeviceId: PeerId): Promise<void>;
  ingest(entries: readonly RoutingHistoryEntry[]): Promise<void>;
  read(): Promise<readonly EmergencyEntry[]>;
  dismiss(sosId: string): Promise<void>;
  /** Claim before native side effects: persistent at-most-once alert attempts.
   * A crash in between can skip a notification; the durable inbox remains. */
  claimNotification(sosId: string): Promise<boolean>;
}
export interface EmergencyAlerts {
  /** Native adapters must show generic private content, without source, text or coordinates. */
  notifyIncoming(emergency: { readonly id: string; readonly source: string; readonly text: string }): Promise<void>;
  cancel(id: string): Promise<void>;
}
