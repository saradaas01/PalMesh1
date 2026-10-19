import type { ChatService } from '../../features/chat';
import type { LocationService } from '../../features/maps';
import type { AcceptResult, OutgoingMessage, PeerId, PowerMode } from '../../features/dtn';
import type { MeshEvent, RadioKind, RadioStatus } from '../../features/mesh';
import type { EmergencyService } from '../../features/emergency';
import type { SecurityService } from '../../features/security';
import type { BatteryState } from '../infrastructure/NativeMeshRuntime';

export interface RadioPermissionReport {
  readonly platform: 'android' | 'ios' | 'unsupported';
  readonly wifiDirect: boolean;
  readonly bluetooth: boolean;
  readonly canRequest: boolean;
}

export interface RadioPermissions {
  /** Read-only: startup and resume never trigger OS prompts. */
  check(): Promise<RadioPermissionReport>;
  /** Called only from the user's Enable nearby connections action. */
  request(): Promise<RadioPermissionReport>;
}

export interface AppNode {
  readonly engine: {
    start(): Promise<void>;
    publish(input: OutgoingMessage): Promise<Exclude<AcceptResult, { readonly status: 'duplicate' }>>;
    setPowerMode(mode: PowerMode): void;
  };
  readonly mesh: {
    start(): Promise<void>;
    stop(): Promise<void>;
    refreshRadios(): Promise<void>;
    connectedPeers(): readonly PeerId[];
    subscribe(listener: (event: MeshEvent) => void): () => void;
  };
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface RuntimeResources {
  readonly deviceId: PeerId;
  readonly node: AppNode;
  readonly chat: Pick<ChatService, keyof ChatService>;
  readonly locations: Pick<LocationService, keyof LocationService>;
  readonly emergency?: EmergencyService;
  readonly security?: SecurityService;
  /** Release manager and database handles only after node/features have stopped. */
  release(): Promise<void>;
}

export type AppRoute = 'chat' | 'maps' | 'emergencies' | 'contacts';
export interface AppSnapshot {
  readonly status: 'idle' | 'starting' | 'ready' | 'error';
  readonly route: AppRoute;
  readonly foreground: boolean;
  readonly resources: RuntimeResources | null;
  readonly permissions: RadioPermissionReport | null;
  readonly radios: Readonly<Partial<Record<RadioKind, RadioStatus>>>;
  readonly connectedPeers: number;
  readonly requestingPermissions: boolean;
  readonly pendingSos: boolean;
  readonly powerMode: PowerMode;
  readonly backgroundEnabled: boolean;
  readonly backgroundBusy: boolean;
  readonly backgroundSupported: boolean;
  readonly battery: BatteryState | null;
  readonly automaticPowerMode: boolean;
  readonly alertsEnabled: boolean | null;
  readonly alertsBusy: boolean;
  readonly issue: 'startup-failed' | 'permissions-unavailable' | 'radio-error' | 'queue-full' | 'sos-unavailable' | 'background-unavailable' | 'alerts-unavailable' | null;
  readonly notice: 'sos-queued' | null;
}
