import assert from 'node:assert/strict';
import test from 'node:test';
import type { RadioAdapter } from '../src/features/mesh/domain/ports';
import type { RadioEvent, RadioLink, RadioStatus } from '../src/features/mesh/domain/types';
import { PALMESH_BLE_NOTIFY, PALMESH_BLE_SERVICE, PALMESH_BLE_WRITE } from '../src/features/mesh/domain/types';
import { bytesToBase64 } from '../src/features/mesh/domain/wire';
import { NativeBlePeripheralRadio } from '../src/features/mesh/infrastructure/radios/NativeBlePeripheralRadio';
import { NativeWifiDirectRadio } from '../src/features/mesh/infrastructure/radios/NativeWifiDirectRadio';
import type { NativeEventSource, NativeWifiDirectModule } from '../src/features/mesh/infrastructure/radios/NativeWifiDirectRadio';
import { BlePlxRadio } from '../src/features/mesh/infrastructure/radios/BlePlxRadio';
import type { BlePlxDevice, BlePlxManager, BlePlxCharacteristic } from '../src/features/mesh/infrastructure/radios/BlePlxRadio';

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  return { promise: new Promise<T>((r, j) => { resolve = r; reject = j; }), resolve: value => resolve(value), reject: error => reject(error) };
}
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
const signal = (): AbortSignal => new AbortController().signal;
const link = (id = 'link-1', endpointId = 'endpoint-1', maxChunkBytes = 32): RadioLink => ({ id, endpointId, maxChunkBytes });

class NativeEvents implements NativeEventSource {
  constructor(private readonly eventName = 'PalMeshWifiDirectEvent') {}
  readonly listeners = new Set<(event: unknown) => void>();
  readonly historical: ((event: unknown) => void)[] = [];
  addListener(name: string, listener: (event: unknown) => void): { remove(): void } {
    assert.equal(name, this.eventName);
    this.listeners.add(listener);
    this.historical.push(listener);
    return { remove: () => { this.listeners.delete(listener); } };
  }
  emit(event: unknown): void { for (const listener of this.listeners) listener(event); }
}

class WifiNative implements NativeWifiDirectModule {
  status: RadioStatus = { available: true };
  readonly cancelled: string[] = [];
  readonly disconnected: string[] = [];
  readonly writes: { id: string; value: string; operationId: string }[] = [];
  startCalls = 0;
  stopCalls = 0;
  getStatus = async (): Promise<RadioStatus> => this.status;
  start = async (_operationId: string): Promise<void> => { ++this.startCalls; };
  stop = async (): Promise<void> => { ++this.stopCalls; };
  connect = async (endpointId: string, _operationId: string): Promise<RadioLink> => link('link-1', endpointId);
  disconnect = async (linkId: string): Promise<void> => { this.disconnected.push(linkId); };
  write = async (id: string, value: string, operationId: string): Promise<void> => { this.writes.push({ id, value, operationId }); };
  cancel(operationId: string): void { this.cancelled.push(operationId); }
}

