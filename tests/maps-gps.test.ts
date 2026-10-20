import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GeolocationSource, type GeolocationBridge } from '../src/features/maps/infrastructure/GeolocationSource';
import { deferred, until } from './helpers/chat';

type Success = Parameters<GeolocationBridge['watchPosition']>[0];
type Failure = Parameters<GeolocationBridge['watchPosition']>[1];
type Position = Parameters<Success>[0];
type Options = Parameters<GeolocationBridge['watchPosition']>[2];
const position: Position = { coords: { latitude: 31.5, longitude: 34.4 }, timestamp: 100_000 };

class ControlledGeolocation implements GeolocationBridge {
  readonly watches: { readonly success: Success; readonly error: Failure; readonly options: Options; readonly id: number }[] = [];
  readonly cleared: number[] = [];
  beforeReturn: ((success: Success, error: Failure) => void) | undefined;
  throwOnClear = false;
  watchPosition(success: Success, error: Failure, options: Options): number {
    const id = 40 + this.watches.length;
    this.watches.push({ success, error, options, id });
    this.beforeReturn?.(success, error);
    return id;
  }
  clearWatch(id: number): void {
    this.cleared.push(id);
    if (this.throwOnClear) throw new Error('Native clearWatch failed');
  }
}

function fixture(options: {
  permission?: () => Promise<'granted' | 'denied'>;
  bridge?: ControlledGeolocation;
  timeoutMs?: number;
  maximumAgeMs?: number;
} = {}) {
  const bridge = options.bridge ?? new ControlledGeolocation();
  let permissions = 0;
  const source = new GeolocationSource({
    bridge,
    requestPermission: () => { permissions += 1; return options.permission?.() ?? Promise.resolve('granted'); },
    timeoutMs: options.timeoutMs ?? 1_000,
    maximumAgeMs: options.maximumAgeMs ?? 60_000,
  });
  return { source, bridge, permissions: () => permissions };
}

test('a denied permission never starts a native GPS watch', async () => {
  const { source, bridge, permissions } = fixture({ permission: async () => 'denied' });
  assert.deepEqual(await source.read(new AbortController().signal), { status: 'denied' });
  assert.equal(permissions(), 1);
  assert.equal(bridge.watches.length, 0);
  assert.deepEqual(bridge.cleared, []);
});

test('an already-cancelled request cannot prompt for permission or start a watch', async () => {
  const { source, bridge, permissions } = fixture();
  const controller = new AbortController(); controller.abort();
  assert.deepEqual(await source.read(controller.signal), { status: 'cancelled' });
  assert.equal(permissions(), 0);
  assert.equal(bridge.watches.length, 0);
});

test('cancelling immediately after read prevents a permission prompt queued for the next microtask', async () => {
  const { source, bridge, permissions } = fixture();
  const controller = new AbortController();
  const reading = source.read(controller.signal);
  controller.abort();
  assert.deepEqual(await reading, { status: 'cancelled' });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(permissions(), 0, 'a cancelled action must not open a native permission prompt afterwards');
  assert.equal(bridge.watches.length, 0);
});

test('a granted temporary watch yields a frozen fix and clears the exact native watch after the first position', async () => {
  const { source, bridge } = fixture({ timeoutMs: 2_000, maximumAgeMs: 30_000 });
  const reading = source.read(new AbortController().signal);
  await until(() => bridge.watches.length === 1);
  assert.deepEqual(bridge.watches[0]?.options, {
    enableHighAccuracy: true, maximumAge: 30_000, timeout: 2_000, distanceFilter: 0,
  });
  bridge.watches[0]!.success(position);
  const result = await reading;
  assert.deepEqual(result, { status: 'fix', location: { latitude: 31.5, longitude: 34.4, timestamp: 100_000 } });
  if (result.status === 'fix') assert.equal(Object.isFrozen(result.location), true);
  assert.deepEqual(bridge.cleared, [40]);
  bridge.watches[0]!.success({ ...position, timestamp: 200_000 });
  bridge.watches[0]!.error({ code: 1 });
  assert.deepEqual(bridge.cleared, [40], 'late callbacks must not clear a second time');
  assert.deepEqual(await reading, result, 'the first fix is the only resolved result');
});

