import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { NativeModules, PermissionsAndroid, Platform } from 'react-native';
import type { RadioPermissions, RuntimeResources } from '../../src/app/domain/types';
import { createNativeResources } from '../../src/app/infrastructure/createNativeResources';
import { SecurityService } from '../../src/features/security';
import type { OpSqliteScalar, SqliteValue } from '../../src/features/dtn';
import { TestSqliteDatabase } from '../helpers/sqlite';

jest.mock('@op-engineering/op-sqlite', () => ({ open: jest.fn(), isSQLCipher: jest.fn() }));
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
  onStateChange: jest.Mock<() => { remove(): void }>;
  startDeviceScan: jest.Mock<() => Promise<void>>;
}

const sqlite = jest.requireMock<{
  open: jest.Mock<(options: { readonly name: string; readonly encryptionKey: string }) => NativeConnection>;
  isSQLCipher: jest.Mock<() => boolean>;
}>('@op-engineering/op-sqlite');
const ble = jest.requireMock<{ BleManager: jest.Mock<() => Manager> }>('react-native-ble-plx');
const uuid = jest.requireMock<{ v4: jest.Mock<() => string> }>('uuid');
const gps = jest.requireMock<{
  setRNConfiguration: jest.Mock<(...args: unknown[]) => void>;
  requestAuthorization: jest.Mock<() => void>;
  watchPosition: jest.Mock<() => number>;
}>('@react-native-community/geolocation');
const originalWifi: unknown = NativeModules.PalMeshWifiDirect;
const originalPeripheral: unknown = NativeModules.PalMeshBlePeripheral;
const originalMaps: unknown = NativeModules.PalMeshOfflineMaps;
const originalSecurity: unknown = NativeModules.PalMeshSecurity;
let directory: string;
let connections: NativeConnection[];
let releaseOrder: string[];
let manager: Manager;
let permissions: RadioPermissions;
let resources: RuntimeResources | null;
let vaultRecords: Map<string, string>;
let vault: {
  read: jest.Mock<(key: string) => Promise<string | null>>;
  write: jest.Mock<(key: string, value: string) => Promise<void>>;
  randomBytes: jest.Mock<(length: number) => Promise<string>>;
};

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'palmesh-bootstrap-'));
  connections = [];
  releaseOrder = [];
  resources = null;
  jest.replaceProperty(Platform, 'OS', 'android');
  NativeModules.PalMeshWifiDirect = undefined;
  NativeModules.PalMeshBlePeripheral = undefined;
  NativeModules.PalMeshOfflineMaps = undefined;
  vaultRecords = new Map();
  vault = {
    read: jest.fn(async key => vaultRecords.get(key) ?? null),
    write: jest.fn(async (key, value) => { vaultRecords.set(key, value); }),
    randomBytes: jest.fn(async length => randomBytes(length).toString('base64')),
  };
  NativeModules.PalMeshSecurity = vault;
  sqlite.isSQLCipher.mockReturnValue(true);
  jest.spyOn(PermissionsAndroid, 'request').mockResolvedValue(PermissionsAndroid.RESULTS.DENIED);
  jest.spyOn(PermissionsAndroid, 'requestMultiple').mockImplementation(async () => {
    throw new Error('Unexpected Android permission prompt');
  });
  let sequence = 0;
  uuid.v4.mockImplementation(() => `f13eff05-78dc-4311-a5a4-${(++sequence).toString(16).padStart(12, '0')}`);
  manager = {
    destroy: jest.fn(async () => { releaseOrder.push('ble-manager'); }),
    stopDeviceScan: jest.fn(async () => {}),
    state: jest.fn(async () => 'PoweredOn'),
    onStateChange: jest.fn(() => ({ remove() {} })),
    startDeviceScan: jest.fn(async () => {}),
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
    await Promise.allSettled([resources.chat.stop(), resources.locations.stop(), resources.emergency?.stop()]);
    await resources.node.stop().catch(() => {});
    await resources.release().catch(() => {});
  }
  for (const connection of connections) if (!connection.closed) connection.close();
  NativeModules.PalMeshWifiDirect = originalWifi;
  NativeModules.PalMeshBlePeripheral = originalPeripheral;
  NativeModules.PalMeshOfflineMaps = originalMaps;
  NativeModules.PalMeshSecurity = originalSecurity;
  rmSync(directory, { recursive: true, force: true });
});