class BleManager implements BlePlxManager {
  currentState = 'PoweredOn';
  readonly device: BlePlxDevice = { id: 'ble-device', mtu: 23, rssi: -65 };
  readonly scanCallbacks: ((error: unknown | null, device: BlePlxDevice | null) => void)[] = [];
  readonly stateCallbacks: ((state: string) => void)[] = [];
  readonly notifyCallbacks: ((error: unknown | null, characteristic: BlePlxCharacteristic | null) => void)[] = [];
  readonly disconnectCallbacks: ((error: unknown | null, device: BlePlxDevice | null) => void)[] = [];
  readonly cancelledDevices: string[] = [];
  readonly cancelledTransactions: string[] = [];
  readonly writes: { id: string; service: string; characteristic: string; value: string; transaction?: string }[] = [];
  readonly removed: string[] = [];
  stopCalls = 0;
  state = async (): Promise<string> => this.currentState;
  onStateChange(listener: (state: string) => void): { remove(): void } {
    this.stateCallbacks.push(listener); return { remove: () => { this.removed.push('state'); } };
  }
  startDeviceScan = async (services: string[] | null, _options: unknown,
    listener: (error: unknown | null, device: BlePlxDevice | null) => void): Promise<void> => {
    assert.deepEqual(services, [PALMESH_BLE_SERVICE]); this.scanCallbacks.push(listener);
  };
  stopDeviceScan = async (): Promise<void> => { ++this.stopCalls; };
  connectToDevice = async (_id: string, _options?: { requestMTU?: number; timeout?: number }): Promise<BlePlxDevice> => this.device;
  cancelDeviceConnection = async (id: string): Promise<unknown> => { this.cancelledDevices.push(id); return this.device; };
  discoverAllServicesAndCharacteristicsForDevice = async (_id: string, _transactionId?: string): Promise<BlePlxDevice> => this.device;
  monitorCharacteristicForDevice(_id: string, service: string, characteristic: string,
    listener: (error: unknown | null, characteristic: BlePlxCharacteristic | null) => void, _transactionId?: string): { remove(): void } {
    assert.equal(service, PALMESH_BLE_SERVICE); assert.equal(characteristic, PALMESH_BLE_NOTIFY);
    this.notifyCallbacks.push(listener); return { remove: () => { this.removed.push('notify'); } };
  }
  onDeviceDisconnected(_id: string, listener: (error: unknown | null, device: BlePlxDevice | null) => void): { remove(): void } {
    this.disconnectCallbacks.push(listener); return { remove: () => { this.removed.push('disconnection'); } };
  }
  writeCharacteristicWithResponseForDevice = async (id: string, service: string, characteristic: string,
    value: string, transaction?: string): Promise<unknown> => {
    this.writes.push({ id, service, characteristic, value, ...(transaction === undefined ? {} : { transaction }) }); return undefined;
  };
  cancelTransaction = async (id: string): Promise<void> => { this.cancelledTransactions.push(id); };
}

const granted = async (): Promise<boolean> => true;

test('Wi-Fi Direct reports missing module and denied permission without starting native discovery', async () => {
  assert.deepEqual(await new NativeWifiDirectRadio(undefined, undefined).getStatus(), { available: false, reason: 'unsupported' });
  const native = new WifiNative(); native.status = { available: false, reason: 'permission-denied' };
  const radio = new NativeWifiDirectRadio(native, new NativeEvents());
  await assert.rejects(radio.start(signal()), /permission-denied/);
  assert.equal(native.startCalls, 0);
});

test('Wi-Fi Direct abort settles a hanging status lookup immediately', async () => {
  const native = new WifiNative(); native.getStatus = () => new Promise(() => undefined);
  const radio = new NativeWifiDirectRadio(native, new NativeEvents());
  const controller = new AbortController();
  const started = radio.start(controller.signal);
  await tick(); controller.abort();
  await assert.rejects(started, { name: 'AbortError' });
});

test('Wi-Fi Direct validates native events, base64, identities and chunk sizes', async () => {
  const native = new WifiNative(); const emitter = new NativeEvents();
  const radio = new NativeWifiDirectRadio(native, emitter);
  const events: RadioEvent[] = []; radio.subscribe(event => events.push(event));
  await radio.start(signal());
  emitter.emit({ type: 'discovered', endpoint: { endpointId: 'peer', rssi: -60 } });
  emitter.emit({ type: 'discovered', endpoint: { endpointId: 'x'.repeat(257) } });
  emitter.emit({ type: 'connected', link: link() });
  emitter.emit({ type: 'data', linkId: 'link-1', base64: bytesToBase64(new Uint8Array([1, 2])) });
  emitter.emit({ type: 'data', linkId: 'link-1', base64: '***=' });
  emitter.emit({ type: 'data', linkId: 'link-1', base64: bytesToBase64(new Uint8Array(33)) });
  emitter.emit({ type: 'connected', link: link('bad', 'other', 8193) });
  assert.equal(events.filter(event => event.type === 'data').length, 1);
  assert.equal(events.filter(event => event.type === 'discovered').length, 1);
  assert.equal(events.filter(event => event.type === 'error').length, 4);
  await radio.stop(); assert.equal(emitter.listeners.size, 0);
});

