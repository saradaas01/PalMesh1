import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RADIO_PERMISSIONS as P,
  RadioPermissionController,
  type IosBluetoothAuthorization,
  type NativeRadioPermissionBridge,
  type NativeRadioPermissionResult,
} from '../src/app/infrastructure/RadioPermissionController';
import { deferred, until } from './helpers/chat';

class Permissions implements NativeRadioPermissionBridge {
  readonly granted = new Set<string>();
  readonly checks: string[] = [];
  readonly prompts: string[][] = [];
  responses: Record<string, NativeRadioPermissionResult> = {};
  checkError: Error | undefined;
  nextRequest: ((names: readonly string[]) => Promise<Readonly<Record<string, NativeRadioPermissionResult>>>) | undefined;
  async check(permission: string): Promise<boolean> {
    this.checks.push(permission);
    if (this.checkError) throw this.checkError;
    return this.granted.has(permission);
  }
  async requestMultiple(names: readonly string[]): Promise<Readonly<Record<string, NativeRadioPermissionResult>>> {
    this.prompts.push([...names]);
    const result = this.nextRequest ? await this.nextRequest(names)
      : Object.fromEntries(names.map(name => [name, this.responses[name] ?? 'granted']));
    for (const permission of names) if (result[permission] === 'granted') this.granted.add(permission);
    return result;
  }
}

function android(apiLevel: number) {
  const bridge = new Permissions();
  return { bridge, permissions: new RadioPermissionController({ platform: 'android', apiLevel, bridge }) };
}

test('startup checks never prompt and SDK-specific nearby requests contain only the required permissions', async () => {
  const cases: readonly [number, readonly string[]][] = [
    [22, []], [23, [P.fineLocation]], [30, [P.fineLocation]],
    [31, [P.fineLocation, P.bluetoothScan, P.bluetoothConnect, P.bluetoothAdvertise]],
    [32, [P.fineLocation, P.bluetoothScan, P.bluetoothConnect, P.bluetoothAdvertise]],
    [33, [P.nearbyWifi, P.bluetoothScan, P.bluetoothConnect, P.bluetoothAdvertise]],
    [40, [P.nearbyWifi, P.bluetoothScan, P.bluetoothConnect, P.bluetoothAdvertise]],
  ];
  for (const [sdk, required] of cases) {
    const { permissions, bridge } = android(sdk);
    assert.deepEqual(await permissions.check(), {
      platform: 'android', wifiDirect: required.length === 0, bluetooth: required.length === 0, canRequest: required.length > 0,
    });
    assert.deepEqual(bridge.checks, required);
    assert.deepEqual(bridge.prompts, []);
    assert.deepEqual(await permissions.request(), { platform: 'android', wifiDirect: true, bluetooth: true, canRequest: false });
    const requested = required.flatMap(permission => (sdk === 31 || sdk === 32) && permission === P.fineLocation
      ? [P.fineLocation, P.coarseLocation] : [permission]);
    assert.deepEqual(bridge.prompts, required.length > 0 ? [requested] : []);
    assert.equal(Object.isFrozen(await permissions.check()), true);
    await permissions.request();
    assert.equal(bridge.prompts.length, required.length > 0 ? 1 : 0, 'already granted permissions never prompt again');
  }
});

test('a Wi-Fi denial leaves fully authorized Bluetooth available', async () => {
  const { permissions, bridge } = android(33);
  bridge.responses[P.nearbyWifi] = 'denied';
  assert.deepEqual(await permissions.request(), { platform: 'android', wifiDirect: false, bluetooth: true, canRequest: true });
  await permissions.request();
  assert.deepEqual(bridge.prompts[1], [P.nearbyWifi], 'only the missing Wi-Fi permission is requested again');
  assert.equal(bridge.prompts.flat().includes(P.fineLocation), false, 'Android 13+ nearby actions never request GPS access');
  assert.equal(bridge.prompts.flat().includes(P.coarseLocation), false);
});