test('aborting during the permission prompt settles promptly and late permission cannot start a GPS watch', async () => {
  const permission = deferred<'granted' | 'denied'>();
  const { source, bridge, permissions } = fixture({ permission: () => permission.promise });
  const controller = new AbortController();
  const reading = source.read(controller.signal);
  await until(() => permissions() === 1);
  controller.abort();
  assert.deepEqual(await reading, { status: 'cancelled' });
  permission.resolve('granted');
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(bridge.watches.length, 0);
  assert.deepEqual(bridge.cleared, []);
  const next = source.read(new AbortController().signal);
  await until(() => bridge.watches.length === 1);
  bridge.watches[0]!.success(position);
  assert.equal((await next).status, 'fix', 'a cancelled prompt must release the single-reader guard');
});

test('the overall deadline includes permission wait and late authorization cannot activate GPS', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const permission = deferred<'granted' | 'denied'>();
  const { source, bridge, permissions } = fixture({ permission: () => permission.promise, timeoutMs: 500 });
  const reading = source.read(new AbortController().signal);
  await until(() => permissions() === 1);
  t.mock.timers.tick(500);
  assert.deepEqual(await reading, { status: 'unavailable' });
  permission.resolve('granted');
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(bridge.watches.length, 0);
});

for (const ending of ['cancelled', 'timeout'] as const) {
  test(`an active GPS ${ending} clears its native watch and ignores late fixes`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { source, bridge } = fixture({ timeoutMs: 500 });
    const controller = new AbortController();
    const reading = source.read(controller.signal);
    await until(() => bridge.watches.length === 1);
    if (ending === 'cancelled') controller.abort();
    else t.mock.timers.tick(500);
    const expected = { status: ending === 'cancelled' ? 'cancelled' : 'unavailable' };
    assert.deepEqual(await reading, expected);
    assert.deepEqual(bridge.cleared, [40]);
    bridge.watches[0]!.success(position);
    bridge.watches[0]!.error({ code: 1 });
    assert.deepEqual(await reading, expected);
    assert.deepEqual(bridge.cleared, [40]);
    const next = source.read(new AbortController().signal);
    await until(() => bridge.watches.length === 2);
    bridge.watches[1]!.success(position);
    assert.equal((await next).status, 'fix');
    assert.deepEqual(bridge.cleared, [40, 41]);
  });
}

for (const callback of ['success', 'error'] as const) {
  test(`a synchronous native ${callback} before watchPosition returns still clears the returned watch ID`, async () => {
    const { source, bridge } = fixture();
    bridge.beforeReturn = (success, error) => callback === 'success' ? success(position) : error({ code: 1 });
    const result = await source.read(new AbortController().signal);
    assert.equal(result.status, callback === 'success' ? 'fix' : 'denied');
    assert.deepEqual(bridge.cleared, [40]);
    assert.equal(bridge.watches.length, 1);
  });
}

test('malformed native coordinates and timestamps cannot escape as location fixes and always clear the watch', async () => {
  const malformed: readonly unknown[] = [
    { coords: { latitude: Number.NaN, longitude: 34 }, timestamp: 1 },
    { coords: { latitude: 91, longitude: 34 }, timestamp: 1 },
    { coords: { latitude: 31, longitude: 181 }, timestamp: 1 },
    { coords: { latitude: 31, longitude: 34 }, timestamp: -1 },
    { coords: { latitude: 31, longitude: 34 }, timestamp: 1.5 },
    { timestamp: 1 },
    null,
  ];
  for (const value of malformed) {
    const { source, bridge } = fixture();
    const reading = source.read(new AbortController().signal);
    await until(() => bridge.watches.length === 1);
    bridge.watches[0]!.success(value as Position);
    assert.deepEqual(await reading, { status: 'unavailable' });
    assert.deepEqual(bridge.cleared, [40]);
  }
});