test('Wi-Fi Direct cancels aborted native connects and disconnects late returned links', async () => {
  const native = new WifiNative(); const emitter = new NativeEvents();
  const result = deferred<RadioLink>(); native.connect = () => result.promise;
  const radio = new NativeWifiDirectRadio(native, emitter);
  const events: RadioEvent[] = []; radio.subscribe(event => events.push(event));
  await radio.start(signal());
  const controller = new AbortController(); const connecting = radio.connect('endpoint-1', controller.signal);
  await tick(); controller.abort();
  await assert.rejects(connecting, { name: 'AbortError' });
  emitter.emit({ type: 'connected', link: link() });
  assert.equal(events.filter(event => event.type === 'connected').length, 0);
  result.resolve(link()); await tick();
  assert.ok(native.cancelled.some(id => id.startsWith('wifi-')));
  assert.ok(native.disconnected.includes('link-1'));
  await radio.stop();
});

test('Wi-Fi Direct stop cancels a hung write, ignores stale events and preserves write/ACK separation', async () => {
  const native = new WifiNative(); const emitter = new NativeEvents();
  const radio = new NativeWifiDirectRadio(native, emitter);
  const events: RadioEvent[] = []; radio.subscribe(event => events.push(event));
  await radio.start(signal()); const connected = await radio.connect('endpoint-1', signal());
  await radio.write(connected.id, new Uint8Array([9]), signal());
  assert.equal(native.writes[0]!.value, 'CQ==');
  assert.equal(events.filter(event => event.type === 'data').length, 0, 'native write is not a durable protocol ACK');
  const pending = deferred<void>(); native.write = () => pending.promise;
  const writing = radio.write(connected.id, new Uint8Array([8]), signal());
  const rejected = assert.rejects(writing, { name: 'AbortError' });
  await tick(); await radio.stop(); await rejected;
  const stale = emitter.historical[0]!;
  await radio.start(signal());
  stale({ type: 'connected', link: link('old') });
  assert.equal(events.filter(event => event.type === 'connected').length, 0);
  pending.resolve(); await radio.stop();
});

test('Wi-Fi Direct write queue preserves order and never sends an aborted queued chunk', async () => {
  const native = new WifiNative(); const radio = new NativeWifiDirectRadio(native, new NativeEvents());
  await radio.start(signal()); const connected = await radio.connect('endpoint-1', signal());
  const first = deferred<void>(); let calls = 0;
  native.write = async (): Promise<void> => { ++calls; if (calls === 1) await first.promise; };
  const writing = radio.write(connected.id, new Uint8Array([1]), signal());
  const controller = new AbortController(); const queued = radio.write(connected.id, new Uint8Array([2]), controller.signal);
  await tick(); assert.equal(calls, 1); controller.abort();
  await assert.rejects(queued, { name: 'AbortError' });
  first.resolve(); await writing; await tick(); assert.equal(calls, 1);
  await assert.rejects(radio.write(connected.id, new Uint8Array(33), signal()), /limit/);
  await radio.stop();
});

test('Wi-Fi Direct stop is bounded and prevents restarting a radio with unresolved native teardown', async () => {
  const native = new WifiNative(); const radio = new NativeWifiDirectRadio(native, new NativeEvents(), { operationTimeoutMs: 10 });
  await radio.start(signal()); native.stop = () => new Promise(() => undefined);
  await assert.rejects(radio.stop(), /timed out/);
  await assert.rejects(radio.start(signal()), /teardown failed/);
});

test('BLE gates discovery on granted permissions and powered-on state', async () => {
  const manager = new BleManager();
  const denied = new BlePlxRadio(manager, { permissionsGranted: async () => false });
  assert.deepEqual(await denied.getStatus(), { available: false, reason: 'permission-denied' });
  await assert.rejects(denied.start(signal()), /permission-denied/);
  assert.equal(manager.scanCallbacks.length, 0);
  manager.currentState = 'PoweredOff';
  const off = new BlePlxRadio(manager, { permissionsGranted: granted });
  await assert.rejects(off.start(signal()), /powered-off/);
  assert.deepEqual(await new BlePlxRadio(undefined, { permissionsGranted: granted }).getStatus(), { available: false, reason: 'unsupported' });
});