test('Android 12 approximate-only access never claims Wi-Fi readiness and cannot disable authorized BLE', async () => {
  for (const sdk of [31, 32]) {
    const { permissions, bridge } = android(sdk);
    bridge.responses[P.fineLocation] = 'denied';
    assert.deepEqual(await permissions.request(), { platform: 'android', wifiDirect: false, bluetooth: true, canRequest: true });
    assert.equal(bridge.granted.has(P.coarseLocation), true);
    bridge.responses[P.fineLocation] = 'granted';
    assert.deepEqual(await permissions.request(), { platform: 'android', wifiDirect: true, bluetooth: true, canRequest: false });
    assert.deepEqual(bridge.prompts[1], [P.fineLocation, P.coarseLocation], 'precise upgrades still include the coarse companion');
  }
});

test('Android 12 coarse denial does not become an extra radio prerequisite or a repeated prompt', async () => {
  for (const sdk of [31, 32]) {
    const { permissions, bridge } = android(sdk);
    bridge.responses[P.coarseLocation] = 'never_ask_again';
    assert.deepEqual(await permissions.request(), { platform: 'android', wifiDirect: true, bluetooth: true, canRequest: false });
    assert.deepEqual(await permissions.check(), { platform: 'android', wifiDirect: true, bluetooth: true, canRequest: false });
    await permissions.request();
    assert.equal(bridge.prompts.length, 1);
  }
});

test('Bluetooth requires scan, connection and peripheral advertising authorization together', async () => {
  for (const denied of [P.bluetoothScan, P.bluetoothConnect, P.bluetoothAdvertise]) {
    const { permissions, bridge } = android(31);
    bridge.responses[denied] = 'denied';
    assert.deepEqual(await permissions.request(), { platform: 'android', wifiDirect: true, bluetooth: false, canRequest: true });
    await permissions.request();
    assert.deepEqual(bridge.prompts[1], [denied]);
  }
});

test('legacy Bluetooth and Wi-Fi share one location permission request without duplicate entries', async () => {
  const { permissions, bridge } = android(30);
  bridge.responses[P.fineLocation] = 'denied';
  assert.deepEqual(await permissions.request(), { platform: 'android', wifiDirect: false, bluetooth: false, canRequest: true });
  assert.deepEqual(bridge.prompts, [[P.fineLocation]]);
});

test('permanent denial does not repeatedly prompt and still permits requesting the other radio', async () => {
  const { permissions, bridge } = android(33);
  bridge.responses[P.nearbyWifi] = 'never_ask_again';
  bridge.responses[P.bluetoothScan] = 'denied';
  assert.deepEqual(await permissions.request(), { platform: 'android', wifiDirect: false, bluetooth: false, canRequest: true });
  bridge.responses[P.bluetoothScan] = 'granted';
  assert.deepEqual(await permissions.request(), { platform: 'android', wifiDirect: false, bluetooth: true, canRequest: false });
  assert.deepEqual(bridge.prompts[1], [P.bluetoothScan]);
  await permissions.request();
  assert.equal(bridge.prompts.length, 2);
  assert.deepEqual(await permissions.check(), { platform: 'android', wifiDirect: false, bluetooth: true, canRequest: false });
});

test('settings grants clear cached permanent denial so a later revocation can be requested', async () => {
  const { permissions, bridge } = android(30);
  bridge.responses[P.fineLocation] = 'never_ask_again';
  assert.equal((await permissions.request()).canRequest, false);
  bridge.granted.add(P.fineLocation);
  assert.equal((await permissions.check()).wifiDirect, true);
  bridge.granted.delete(P.fineLocation);
  assert.equal((await permissions.check()).canRequest, true);
  bridge.responses[P.fineLocation] = 'granted';
  assert.equal((await permissions.request()).bluetooth, true);
});