test('native permission-denied errors remain distinguishable from unavailable GPS', async () => {
  for (const code of [1, 2, 3]) {
    const { source, bridge } = fixture();
    const reading = source.read(new AbortController().signal);
    await until(() => bridge.watches.length === 1);
    bridge.watches[0]!.error({ code });
    assert.deepEqual(await reading, { status: code === 1 ? 'denied' : 'unavailable' });
    assert.deepEqual(bridge.cleared, [40]);
  }
});

for (const failure of ['throws', 'rejects'] as const) {
  test(`a permission request that ${failure} settles unavailable without creating a watch and permits another read`, async () => {
    let fail = true;
    const { source, bridge } = fixture({ permission: () => {
      if (!fail) return Promise.resolve('granted');
      if (failure === 'throws') throw new Error('Native permission API unavailable');
      return Promise.reject(new Error('Native permission request failed'));
    } });
    assert.deepEqual(await source.read(new AbortController().signal), { status: 'unavailable' });
    assert.equal(bridge.watches.length, 0);
    fail = false;
    const reading = source.read(new AbortController().signal);
    await until(() => bridge.watches.length === 1);
    bridge.watches[0]!.success(position);
    assert.equal((await reading).status, 'fix');
  });
}

test('simultaneous reads never create a second permission request or watch and cannot cancel the first reader', async () => {
  const { source, bridge, permissions } = fixture();
  const firstController = new AbortController();
  const first = source.read(firstController.signal);
  await until(() => bridge.watches.length === 1);
  const secondController = new AbortController();
  assert.deepEqual(await source.read(secondController.signal), { status: 'unavailable' });
  secondController.abort();
  assert.equal(permissions(), 1);
  assert.equal(bridge.watches.length, 1);
  assert.deepEqual(bridge.cleared, []);
  bridge.watches[0]!.success(position);
  assert.equal((await first).status, 'fix');
  assert.equal(firstController.signal.aborted, false);
  assert.deepEqual(bridge.cleared, [40]);
});

test('a native clear failure cannot leave the GPS request pending or keep the single-reader lock', async () => {
  const { source, bridge } = fixture();
  bridge.throwOnClear = true;
  const first = source.read(new AbortController().signal);
  await until(() => bridge.watches.length === 1);
  bridge.watches[0]!.success(position);
  assert.equal((await first).status, 'fix');
  const second = source.read(new AbortController().signal);
  await until(() => bridge.watches.length === 2);
  bridge.watches[1]!.success(position);
  assert.equal((await second).status, 'fix');
  assert.deepEqual(bridge.cleared, [40, 41]);
});

test('a synchronous native watch creation failure settles unavailable and a later request can recover', async () => {
  const { source, bridge } = fixture();
  const watchPosition = bridge.watchPosition.bind(bridge);
  bridge.watchPosition = () => { throw new Error('Native GPS module unavailable'); };
  assert.deepEqual(await source.read(new AbortController().signal), { status: 'unavailable' });
  assert.deepEqual(bridge.cleared, []);
  bridge.watchPosition = watchPosition;
  const recovered = source.read(new AbortController().signal);
  await until(() => bridge.watches.length === 1);
  bridge.watches[0]!.success(position);
  assert.equal((await recovered).status, 'fix');
  assert.deepEqual(bridge.cleared, [40]);
});

test('a finished action removes its abort listener so cancelling it later cannot stop a new native watch', async () => {
  const { source, bridge } = fixture();
  const previous = new AbortController();
  const first = source.read(previous.signal);
  await until(() => bridge.watches.length === 1);
  bridge.watches[0]!.success(position);
  assert.equal((await first).status, 'fix');
  const second = source.read(new AbortController().signal);
  await until(() => bridge.watches.length === 2);
  previous.abort();
  assert.deepEqual(bridge.cleared, [40]);
  bridge.watches[1]!.success(position);
  assert.equal((await second).status, 'fix');
  assert.deepEqual(bridge.cleared, [40, 41]);
});