test('BLE central-only capability is explicit and callbacks from old scan generations are ignored', async () => {
  const manager = new BleManager(); const radio = new BlePlxRadio(manager, { permissionsGranted: granted });
  assert.deepEqual(radio.capabilities, { central: true, peripheral: false, fullPhoneToPhone: false });
  const events: RadioEvent[] = []; radio.subscribe(event => events.push(event));
  await radio.start(signal()); const old = manager.scanCallbacks[0]!;
  old(null, manager.device); assert.equal(events.filter(event => event.type === 'discovered').length, 1);
  await radio.stop(); await radio.start(signal());
  old(null, manager.device); assert.equal(events.filter(event => event.type === 'discovered').length, 1);
  manager.scanCallbacks[1]!(null, manager.device); assert.equal(events.filter(event => event.type === 'discovered').length, 2);
  await radio.stop(); assert.ok(manager.removed.includes('state'));
});

test('BLE abort stops a scan even if the native start promise hangs', async () => {
  const manager = new BleManager(); manager.startDeviceScan = () => new Promise(() => undefined);
  const radio = new BlePlxRadio(manager, { permissionsGranted: granted });
  const controller = new AbortController(); const starting = radio.start(controller.signal);
  await tick(); controller.abort();
  await assert.rejects(starting, { name: 'AbortError' }); await tick();
  assert.ok(manager.stopCalls > 0); await radio.stop();
});

test('BLE cancelled native connection cannot publish a late connected event', async () => {
  const manager = new BleManager(); const result = deferred<BlePlxDevice>(); manager.connectToDevice = () => result.promise;
  const radio = new BlePlxRadio(manager, { permissionsGranted: granted });
  const events: RadioEvent[] = []; radio.subscribe(event => events.push(event)); await radio.start(signal());
  const controller = new AbortController(); const connecting = radio.connect(manager.device.id, controller.signal);
  await tick(); controller.abort(); await assert.rejects(connecting, { name: 'AbortError' });
  await assert.rejects(radio.connect(manager.device.id, signal()), /already connecting/);
  result.resolve(manager.device); await tick();
  assert.equal(events.filter(event => event.type === 'connected').length, 0);
  assert.ok(manager.cancelledDevices.includes(manager.device.id));
  assert.ok(manager.cancelledTransactions.some(id => id.startsWith('ble-')));
  await radio.stop();
});

test('BLE negotiates MTU, monitors notifications and uses write-with-response without faking durable ACK', async () => {
  const manager = new BleManager(); const radio = new BlePlxRadio(manager, { permissionsGranted: granted });
  const events: RadioEvent[] = []; radio.subscribe(event => events.push(event)); await radio.start(signal());
  const connected = await radio.connect(manager.device.id, signal()); assert.equal(connected.maxChunkBytes, 20);
  await radio.write(connected.id, new Uint8Array([7, 8]), signal());
  assert.equal(manager.writes[0]!.value, 'Bwg='); assert.equal(manager.writes[0]!.service, PALMESH_BLE_SERVICE);
  assert.equal(manager.writes[0]!.characteristic, PALMESH_BLE_WRITE);
  assert.ok(manager.writes[0]!.transaction);
  assert.equal(events.filter(event => event.type === 'data').length, 0);
  manager.notifyCallbacks[0]!(null, { value: bytesToBase64(new Uint8Array([4])) });
  assert.equal(events.filter(event => event.type === 'data').length, 1);
  await assert.rejects(radio.write(connected.id, new Uint8Array(21), signal()), /MTU/);
  await radio.stop(); assert.ok(manager.removed.includes('notify')); assert.ok(manager.removed.includes('disconnection'));
});

