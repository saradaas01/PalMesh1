import { DtnEngine, DEFAULT_DTN_CONFIG, type DtnConfig } from '../../dtn/application/DtnEngine';
import type { Clock, DtnStore, IdGenerator } from '../../dtn/domain/ports';
import type { PeerId } from '../../dtn/domain/types';
import type { PacketSecurity } from '../../dtn/domain/ports';
import type { HandshakeSecurity } from '../../security/domain/types';
import type { PeerRegistry, RadioAdapter } from '../domain/ports';
import { MeshCoordinator, type MeshConfig } from './MeshCoordinator';

export interface MeshNodeOptions {
  readonly deviceId: PeerId;
  readonly store: DtnStore;
  readonly registry: PeerRegistry;
  readonly radios: readonly RadioAdapter[];
  readonly ids: IdGenerator;
  readonly clock?: Clock;
  readonly dtnConfig?: Partial<DtnConfig>;
  readonly meshConfig?: Partial<MeshConfig>;
  readonly security?: PacketSecurity & HandshakeSecurity;
}

/** Wire the two use cases without a construction cycle. Radios start only after
 * SQLite is ready; shutdown removes peers and cancels native I/O before DTN stops.
 * The DTN deadline must leave time for a complete Wi-Fi-to-BLE fallback. */
export function createMeshNode(options: MeshNodeOptions): {
  readonly engine: DtnEngine;
  readonly mesh: MeshCoordinator;
  start(): Promise<void>;
  stop(): Promise<void>;
} {
  const shared = { deviceId: options.deviceId, ids: options.ids, ...(options.clock ? { clock: options.clock } : {}),
    ...(options.security ? { security: options.security } : {}) };
  const mesh = new MeshCoordinator({
    ...shared, radios: options.radios, registry: options.registry,
    ...(options.meshConfig ? { config: options.meshConfig } : {}),
  });
  const minimumDeadline = (mesh.config.writeTimeoutMs + mesh.config.ackTimeoutMs) * options.radios.length + 1_000;
  const dtnConfig = { sendTimeoutMs: minimumDeadline, ...options.dtnConfig };
  if (dtnConfig.sendTimeoutMs < minimumDeadline) {
    throw new RangeError('DTN sendTimeoutMs must cover native writes, ACKs, and radio fallback');
  }
  const packetLimit = dtnConfig.maxPacketBytes ?? DEFAULT_DTN_CONFIG.maxPacketBytes;
  if (packetLimit > 16 * 1_024 || packetLimit + 512 > mesh.config.maxFrameBytes) {
    throw new RangeError('DTN packet limit exceeds the mesh wire envelope budget');
  }
  const engine = new DtnEngine({ ...shared, store: options.store, transport: mesh, config: dtnConfig });
  mesh.bindReceiver(engine);
  let lifecycle = Promise.resolve();
  let intent = 0;
  const transition = (operation: () => Promise<void>): Promise<void> => {
    const result = lifecycle.then(operation);
    lifecycle = result.catch(() => {});
    return result;
  };
  return {
    engine,
    mesh,
    start: () => {
      const requested = ++intent;
      return transition(async () => {
        if (requested !== intent) return;
        await engine.start();
        if (requested !== intent) return;
        try { await mesh.start(); }
        catch (error) {
          await mesh.stop();
          await engine.stop();
          throw error;
        }
      });
    },
    stop: () => {
      intent += 1;
      const stopping = mesh.stop();
      return transition(async () => {
        try { await stopping; }
        finally { await engine.stop(); }
      });
    },
  };
}
