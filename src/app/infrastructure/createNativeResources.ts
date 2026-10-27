import { OnboardingPreferences } from '../../features/onboarding/OnboardingPreferences';
import { ContactDirectory } from '../../features/contacts/ContactDirectory';
import { open, isSQLCipher, type DB } from '@op-engineering/op-sqlite';
import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import { BleManager } from 'react-native-ble-plx';
import { v4 as uuidV4 } from 'uuid';
import { ChatService, SqliteChatRepository } from '../../features/chat';
import { OpSqliteDatabase, SqliteDtnStore, type IdGenerator } from '../../features/dtn';
import { LocationService, SqliteLocationRepository, type NativeOfflineMapOptions } from '../../features/maps';
import { EmergencyService, SqliteEmergencyRepository, type EmergencyAlerts } from '../../features/emergency';
import { NativeSecurityVault, SecurityService, SecurityRecoveryError } from '../../features/security';
import { bundledMapOptions } from '../../features/maps/infrastructure/bundledMap';
import {
  createReactNativeLocationSource,
  createReactNativeOfflineMapSource,
} from '../../features/maps/infrastructure/reactNative';
import {
  BlePlxRadio, NativeBlePeripheralRadio, NativeWifiDirectRadio,
  SqlitePeerRegistry, createMeshNode, type NativeEventSource,
} from '../../features/mesh';
import type { NativeRadioModule } from '../../features/mesh/infrastructure/radios/NativeStreamRadio';
import type { RadioPermissions, RuntimeResources } from '../domain/types';
import { EncryptedStorage } from './EncryptedStorage';
import { BootstrapError } from '../domain/BootstrapError';
import { lazyBleManager } from './LazyBleManager';

export interface CreateNativeResourcesOptions {
  readonly permissions: RadioPermissions;
  /** Supply an independently trusted digest when distributing a bundled map.
   * Missing assets leave maps unavailable while messaging and GPS remain usable.
   */
  readonly mapOptions?: NativeOfflineMapOptions;
  readonly alerts?: EmergencyAlerts;
}

interface LinkedRadioModule extends NativeRadioModule {
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

/** The native-only composition boundary. Import the secure-random polyfill in
 * index.js before this module is loaded; uuid throws if secure entropy is absent.
 * Merely constructing resources never starts radios, requests GPS, or shows an
 * Android permission dialog. AppRuntime owns service and node lifecycle.
 */
export async function createNativeResources(options: CreateNativeResourcesOptions): Promise<RuntimeResources> {
  const handles: DB[] = [];
  let manager: BleManager | undefined;
  let releasing: Promise<void> | undefined;
  const release = (): Promise<void> => {
    if (releasing) return releasing;
    releasing = (async () => {
      const failures: unknown[] = [];
      if (manager) {
        try { await manager.destroy(); } catch (error) { failures.push(error); }
      }
      // Each feature owns its entire connection. Closing in reverse order also
      // cleans partially constructed resources when any adapter/schema fails.
      for (const handle of [...handles].reverse()) {
        try { handle.close(); } catch (error) { failures.push(error); }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, 'Could not release all PalMesh native resources');
    })();
    return releasing;
  };
  let vault: NativeSecurityVault;
  try { vault = new NativeSecurityVault(NativeModules.PalMeshSecurity); }
  catch { throw new BootstrapError('secure-storage-unavailable'); }
  const encryptedStorage = new EncryptedStorage(vault, isSQLCipher, open);
  const database = (name: string): OpSqliteDatabase => {
    const connection = encryptedStorage.connect(name);
    handles.push(connection);
    return new OpSqliteDatabase(connection, { exclusiveConnection: true });
  };

  try {
    const ids: IdGenerator = { next: () => uuidV4() };
    const security = new SecurityService(vault);
    await encryptedStorage.initialize({
      beforeProvision: async existingKey => {
        try { await security.initialize({ requireExistingIdentity: existingKey }); }
        catch (error) {
          throw new BootstrapError(error instanceof SecurityRecoveryError
            ? 'identity-recovery-required' : 'secure-storage-unavailable');
        }
      },
    });
    const contacts = new ContactDirectory(security, vault);
    await contacts.initialize();
    const onboarding = new OnboardingPreferences(security.deviceId,vault);
    await onboarding.initialize();
    const deviceId = security.deviceId;
    const store = new SqliteDtnStore(database('palmesh-dtn.sqlite'));
    const registry = new SqlitePeerRegistry(database('palmesh-peers.sqlite'));
    const chatRepository = new SqliteChatRepository(database('palmesh-chat.sqlite'));
    const locationRepository = new SqliteLocationRepository(database('palmesh-locations.sqlite'));
    const emergencyRepository = new SqliteEmergencyRepository(database('palmesh-emergencies.sqlite'));

    // The delivered host is Android first. Creating CoreBluetooth managers can
    // itself prompt on iOS; do not do that at startup before a dedicated iOS
    // host and native peripheral/permission lifecycle are implemented.
    const supported = Platform.OS === 'android' || Platform.OS === 'ios';
    const wifi = Platform.OS === 'android' ? radioModule(NativeModules.PalMeshWifiDirect) : undefined;
    const peripheral = supported ? radioModule(NativeModules.PalMeshBlePeripheral) : undefined;
    // CoreBluetooth construction can prompt. On iOS defer it until the user
    // explicitly grants authorization; a later radio refresh creates it lazily.
    const bleManager = supported ? lazyBleManager(() => {
      manager ??= new BleManager();
      return manager;
    }) : undefined;
    const node = createMeshNode({
      deviceId, ids, store, registry, security,
      radios: [
        new NativeWifiDirectRadio(wifi, eventSource(wifi)),
        new BlePlxRadio(bleManager, {
          permissionsGranted: async () => {
            const granted = await options.permissions.check();
            return (granted.platform === 'android' || granted.platform === 'ios') && granted.bluetooth;
          },
          ...(peripheral ? { peripheral: new NativeBlePeripheralRadio(peripheral, eventSource(peripheral)) } : {}),
        }),
      ],
    });
    const chat = new ChatService({ engine: node.engine, mesh: node.mesh, repository: chatRepository });
    const locations = new LocationService({
      engine: node.engine,
      repository: locationRepository,
      source: createReactNativeLocationSource(),
      mapSource: createReactNativeOfflineMapSource({ ...bundledMapOptions, ...options.mapOptions }),
    });
    const emergency = new EmergencyService({ engine: node.engine, repository: emergencyRepository,
      ...(options.alerts ? { alerts: options.alerts } : {}) });
    return { deviceId, node, chat, locations, emergency, security, contacts, onboarding, release };
  } catch (error) {
    // Preserve the cause of bootstrap failure even when native cleanup also
    // fails. Every remaining handle is still given a chance to close.
    await release().catch(() => undefined);
    throw error;
  }
}

function eventSource(native: LinkedRadioModule | undefined): NativeEventSource | undefined {
  if (!native) return undefined;
  const emitter = new NativeEventEmitter(native);
  return { addListener: (name, listener) => emitter.addListener(name, event => listener(event)) };
}

function radioModule(value: unknown): LinkedRadioModule | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isLinkedRadioModule(value)) throw new Error('Invalid linked PalMesh radio native module');
  return value;
}

function isLinkedRadioModule(value: unknown): value is LinkedRadioModule {
  if (typeof value !== 'object' || value === null) return false;
  const methods = ['getStatus', 'start', 'stop', 'connect', 'disconnect', 'write', 'cancel', 'addListener', 'removeListeners'];
  return methods.every(method => method in value && typeof Reflect.get(value, method) === 'function');
}