test('BLE rejects malformed and oversized notifications and cleans the link', async () => {
  for (const value of ['***=', bytesToBase64(new Uint8Array(21))]) {
    const manager = new BleManager(); const radio = new BlePlxRadio(manager, { permissionsGranted: granted });
    const events: RadioEvent[] = []; radio.subscribe(event => events.push(event)); await radio.start(signal());
    const connected = await radio.connect(manager.device.id, signal()); manager.notifyCallbacks[0]!(null, { value });
    await tick(); assert.equal(events.filter(event => event.type === 'data').length, 0);
    assert.ok(events.some(event => event.type === 'error'));
    await assert.rejects(radio.write(connected.id, new Uint8Array([1]), signal()), /closed/);
    await radio.stop();
  }
});

test('BLE disconnect cancels hanging writes and ignores notifications from the previous link session', async () => {
  const manager = new BleManager(); const radio = new BlePlxRadio(manager, { permissionsGranted: granted });
  const events: RadioEvent[] = []; radio.subscribe(event => events.push(event)); await radio.start(signal());
  const first = await radio.connect(manager.device.id, signal());
  const pending = deferred<void>(); manager.writeCharacteristicWithResponseForDevice = () => pending.promise;
  const writing = radio.write(first.id, new Uint8Array([1]), signal());
  const rejected = assert.rejects(writing, { name: 'AbortError' }); await tick();
  manager.disconnectCallbacks[0]!(null, manager.device); await rejected;
  const second = await radio.connect(manager.device.id, signal()); assert.notEqual(first.id, second.id);
  manager.notifyCallbacks[0]!(null, { value: 'AQ==' });
  assert.equal(events.filter(event => event.type === 'data').length, 0);
  pending.resolve(); await radio.stop();
});

test('BLE bounds malformed MTUs and concurrent native connects', async () => {
  const manager = new BleManager(); manager.discoverAllServicesAndCharacteristicsForDevice = async () => ({ ...manager.device, mtu: 9000 });
  const radio = new BlePlxRadio(manager, { permissionsGranted: granted, maxConnections: 1 }); await radio.start(signal());
  await assert.rejects(radio.connect(manager.device.id, signal()), /MTU/);
  const wait = deferred<BlePlxDevice>(); manager.connectToDevice = () => wait.promise;
  const controller = new AbortController(); const connecting = radio.connect(manager.device.id, controller.signal);
  await tick(); await assert.rejects(radio.connect('other', signal()), /capacity/);
  controller.abort(); await assert.rejects(connecting, { name: 'AbortError' }); wait.resolve(manager.device); await tick(); await radio.stop();
});

test('BLE powered-off state tears down scanning and existing links', async () => {
  const manager = new BleManager(); const radio = new BlePlxRadio(manager, { permissionsGranted: granted });
  await radio.start(signal()); const connected = await radio.connect(manager.device.id, signal());
  manager.stateCallbacks[0]!('PoweredOff'); await tick();
  await assert.rejects(radio.write(connected.id, new Uint8Array([1]), signal()), /not started/);
  assert.ok(manager.stopCalls > 0); assert.ok(manager.cancelledDevices.includes(manager.device.id)); await radio.stop();
});

test('BLE optionally delegates native GATT hosting with unique session links and routed inbound writes', async () => {
  const manager = new BleManager(); const listeners = new Set<(event: RadioEvent) => void>();
  const calls: string[] = [];
  const peripheral: RadioAdapter = {
    kind: 'ble', getStatus: async () => ({ available: true }),
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start: async () => { calls.push('start'); }, stop: async () => { calls.push('stop'); },
    connect: async () => { throw new Error('inbound only'); },
    disconnect: async id => { calls.push(`disconnect:${id}`); },
    write: async (id, bytes) => { calls.push(`write:${id}:${bytes[0]}`); },
  };
  const radio = new BlePlxRadio(manager, { permissionsGranted: granted, peripheral });
  assert.equal(radio.capabilities.fullPhoneToPhone, true);
  const events: RadioEvent[] = []; radio.subscribe(event => events.push(event)); await radio.start(signal());
  for (const listener of listeners) listener({ type: 'connected', link: link('host-link', 'host-device', 20) });
  const connected = events.find(event => event.type === 'connected'); assert.ok(connected?.type === 'connected');
  assert.notEqual(connected.link.id, 'host-link');
  await radio.write(connected.link.id, new Uint8Array([6]), signal()); assert.ok(calls.includes('write:host-link:6'));
  for (const listener of listeners) listener({ type: 'data', linkId: 'host-link', bytes: new Uint8Array([7]) });
  const data = events.find(event => event.type === 'data'); assert.ok(data?.type === 'data'); assert.equal(data.linkId, connected.link.id);
  await radio.stop(); assert.ok(calls.includes('stop')); assert.equal(listeners.size, 0);
});