test('overlapping user requests share one native prompt and subsequent checks wait for its result', async () => {
  const { permissions, bridge } = android(33);
  const prompt = deferred<Readonly<Record<string, NativeRadioPermissionResult>>>();
  bridge.nextRequest = () => prompt.promise;
  const first = permissions.request();
  const second = permissions.request();
  assert.equal(first, second);
  await until(() => bridge.prompts.length === 1);
  const check = permissions.check();
  let checkResolved = false;
  void check.then(() => { checkResolved = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(checkResolved, false);
  prompt.resolve(Object.fromEntries(bridge.prompts[0]!.map(name => [name, 'granted'])));
  assert.equal((await first).bluetooth, true);
  assert.deepEqual(await second, await check);
  assert.equal(bridge.prompts.length, 1);
});

test('native check exceptions propagate without prompting and a later request can retry', async () => {
  const { permissions, bridge } = android(33);
  bridge.checkError = new Error('Native check unavailable');
  await assert.rejects(permissions.check(), /Native check unavailable/);
  await assert.rejects(permissions.request(), /Native check unavailable/);
  assert.deepEqual(bridge.prompts, []);
  bridge.checkError = undefined;
  assert.equal((await permissions.request()).wifiDirect, true);
});

test('a rejected shared native prompt clears request serialization for a deliberate retry', async () => {
  const { permissions, bridge } = android(30);
  const prompt = deferred<Readonly<Record<string, NativeRadioPermissionResult>>>();
  bridge.nextRequest = () => prompt.promise;
  const first = permissions.request();
  const second = permissions.request();
  const rejectedFirst = assert.rejects(first, /Activity unavailable/);
  const rejectedSecond = assert.rejects(second, /Activity unavailable/);
  await until(() => bridge.prompts.length === 1);
  prompt.reject(new Error('Activity unavailable'));
  await Promise.all([rejectedFirst, rejectedSecond]);
  bridge.nextRequest = undefined;
  assert.equal((await permissions.request()).wifiDirect, true);
  assert.equal(bridge.prompts.length, 2);
});

test('missing or malformed native request responses fail closed and allow retry', async () => {
  const { permissions, bridge } = android(33);
  bridge.nextRequest = async () => ({ [P.nearbyWifi]: 'never_ask_again' });
  await assert.rejects(permissions.request(), /Invalid native permission request result/);
  bridge.nextRequest = undefined;
  assert.deepEqual(await permissions.request(), { platform: 'android', wifiDirect: true, bluetooth: true, canRequest: false });
  assert.equal(bridge.prompts[1]?.includes(P.nearbyWifi), true, 'malformed results never partially cache permanent denial');
});

test('Android rejects unknown, malformed or non-integer SDK levels before any prompt', () => {
  const bridge = new Permissions();
  for (const apiLevel of [undefined, NaN, Infinity, -1, 0, 33.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => new RadioPermissionController({ platform: 'android', bridge,
      ...(apiLevel === undefined ? {} : { apiLevel }),
    }), /known positive integer API level/);
  }
  assert.throws(() => new RadioPermissionController({ platform: 'android', apiLevel: 33 }), /native permission bridge/);
  assert.deepEqual(bridge.prompts, []);
});

test('iOS and unsupported platforms do not claim BLE support or prompt without an authorization bridge', async () => {
  for (const platform of ['ios', 'unsupported'] as const) {
    const permissions = new RadioPermissionController({ platform });
    assert.deepEqual(await permissions.check(), { platform, wifiDirect: false, bluetooth: false, canRequest: false });
    assert.deepEqual(await permissions.request(), await permissions.check());
  }
});

test('an explicit iOS authorization bridge checks without prompts and only requests undetermined access', async () => {
  let authorization: IosBluetoothAuthorization = 'not-determined';
  let prompts = 0;
  const permissions = new RadioPermissionController({ platform: 'ios', iosBluetoothAuthorization: {
    check: async () => authorization,
    request: async () => { prompts += 1; return authorization = 'granted'; },
  } });
  assert.deepEqual(await permissions.check(), { platform: 'ios', wifiDirect: false, bluetooth: false, canRequest: true });
  assert.equal(prompts, 0);
  assert.deepEqual(await permissions.request(), { platform: 'ios', wifiDirect: false, bluetooth: true, canRequest: false });
  await permissions.request();
  assert.equal(prompts, 1);
  for (const denied of ['denied', 'restricted'] as const) {
    authorization = denied;
    assert.deepEqual(await permissions.request(), { platform: 'ios', wifiDirect: false, bluetooth: false, canRequest: false });
    assert.equal(prompts, 1, 'iOS denials require Settings, not repeated system prompts');
  }
});
