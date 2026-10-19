import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeModules, PermissionsAndroid, Platform } from 'react-native';
import type { RadioPermissions, RuntimeResources } from '../../src/app/domain/types';
import { createNativeResources } from '../../src/app/infrastructure/createNativeResources';
import { SqliteDeviceIdentity } from '../../src/app/infrastructure/SqliteDeviceIdentity';
import type { OpSqliteScalar, SqliteValue } from '../../src/features/dtn';
import { TestSqliteDatabase } from '../helpers/sqlite';

jest.mock('@op-engineering/op-sqlite', () => ({ open: jest.fn() }));
jest.mock('react-native-ble-plx', () => ({ BleManager: jest.fn() }));
jest.mock('uuid', () => ({ v4: jest.fn() }));
jest.mock('@react-native-community/geolocation', () => ({
  setRNConfiguration: jest.fn(), requestAuthorization: jest.fn(),
  watchPosition: jest.fn(), clearWatch: jest.fn(),
}));

interface NativeConnection {
  readonly name: string;
  closed: boolean;
  executeSync(sql: string, parameters?: OpSqliteScalar[]): {
    readonly rows: readonly Readonly<Record<string, SqliteValue>>[];
    readonly rowsAffected: number;
  };
  close(): void;
}

interface Manager {
  destroy: jest.Mock<() => Promise<void>>;
  stopDeviceScan: jest.Mock<() => Promise<void>>;
  state: jest.Mock<() => Promise<string>>;
}

const sqlite = jest.requireMock<{ open: jest.Mock<(options: { readonly name: string }) => NativeConnection> }>('@op-engineering/op-sqlite');
const ble = jest.requireMock<{ BleManager: jest.Mock<() => Manager> }>('react-native-ble-plx');
const uuid = jest.requireMock<{ v4: jest.Mock<() => string> }>('uuid');
const gps = jest.requireMock<{
  setRNConfiguration: jest.Mock<(...args: unknown[]) => void>;
  requestAuthorization: jest.Mock<() => void>;
  watchPosition: jest.Mock<() => number>;
}>('@react-native-community/geolocation');
const FIRST_ID = 'f13eff05-78dc-4311-a5a4-c5e86ba4f102';
const originalWifi: unknown = NativeModules.PalMeshWifiDirect;
const originalPeripheral: unknown = NativeModules.PalMeshBlePeripheral;
const originalMaps: unknown = NativeModules.PalMeshOfflineMaps;
let directory: string;
let connections: NativeConnection[];
let releaseOrder: string[];
let manager: Manager;
let permissions: RadioPermissions;
let resources: RuntimeResources | null;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'palmesh-bootstrap-'));
  connections = [];
  releaseOrder = [];
  resources = null;
  jest.replaceProperty(Platform, 'OS', 'android');
  NativeModules.PalMeshWifiDirect = undefined;
  NativeModules.PalMeshBlePeripheral = undefined;
  NativeModules.PalMeshOfflineMaps = undefined;
  jest.spyOn(PermissionsAndroid, 'request').mockResolvedValue(PermissionsAndroid.RESULTS.DENIED);
  jest.spyOn(PermissionsAndroid, 'requestMultiple').mockImplementation(async () => {
    throw new Error('Unexpected Android permission prompt');
  });
  let sequence = 0;
  uuid.v4.mockImplementation(() => sequence++ === 0 ? FIRST_ID
    : `f13eff05-78dc-4311-a5a4-${sequence.toString(16).padStart(12, '0')}`);
  manager = {
    destroy: jest.fn(async () => { releaseOrder.push('ble-manager'); }),
    stopDeviceScan: jest.fn(async () => {}),
    state: jest.fn(async () => 'PoweredOn'),
  };
  ble.BleManager.mockImplementation(() => manager);
  permissions = {
    check: jest.fn(async () => ({ platform: 'android' as const, wifiDirect: false, bluetooth: false, canRequest: true })),
    request: jest.fn(async () => ({ platform: 'android' as const, wifiDirect: false, bluetooth: false, canRequest: true })),
  };
  sqlite.open.mockImplementation(({ name }) => openConnection(name));
});

afterEach(async () => {
  if (resources) {
    await Promise.allSettled([resources.chat.stop(), resources.locations.stop()]);
    await resources.node.stop().catch(() => {});
    await resources.release().catch(() => {});
  }
  for (const connection of connections) if (!connection.closed) connection.close();
  NativeModules.PalMeshWifiDirect = originalWifi;
  NativeModules.PalMeshBlePeripheral = originalPeripheral;
  NativeModules.PalMeshOfflineMaps = originalMaps;
  rmSync(directory, { recursive: true, force: true });
});

/** Only the native boundaries are mocked. SQL, stores, services, UUID validation,
 * resource ownership and routing lifecycle run against their actual code.
 */
test('native composition opens five exclusive durable handles without starting services or prompting', async () => {
  resources = await createNativeResources({ permissions });
  expect(resources.deviceId).toBe(FIRST_ID);
  expect(connections.map(connection => connection.name)).toEqual([
    'palmesh-identity.sqlite', 'palmesh-dtn.sqlite', 'palmesh-peers.sqlite', 'palmesh-chat.sqlite', 'palmesh-locations.sqlite',
  ]);
  for (const connection of connections) {
    expect(connection.executeSync('PRAGMA journal_mode').rows[0]?.journal_mode).toBe('wal');
    expect(connection.executeSync('PRAGMA synchronous').rows[0]?.synchronous).toBe(2);
  }
  expect(resources.chat.getSnapshot().status).toBe('idle');
  expect(resources.locations.getSnapshot().status).toBe('idle');
  await expect(resources.node.engine.publish({ kind: 'sos', payload: { text: 'Not started' } })).rejects.toThrow(/Start|running/i);
  expect(gps.setRNConfiguration).toHaveBeenCalledWith({
    skipPermissionRequests: true, authorizationLevel: 'whenInUse',
    enableBackgroundLocationUpdates: false, locationProvider: 'android',
  });
  expectNoPermissionOrGpsPrompts();
  expect(manager.state).not.toHaveBeenCalled();
  expect(permissions.check).not.toHaveBeenCalled();
});