test('BLE aborts a hanging permission check before touching the native scanner', async () => {
  const manager = new BleManager(); const radio = new BlePlxRadio(manager, { permissionsGranted: () => new Promise(() => undefined) });
  const controller = new AbortController(); const starting = radio.start(controller.signal);
  await tick(); controller.abort(); await assert.rejects(starting, { name: 'AbortError' });
  assert.equal(manager.scanCallbacks.length, 0);
});

test('BLE timed-out connects do not emit a connected event when native resolves later', async () => {
  const manager = new BleManager(); const result = deferred<BlePlxDevice>(); manager.connectToDevice = () => result.promise;
  const radio = new BlePlxRadio(manager, { permissionsGranted: granted, operationTimeoutMs: 10 });
  const events: RadioEvent[] = []; radio.subscribe(event => events.push(event)); await radio.start(signal());
  await assert.rejects(radio.connect(manager.device.id, signal()), /timed out/);
  result.resolve(manager.device); await tick();
  assert.equal(events.filter(event => event.type === 'connected').length, 0);
  await radio.stop();
});

test('BLE removes subscriptions even when native disconnects synchronously during registration', async () => {
  const manager = new BleManager();
  manager.onDeviceDisconnected = (_id, listener) => {
    listener(new Error('link dropped during setup'), manager.device);
    return { remove: () => { manager.removed.push('inline-disconnection'); } };
  };
  const radio = new BlePlxRadio(manager, { permissionsGranted: granted }); await radio.start(signal());
  await assert.rejects(radio.connect(manager.device.id, signal()), /disconnected during setup/);
  assert.ok(manager.removed.includes('inline-disconnection'));
  assert.ok(manager.removed.includes('notify'));
  await radio.stop();
});

test('BLE FIFO never submits a cancelled queued native transaction', async () => {
  const manager = new BleManager(); const radio = new BlePlxRadio(manager, { permissionsGranted: granted });
  await radio.start(signal()); const connected = await radio.connect(manager.device.id, signal());
  const result = deferred<void>(); let calls = 0;
  manager.writeCharacteristicWithResponseForDevice = async () => { ++calls; if (calls === 1) await result.promise; return undefined; };
  const first = radio.write(connected.id, new Uint8Array([1]), signal());
  const controller = new AbortController(); const queued = radio.write(connected.id, new Uint8Array([2]), controller.signal);
  await tick(); assert.equal(calls, 1); controller.abort(); await assert.rejects(queued, { name: 'AbortError' });
  result.resolve(); await first; await tick(); assert.equal(calls, 1);
  await radio.write(connected.id, new Uint8Array([3]), signal()); assert.equal(calls, 2);
  await radio.stop();
});

test('BLE cleans a state subscription if its registration synchronously reports powered off', async () => {
  const manager = new BleManager();
  manager.onStateChange = listener => {
    listener('PoweredOff'); return { remove: () => { manager.removed.push('inline-state'); } };
  };
  const radio = new BlePlxRadio(manager, { permissionsGranted: granted });
  await assert.rejects(radio.start(signal()), { name: 'AbortError' });
  assert.ok(manager.removed.includes('inline-state')); assert.equal(manager.scanCallbacks.length, 0);
  await radio.stop();
});

