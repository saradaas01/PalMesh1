import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  NativeMeshRuntime, NativeRuntimeUnavailableError,
  type BatteryState, type NativeMeshRuntimeModule, type NativeRuntimeEvent,
} from '../src/app/infrastructure/NativeMeshRuntime';

const battery: BatteryState = { level: 0.42, charging: false, lowPower: false };

function fixture(platform: 'android' | 'ios' = 'android') {
  const log: unknown[] = [];
  let granted = true;
  let batteryValue: unknown = battery;
  let start: () => Promise<void> = async () => {};
  let request: () => Promise<void> = async () => { granted = true; };
  let nativeListener: ((event: unknown) => void) | undefined;
  const bridge: NativeMeshRuntimeModule = {
    async checkNotifications() { log.push('check'); return granted; },
    async startMeshService() { log.push('start'); await start(); },
    async stopMeshService() { log.push('stop'); },
    async getBatteryState() { return batteryValue as BatteryState; },
    async showEmergencyNotification(id) { log.push(['alert', id]); },
    async cancelEmergencyNotification(id) { log.push(['cancel', id]); },
    addListener() {}, removeListeners() {},
  };
  const runtime = new NativeMeshRuntime({
    platform, bridge,
    events: { addListener(name, listener) {
      assert.equal(name, 'PalMeshRuntimeEvent');
      log.push('listen'); nativeListener = listener;
      return { remove() { log.push('unlisten'); nativeListener = undefined; } };
    } },
    notifications: { async request() { log.push('prompt'); await request(); } },
  });
  return { runtime, log,
    setGranted(value: boolean) { granted = value; },
    setBattery(value: unknown) { batteryValue = value; },
    setStart(value: typeof start) { start = value; },
    setRequest(value: typeof request) { request = value; },
    emit(event: unknown) { nativeListener?.(event); },
  };
}

test('construction, battery observation and background activation never prompt for notifications', async () => {
  const f = fixture();
  assert.deepEqual(f.log, []);
  const remove = f.runtime.subscribe(() => {});
  assert.deepEqual(await f.runtime.getBatteryState(), battery);
  await f.runtime.start();
  await f.runtime.stop();
  remove();
  assert.deepEqual(f.log, ['listen', 'check', 'start', 'stop', 'unlisten']);
});

test('notification denial fails closed before starting the foreground service', async () => {
  const f = fixture(); f.setGranted(false);
  await assert.rejects(f.runtime.start(), error => error instanceof NativeRuntimeUnavailableError && error.code === 'notifications-disabled');
  assert.deepEqual(f.log, ['check']);
});

test('explicit notification requests coalesce duplicate taps and return the actual OS permission state', async () => {
  const f = fixture(); f.setGranted(false);
  let release!: () => void;
  f.setRequest(() => new Promise<void>(resolve => { release = resolve; }));
  const first = f.runtime.requestNotifications();
  const second = f.runtime.requestNotifications();
  assert.equal(first, second);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(f.log, ['check', 'prompt']);
  release();
  assert.equal(await first, false, 'denied permission never becomes a granted report');
  f.setGranted(true);
  assert.equal(await f.runtime.requestNotifications(), true);
  assert.equal(f.log.filter(entry => entry === 'prompt').length, 1);
});

test('stop waits for a pending native start, and a rejected start cannot poison later cleanup', async () => {
  const f = fixture();
  let release!: () => void;
  f.setStart(() => new Promise<void>(resolve => { release = resolve; }));
  const starting = f.runtime.start();
  await new Promise<void>(resolve => setImmediate(resolve));
  const stopping = f.runtime.stop();
  assert.deepEqual(f.log, ['check', 'start']);
  release();
  await Promise.all([starting, stopping]);
  assert.deepEqual(f.log, ['check', 'start', 'stop']);
  f.setStart(async () => { throw new Error('OS denied background execution'); });
  await assert.rejects(f.runtime.start(), /OS denied/);
  await f.runtime.stop();
  assert.equal(f.log.at(-1), 'stop');
});

test('iOS and unlinked hosts cannot falsely report an Android background service', async () => {
  const ios = fixture('ios');
  assert.equal(ios.runtime.supportsBackground, false);
  await assert.rejects(ios.runtime.start(), error => error instanceof NativeRuntimeUnavailableError && error.code === 'background-unsupported');
  await ios.runtime.stop();
  assert.deepEqual(ios.log, []);
  const missing = new NativeMeshRuntime({ platform: 'android' });
  assert.equal(await missing.checkNotifications(), false);
  await assert.rejects(missing.getBatteryState(), error => error instanceof NativeRuntimeUnavailableError && error.code === 'runtime-unavailable');
});

test('battery state validates native readings, freezes snapshots and drops malformed events', async () => {
  const f = fixture(); const events: NativeRuntimeEvent[] = [];
  const remove = f.runtime.subscribe(event => { events.push(event); });
  f.emit({ type: 'battery', battery });
  f.emit({ type: 'battery', battery: { ...battery, level: -1 } });
  f.emit({ type: 'battery', battery: { ...battery, level: Number.NaN } });
  f.emit({ type: 'battery', battery: { ...battery, lowPower: 'yes' } });
  f.emit({ type: 'battery' });
  assert.equal(events.length, 1);
  const event = events[0];
  assert.equal(event?.type, 'battery');
  assert.ok(Object.isFrozen(event));
  if (event?.type === 'battery') assert.ok(Object.isFrozen(event.battery));
  f.setBattery({ ...battery, level: null });
  assert.equal((await f.runtime.getBatteryState()).level, null);
  f.setBattery({ ...battery, level: 42 });
  await assert.rejects(f.runtime.getBatteryState(), /Invalid native battery state/);
  remove();
});

test('one native subscription handles user-stop events, isolates observers and detaches exactly once', () => {
  const f = fixture(); const events: NativeRuntimeEvent[] = [];
  const removeFaulty = f.runtime.subscribe(() => { throw new Error('observer failed'); });
  const remove = f.runtime.subscribe(event => { events.push(event); });
  f.emit({ type: 'background', running: true, reason: 'started' });
  f.emit({ type: 'background', running: false, reason: 'user-stopped' });
  f.emit({ type: 'background', running: true, reason: 'user-stopped' });
  f.emit({ type: 'background', running: false, reason: 'unrecognized' });
  assert.deepEqual(events, [
    { type: 'background', running: true, reason: 'started' },
    { type: 'background', running: false, reason: 'user-stopped' },
  ]);
  removeFaulty(); removeFaulty();
  assert.deepEqual(f.log, ['listen']);
  remove(); remove();
  assert.deepEqual(f.log, ['listen', 'unlisten']);
  f.emit({ type: 'background', running: false, reason: 'stopped' });
  assert.equal(events.length, 2);
});

test('SOS native notifications cross the bridge with only an opaque identifier', async () => {
  const f = fixture();
  await f.runtime.notifyIncoming({ id: 'sos-123', source: 'sensitive-sender', text: '31.7,35.2' });
  await f.runtime.cancel('sos-123');
  assert.deepEqual(f.log, [['alert', 'sos-123'], ['cancel', 'sos-123']]);
  await assert.rejects(f.runtime.notifyIncoming({ id: '../private' }), /Invalid emergency alert identifier/);
  await assert.rejects(f.runtime.cancel(''), /Invalid emergency alert identifier/);
  assert.equal(f.log.length, 2);
});