test('actual services queue chat and SOS with missing maps and denied radio permissions', async () => {
  resources = await createNativeResources({ permissions });
  await resources.node.engine.start();
  await resources.node.mesh.start();
  await Promise.all([resources.chat.start(), resources.locations.start()]);
  await resources.chat.openConversation('nearby-peer');
  resources.chat.setDraft('نحن هنا');
  expect((await resources.chat.send()).status).toBe('queued');
  expect((await resources.locations.sendSos()).status).toBe('queued');
  expect(resources.locations.getSnapshot().mapStatus).toBe('unavailable');
  expect(resources.locations.getSnapshot().sharing).toBe(false);
  expect(connections.find(connection => connection.name === 'palmesh-dtn.sqlite')?.executeSync(
    'SELECT COUNT(*) AS count FROM palmesh_dtn_messages',
  ).rows[0]?.count).toBe(2);
  expect(permissions.check).toHaveBeenCalled();
  expect(manager.state).not.toHaveBeenCalled();
  expectNoPermissionOrGpsPrompts();
});

test('release is idempotent, closes in reverse order, and retained identity is reused on bootstrap', async () => {
  resources = await createNativeResources({ permissions });
  const first = resources;
  await Promise.all([first.release(), first.release()]);
  expect(releaseOrder).toEqual([
    'ble-manager', 'palmesh-locations.sqlite', 'palmesh-chat.sqlite',
    'palmesh-peers.sqlite', 'palmesh-dtn.sqlite', 'palmesh-identity.sqlite',
  ]);
  expect(manager.destroy).toHaveBeenCalledTimes(1);
  expect(connections.every(connection => connection.closed)).toBe(true);
  uuid.v4.mockImplementation(() => { throw new Error('Existing identity must be retained'); });
  resources = await createNativeResources({ permissions });
  expect(resources.deviceId).toBe(FIRST_ID);
});

test('a partial database-open failure closes earlier handles and preserves the original failure', async () => {
  const failure = new Error('Peer database cannot open');
  sqlite.open.mockImplementation(({ name }) => {
    if (name === 'palmesh-peers.sqlite') throw failure;
    return openConnection(name);
  });
  await expect(createNativeResources({ permissions })).rejects.toBe(failure);
  expect(releaseOrder).toEqual(['palmesh-dtn.sqlite', 'palmesh-identity.sqlite']);
  expect(connections.every(connection => connection.closed)).toBe(true);
  expect(ble.BleManager).not.toHaveBeenCalled();
});

test('a late construction failure releases the manager and every handle even if manager cleanup fails', async () => {
  manager.destroy.mockImplementation(async () => { releaseOrder.push('ble-manager'); throw new Error('Native cleanup failed'); });
  await expect(createNativeResources({ permissions, mapOptions: { expectedSha256: 'invalid' } }))
    .rejects.toThrow('Expected MBTiles checksum must be a SHA-256 hex digest');
  expect(releaseOrder).toEqual([
    'ble-manager', 'palmesh-locations.sqlite', 'palmesh-chat.sqlite',
    'palmesh-peers.sqlite', 'palmesh-dtn.sqlite', 'palmesh-identity.sqlite',
  ]);
  expect(connections.every(connection => connection.closed)).toBe(true);
});

test('a corrupted identity prevents further resource creation and is never silently rotated', async () => {
  const db = new TestSqliteDatabase(join(directory, 'palmesh-identity.sqlite'));
  const identity = new SqliteDeviceIdentity(db);
  await identity.initialize();
  db.execute('INSERT INTO palmesh_device_identity VALUES (1, ?)', ['corrupt']);
  db.close();
  await expect(createNativeResources({ permissions })).rejects.toThrow(/Stored device identity/);
  expect(uuid.v4).not.toHaveBeenCalled();
  expect(connections.map(connection => connection.name)).toEqual(['palmesh-identity.sqlite']);
  expect(connections[0]?.closed).toBe(true);
  expect(ble.BleManager).not.toHaveBeenCalled();
});

test('iOS composition does not create a Bluetooth manager or request Bluetooth authorization', async () => {
  jest.replaceProperty(Platform, 'OS', 'ios');
  resources = await createNativeResources({ permissions });
  expect(ble.BleManager).not.toHaveBeenCalled();
  expect(permissions.check).not.toHaveBeenCalled();
  expectNoPermissionOrGpsPrompts();
});

function openConnection(name: string): NativeConnection {
  const db = new TestSqliteDatabase(join(directory, name));
  const connection: NativeConnection = {
    name, closed: false,
    executeSync: (sql, parameters = []) => db.execute(sql, parameters.map(sqliteValue)),
    close: () => {
      if (connection.closed) throw new Error(`Duplicate close of ${name}`);
      connection.closed = true;
      releaseOrder.push(name);
      db.close();
    },
  };
  connections.push(connection);
  return connection;
}

function sqliteValue(value: OpSqliteScalar): SqliteValue {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return value;
}

function expectNoPermissionOrGpsPrompts(): void {
  expect(permissions.request).not.toHaveBeenCalled();
  expect(PermissionsAndroid.request).not.toHaveBeenCalled();
  expect(PermissionsAndroid.requestMultiple).not.toHaveBeenCalled();
  expect(gps.requestAuthorization).not.toHaveBeenCalled();
  expect(gps.watchPosition).not.toHaveBeenCalled();
}