test('native BLE peripheral gates permissions, rejects outbound connects and bounds GATT chunk limits', async () => {
  assert.deepEqual(await new NativeBlePeripheralRadio(undefined, undefined).getStatus(), { available: false, reason: 'unsupported' });
  const native = new WifiNative(); const emitter = new NativeEvents('PalMeshBlePeripheralEvent');
  const peripheral = new NativeBlePeripheralRadio(native, emitter);
  assert.equal(peripheral.kind, 'ble');
  native.status = { available: false, reason: 'permission-denied' };
  await assert.rejects(peripheral.start(signal()), /permission-denied/); assert.equal(native.startCalls, 0);
  native.status = { available: true }; await peripheral.start(signal());
  await assert.rejects(peripheral.connect('ble-inbound:device', signal()), /inbound connections only/);
  const events: RadioEvent[] = []; peripheral.subscribe(event => events.push(event));
  emitter.emit({ type: 'connected', link: link('gatt', 'ble-inbound:device', 512) });
  emitter.emit({ type: 'connected', link: link('oversized', 'ble-inbound:other', 513) });
  assert.equal(events.filter(event => event.type === 'connected').length, 1);
  assert.equal(events.filter(event => event.type === 'error').length, 1);
  await peripheral.write('gatt', new Uint8Array(512), signal());
  await assert.rejects(peripheral.write('gatt', new Uint8Array(513), signal()), /limit/);
  await peripheral.stop(); assert.equal(emitter.listeners.size, 0);
});

test('BLE central and concrete native GATT wrapper compose full bidirectional transport', async () => {
  const native = new WifiNative(); const emitter = new NativeEvents('PalMeshBlePeripheralEvent');
  const peripheral = new NativeBlePeripheralRadio(native, emitter);
  const manager = new BleManager(); const radio = new BlePlxRadio(manager, { permissionsGranted: granted, peripheral });
  const events: RadioEvent[] = []; radio.subscribe(event => events.push(event));
  await radio.start(signal()); assert.equal(native.startCalls, 1); assert.equal(radio.capabilities.fullPhoneToPhone, true);
  emitter.emit({ type: 'connected', link: link('native-gatt', 'ble-inbound:device', 20) });
  const inbound = events.find(event => event.type === 'connected'); assert.ok(inbound?.type === 'connected');
  emitter.emit({ type: 'data', linkId: 'native-gatt', base64: 'AQI=' });
  const data = events.find(event => event.type === 'data'); assert.ok(data?.type === 'data');
  assert.equal(data.linkId, inbound.link.id); assert.deepEqual(data.bytes, new Uint8Array([1, 2]));
  await radio.write(inbound.link.id, new Uint8Array([3]), signal()); assert.equal(native.writes[0]!.id, 'native-gatt'); assert.equal(native.writes[0]!.value, 'Aw==');
  const outbound = await radio.connect(manager.device.id, signal());
  await radio.write(outbound.id, new Uint8Array([4]), signal()); assert.equal(manager.writes[0]!.value, 'BA==');
  await radio.stop(); assert.equal(emitter.listeners.size, 0); assert.equal(native.stopCalls, 1);
});

test('native Wi-Fi and BLE event subscriptions stay isolated when one radio stops', async () => {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const source: NativeEventSource = {
    addListener: (name, listener) => {
      let set = listeners.get(name); if (!set) { set = new Set(); listeners.set(name, set); }
      set.add(listener); return { remove: () => { set.delete(listener); } };
    },
  };
  const wifi = new NativeWifiDirectRadio(new WifiNative(), source);
  const peripheral = new NativeBlePeripheralRadio(new WifiNative(), source);
  const wifiEvents: RadioEvent[] = []; const bleEvents: RadioEvent[] = [];
  wifi.subscribe(event => wifiEvents.push(event)); peripheral.subscribe(event => bleEvents.push(event));
  await wifi.start(signal()); await peripheral.start(signal()); await peripheral.stop();
  const emit = (name: string, event: unknown): void => { for (const listener of listeners.get(name) ?? []) listener(event); };
  emit('PalMeshWifiDirectEvent', { type: 'discovered', endpoint: { endpointId: 'wifi-neighbor' } });
  emit('PalMeshBlePeripheralEvent', { type: 'connected', link: link('ble-stale', 'ble-inbound:device', 20) });
  assert.equal(wifiEvents.filter(event => event.type === 'discovered').length, 1);
  assert.equal(bleEvents.filter(event => event.type === 'connected').length, 0);
  assert.equal(listeners.get('PalMeshWifiDirectEvent')!.size, 1);
  await wifi.stop();
});