/** Only native boundaries are mocked: the secure vault persists in memory and
 * SQLite emulates SQLCipher's capability PRAGMAs. Actual SQL, crypto, services,
 * resource ownership and routing lifecycle run against their production code.
 */
test('native composition opens five exclusive durable handles without starting services or prompting', async () => {
  resources = await createNativeResources({ permissions });
  expect(resources.deviceId).toMatch(/^pm1:[0-9a-f]{64}$/);
  expect(connections.map(connection => connection.name)).toEqual([
    'palmesh-dtn.sqlite', 'palmesh-peers.sqlite', 'palmesh-chat.sqlite', 'palmesh-locations.sqlite', 'palmesh-emergencies.sqlite',
  ]);
  expect(sqlite.open.mock.calls.every(([options]) => options.encryptionKey === vaultRecords.get('database-key-v1'))).toBe(true);
  expect(vaultRecords.get('database-key-v1')).toMatch(/^[0-9a-f]{64}$/);
  for (const connection of connections) {
    expect(connection.executeSync('PRAGMA journal_mode').rows[0]?.journal_mode).toBe('wal');
    expect(connection.executeSync('PRAGMA synchronous').rows[0]?.synchronous).toBe(2);
    expect(connection.executeSync('PRAGMA secure_delete').rows[0]?.secure_delete).toBe(1);
  }
  expect(uuid.v4).not.toHaveBeenCalled();
  expect(resources.chat.getSnapshot().status).toBe('idle');
  expect(resources.locations.getSnapshot().status).toBe('idle');
  await expect(resources.node.engine.publish({ kind: 'sos', payload: { text: 'Not started' } })).rejects.toThrow(/Start|running/i);
  expect(gps.setRNConfiguration).toHaveBeenCalledWith({
    skipPermissionRequests: true, authorizationLevel: 'whenInUse',
    enableBackgroundLocationUpdates: false, locationProvider: 'android',
  });
  expectNoPermissionOrGpsPrompts();
  expect(manager.state).not.toHaveBeenCalled();
  expect(ble.BleManager).not.toHaveBeenCalled();
  expect(permissions.check).not.toHaveBeenCalled();
});

test('actual services queue chat and SOS with missing maps and denied radio permissions', async () => {
  resources = await createNativeResources({ permissions });
  await resources.node.engine.start();
  await resources.node.mesh.start();
  await Promise.all([resources.chat.start(), resources.locations.start()]);
  const remote = new SecurityService({
    read: async () => null, write: async () => {},
    randomBytes: async length => new Uint8Array(randomBytes(length)),
  });
  await remote.initialize();
  await resources.security!.importPeer(remote.publicIdentity);
  await resources.chat.openConversation(remote.deviceId);
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
  const firstId = first.deviceId;
  const firstKey = vaultRecords.get('database-key-v1');
  const entropyCalls = vault.randomBytes.mock.calls.length;
  await Promise.all([first.release(), first.release()]);
  expect(releaseOrder).toEqual([
    'palmesh-emergencies.sqlite', 'palmesh-locations.sqlite', 'palmesh-chat.sqlite',
    'palmesh-peers.sqlite', 'palmesh-dtn.sqlite',
  ]);
  expect(manager.destroy).not.toHaveBeenCalled();
  expect(connections.every(connection => connection.closed)).toBe(true);
  uuid.v4.mockImplementation(() => { throw new Error('Existing identity must be retained'); });
  resources = await createNativeResources({ permissions });
  expect(resources.deviceId).toBe(firstId);
  expect(vaultRecords.get('database-key-v1')).toBe(firstKey);
  expect(vault.randomBytes).toHaveBeenCalledTimes(entropyCalls);
});

test('a partial database-open failure closes earlier handles and preserves the original failure', async () => {
  const failure = new Error('Peer database cannot open');
  sqlite.open.mockImplementation(({ name }) => {
    if (name === 'palmesh-peers.sqlite') throw failure;
    return openConnection(name);
  });
  await expect(createNativeResources({ permissions })).rejects.toBe(failure);
  expect(releaseOrder).toEqual(['palmesh-dtn.sqlite']);
  expect(connections.every(connection => connection.closed)).toBe(true);
  expect(ble.BleManager).not.toHaveBeenCalled();
});