test('BLE caps negotiated MTU 517 at the 512-byte GATT characteristic value limit', async () => {
  const manager = new BleManager();
  manager.discoverAllServicesAndCharacteristicsForDevice = async () => ({ ...manager.device, mtu: 517 });
  const radio = new BlePlxRadio(manager, { permissionsGranted: granted }); await radio.start(signal());
  const connected = await radio.connect(manager.device.id, signal()); assert.equal(connected.maxChunkBytes, 512);
  await radio.write(connected.id, new Uint8Array(512), signal());
  await assert.rejects(radio.write(connected.id, new Uint8Array(513), signal()), /MTU/);
  await radio.stop();
});

test('BLE buffers synchronous monitor notifications until after publishing its connected event', async () => {
  const manager = new BleManager();
  const original = manager.monitorCharacteristicForDevice.bind(manager);
  manager.monitorCharacteristicForDevice = (id, service, characteristic, listener, transactionId) => {
    listener(null, { value: 'AQ==' }); listener(null, { value: 'Ag==' });
    return original(id, service, characteristic, listener, transactionId);
  };
  const radio = new BlePlxRadio(manager, { permissionsGranted: granted });
  const events: RadioEvent[] = []; radio.subscribe(event => events.push(event)); await radio.start(signal());
  await radio.connect(manager.device.id, signal());
  assert.deepEqual(events.filter(event => event.type === 'connected' || event.type === 'data').map(event => event.type), ['connected', 'data', 'data']);
  assert.deepEqual(events.flatMap(event => event.type === 'data' ? [...event.bytes] : []), [1, 2]);
  await radio.stop();
});

test('BLE bounds early native notification backlog and rejects the link on overflow', async () => {
  const manager = new BleManager();
  manager.monitorCharacteristicForDevice = (_id, _service, _characteristic, listener) => {
    for (let count = 0; count < 9; ++count) listener(null, { value: 'AQ==' });
    return { remove: () => { manager.removed.push('early-overflow'); } };
  };
  const radio = new BlePlxRadio(manager, { permissionsGranted: granted });
  const events: RadioEvent[] = []; radio.subscribe(event => events.push(event)); await radio.start(signal());
  await assert.rejects(radio.connect(manager.device.id, signal()), /disconnected during setup/);
  assert.equal(events.filter(event => event.type === 'data' || event.type === 'connected').length, 0);
  assert.ok(manager.removed.includes('early-overflow')); await radio.stop();
});

test('native radio concurrent starts share actual readiness and one native start operation', async () => {
  const native = new WifiNative(); const ready = deferred<void>();
  native.start = async () => { ++native.startCalls; await ready.promise; };
  const radio = new NativeWifiDirectRadio(native, new NativeEvents());
  const first = radio.start(signal()); await tick();
  let secondSettled = false;
  const second = radio.start(signal()).finally(() => { secondSettled = true; });
  await tick(); assert.equal(secondSettled, false); assert.equal(native.startCalls, 1);
  ready.resolve(); await Promise.all([first, second]); await radio.stop();
});

test('BLE concurrent startup caller can abort its wait without stopping discovery owned by the first', async () => {
  const manager = new BleManager(); const ready = deferred<void>(); let calls = 0;
  manager.startDeviceScan = async () => { ++calls; await ready.promise; };
  const radio = new BlePlxRadio(manager, { permissionsGranted: granted });
  const first = radio.start(signal()); await tick();
  const controller = new AbortController(); const second = radio.start(controller.signal);
  controller.abort(); await assert.rejects(second, { name: 'AbortError' });
  assert.equal(manager.stopCalls, 0); assert.equal(calls, 1);
  ready.resolve(); await first; await radio.stop();
});