test('a late construction failure releases every handle without creating a Bluetooth manager', async () => {
  await expect(createNativeResources({ permissions, mapOptions: { expectedSha256: 'invalid' } }))
    .rejects.toThrow('Expected MBTiles checksum must be a SHA-256 hex digest');
  expect(releaseOrder).toEqual([
    'palmesh-emergencies.sqlite', 'palmesh-locations.sqlite', 'palmesh-chat.sqlite',
    'palmesh-peers.sqlite', 'palmesh-dtn.sqlite',
  ]);
  expect(connections.every(connection => connection.closed)).toBe(true);
  expect(ble.BleManager).not.toHaveBeenCalled();
});

test('a corrupted identity prevents further resource creation and is never silently rotated', async () => {
  vaultRecords.set('identity-v1', '{"version":7}');
  await expect(createNativeResources({ permissions })).rejects.toThrow(/secure storage|identity/i);
  expect(vaultRecords.get('identity-v1')).toBe('{"version":7}');
  expect(vault.write.mock.calls.some(([key]) => key === 'identity-v1')).toBe(false);
  expect(uuid.v4).not.toHaveBeenCalled();
  expect(connections).toEqual([]);
  expect(ble.BleManager).not.toHaveBeenCalled();
});

test('missing secure vault, SQLCipher backend, or corrupt database key prevents opening any database', async () => {
  NativeModules.PalMeshSecurity = undefined;
  await expect(createNativeResources({ permissions })).rejects.toThrow(/Secure native key storage/);
  NativeModules.PalMeshSecurity = vault;
  sqlite.isSQLCipher.mockReturnValue(false);
  await expect(createNativeResources({ permissions })).rejects.toThrow(/SQLCipher/);
  expect(vault.read).not.toHaveBeenCalled();
  sqlite.isSQLCipher.mockReturnValue(true);
  vaultRecords.set('database-key-v1', 'corrupt');
  await expect(createNativeResources({ permissions })).rejects.toThrow(/Stored database key/);
  expect(vaultRecords.get('database-key-v1')).toBe('corrupt');
  expect(vault.write).not.toHaveBeenCalled();
  expect(sqlite.open).not.toHaveBeenCalled();
  expect(ble.BleManager).not.toHaveBeenCalled();
});

test('Bluetooth is created only after granted permissions, then cleanup closes databases despite a manager failure', async () => {
  resources = await createNativeResources({ permissions });
  expect(ble.BleManager).not.toHaveBeenCalled();
  jest.mocked(permissions.check).mockResolvedValue({ platform: 'android', wifiDirect: false, bluetooth: true, canRequest: true });
  await resources.node.start();
  expect(ble.BleManager).toHaveBeenCalledTimes(1);
  expect(manager.startDeviceScan).toHaveBeenCalledTimes(1);
  await resources.node.stop();
  manager.destroy.mockImplementation(async () => { releaseOrder.push('ble-manager'); throw new Error('Native cleanup failed'); });
  await expect(resources.release()).rejects.toThrow('Native cleanup failed');
  expect(releaseOrder).toEqual([
    'ble-manager', 'palmesh-emergencies.sqlite', 'palmesh-locations.sqlite',
    'palmesh-chat.sqlite', 'palmesh-peers.sqlite', 'palmesh-dtn.sqlite',
  ]);
  expect(connections.every(connection => connection.closed)).toBe(true);
  expectNoPermissionOrGpsPrompts();
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
    executeSync: (sql, parameters = []) => {
      if (sql === 'PRAGMA cipher_version') return { rows: [{ cipher_version: '4.6.1' }], rowsAffected: 0 };
      if (sql === 'PRAGMA cipher_memory_security = ON') return { rows: [], rowsAffected: 0 };
      if (sql === 'PRAGMA cipher_memory_security') return { rows: [{ cipher_memory_security: 1 }], rowsAffected: 0 };
      return db.execute(sql, parameters.map(sqliteValue));
    },
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
