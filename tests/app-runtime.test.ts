import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { AppRuntime, type AppRuntimeOptions } from '../src/app/application/AppRuntime';
import { BootstrapError, type BootstrapErrorCode } from '../src/app/domain/BootstrapError';
import type { RadioPermissionReport, RadioPermissions, RuntimeResources } from '../src/app/domain/types';
import type { BatteryState, NativeRuntimeEvent } from '../src/app/infrastructure/NativeMeshRuntime';
import type { ChatSnapshot } from '../src/features/chat';
import type { PowerMode } from '../src/features/dtn';
import type { LocationActionResult, MapsSnapshot } from '../src/features/maps';
import type { MeshEvent } from '../src/features/mesh';
import { deferred, stored, until } from './helpers/chat';

const denied: RadioPermissionReport = { platform: 'android', wifiDirect: false, bluetooth: false, canRequest: true };
const granted: RadioPermissionReport = { platform: 'android', wifiDirect: true, bluetooth: true, canRequest: true };
type Operation = 'engine.start' | 'mesh.start' | 'mesh.stop' | 'mesh.refresh' | 'node.stop'
  | 'chat.start' | 'chat.stop' | 'chat.refresh' | 'locations.start' | 'locations.stop' | 'locations.refresh' | 'release';

function controlledResources() {
  const log: string[] = [];
  const effects: Partial<Record<Operation, () => Promise<void>>> = {};
  const listeners = new Set<(event: MeshEvent) => void>();
  const subscriptions: ((event: MeshEvent) => void)[] = [];
  const state = { chatVisible: true, locationsVisible: true, discovery: false, peers: [] as string[], sosCalls: 0, enginePublications: 0, chatSosCalls: 0 };
  const power = { engine: 'normal' as PowerMode, locations: 'normal' as PowerMode };
  let pendingRadioStops = 0; let startsDuringStop = 0;
  let sos: () => Promise<LocationActionResult> = async () => ({ status: 'queued', messageId: randomUUID() });
  const run = async (operation: Operation): Promise<void> => { log.push(operation); await effects[operation]?.(); };
  const radio = async (operation: 'mesh.start' | 'mesh.stop' | 'mesh.refresh'): Promise<void> => {
    if (operation === 'mesh.start' && pendingRadioStops > 0) startsDuringStop += 1;
    if (operation === 'mesh.stop') pendingRadioStops += 1;
    try {
      await run(operation);
      if (operation !== 'mesh.refresh') state.discovery = operation === 'mesh.start';
    } finally { if (operation === 'mesh.stop') pendingRadioStops -= 1; }
  };
  const chatSnapshot: ChatSnapshot = {
    status: 'ready', conversations: [], messages: [], selectedConversationId: null,
    connectedPeers: [], draft: '', pendingSend: false, pendingSos: false,
    hasOlderMessages: false, issue: null, notice: null, now: 100_000,
  };
  const mapsSnapshot: MapsSnapshot = {
    status: 'ready', mapStatus: 'unavailable', map: null, localLocation: null, peers: [],
    sharing: false, powerMode: 'normal', locating: false, pendingSos: false, issue: null, notice: null, now: 100_000,
  };
  const resources: RuntimeResources = {
    deviceId: 'alice',
    node: {
      engine: {
        start: () => run('engine.start'),
        async publish(input) { state.enginePublications += 1; return { status: 'accepted', record: stored(input) }; },
        setPowerMode(mode) { power.engine = mode; log.push(`engine.power:${mode}`); },
      },
      mesh: {
        start: () => radio('mesh.start'), stop: () => radio('mesh.stop'), refreshRadios: () => radio('mesh.refresh'),
        connectedPeers: () => state.peers,
        subscribe(listener) {
          listeners.add(listener); subscriptions.push(listener); log.push('mesh.subscribe');
          return () => { listeners.delete(listener); log.push('mesh.unsubscribe'); };
        },
      },
      async start() { throw new Error('Runtime must start the engine separately to avoid starting discovery in background'); },
      stop: () => run('node.stop'),
    },
    chat: {
      deviceId: 'alice', getSnapshot: () => chatSnapshot, subscribe: () => () => {},
      start: () => run('chat.start'), stop: () => run('chat.stop'), refresh: () => run('chat.refresh'),
      setVisible(visible) { state.chatVisible = visible; log.push(`chat.visible:${visible}`); },
      async openConversation() {}, closeConversation() {}, setDraft() {}, async loadOlder() {},
      async send() { return { status: 'rejected', reason: 'empty' }; },
      async sendSos() { state.chatSosCalls += 1; return { status: 'queued', messageId: randomUUID() }; },
      dismissIssue() {}, dismissNotice() {},
    },
    locations: {
      deviceId: 'alice', getSnapshot: () => mapsSnapshot, subscribe: () => () => {},
      start: () => run('locations.start'), stop: () => run('locations.stop'), refresh: () => run('locations.refresh'),
      setVisible(visible) { state.locationsVisible = visible; log.push(`locations.visible:${visible}`); },
      setPowerMode(mode) { power.locations = mode; log.push(`locations.power:${mode}`); },
      async setSharing() {}, async refreshLocal() { return { status: 'updated' }; },
      async shareOnce() { return { status: 'queued', messageId: randomUUID() }; },
      sendSos() { state.sosCalls += 1; return sos(); }, dismissIssue() {}, dismissNotice() {},
    },
    release: () => run('release'),
  };
  return {
    resources, log, effects, listeners, subscriptions, state, power,
    setSos(callback: () => Promise<LocationActionResult>) { sos = callback; },
    emit(event: MeshEvent) { for (const listener of [...listeners]) listener(event); },
    startsDuringStop: () => startsDuringStop,
  };
}

function controlledPermissions() {
  let checks = 0; let requests = 0;
  let check: () => Promise<RadioPermissionReport> = async () => denied;
  let request: () => Promise<RadioPermissionReport> = async () => granted;
  const permissions: RadioPermissions = {
    check: () => { checks += 1; return check(); },
    request: () => { requests += 1; return request(); },
  };
  return {
    permissions, checks: () => checks, requests: () => requests,
    setCheck(callback: typeof check) { check = callback; }, setRequest(callback: typeof request) { request = callback; },
  };
}

function fixture(t: TestContext, initiallyForeground = true, platformRuntime?: AppRuntimeOptions['platformRuntime']) {
  const controlled = controlledResources();
  const permissions = controlledPermissions();
  const runtime = new AppRuntime({ createResources: async () => controlled.resources, permissions: permissions.permissions, initiallyForeground,
    ...(platformRuntime ? { platformRuntime } : {}) });
  t.after(() => runtime.stop());
  return { runtime, ...controlled, permissions };
}

function controlledPlatform(supportsBackground = true) {
  const calls = { starts: 0, stops: 0, requests: 0, checks: 0, batteryReads: 0, unsubscribes: 0 };
  const listeners = new Set<(event: NativeRuntimeEvent) => void>();
  const subscriptions: ((event: NativeRuntimeEvent) => void)[] = [];
  let notificationRequest: () => Promise<boolean> = async () => true;
  let notificationCheck: () => Promise<boolean> = async () => false;
  let readBattery: () => Promise<BatteryState> = async () => ({ level: 0.7, charging: false, lowPower: false });
  let start: () => Promise<void> = async () => {};
  const platformRuntime: NonNullable<AppRuntimeOptions['platformRuntime']> = {
    supportsBackground,
    async start() { calls.starts++; await start(); },
    async stop() { calls.stops++; },
    async requestNotifications() { calls.requests++; return notificationRequest(); },
    async checkNotifications() { calls.checks++; return notificationCheck(); },
    async getBatteryState() { calls.batteryReads++; return readBattery(); },
    subscribe(listener) {
      listeners.add(listener); subscriptions.push(listener);
      return () => { calls.unsubscribes++; listeners.delete(listener); };
    },
  };
  return {
    platformRuntime, calls, listeners, subscriptions,
    setNotificationRequest(callback: typeof notificationRequest) { notificationRequest = callback; },
    setNotificationCheck(callback: typeof notificationCheck) { notificationCheck = callback; },
    setBatteryRead(callback: typeof readBattery) { readBattery = callback; },
    setStart(callback: typeof start) { start = callback; },
    emit(event: NativeRuntimeEvent) { for (const listener of [...listeners]) listener(event); },
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await new Promise<void>(resolve => setImmediate(resolve));
}

test('starts a single runtime with both features hidden until ready and checks permissions without prompting', async t => {
  const { runtime, log, state, resources, permissions } = fixture(t);
  await runtime.start();
  assert.equal(runtime.getSnapshot().status, 'ready');
  assert.equal(runtime.getSnapshot().resources, resources);
  assert.equal(runtime.getSnapshot().route, 'chat');
  assert.equal(state.chatVisible, true); assert.equal(state.locationsVisible, false);
  assert.equal(log.filter(entry => entry === 'engine.start').length, 1);
  for (const operation of ['engine.start', 'chat.start', 'locations.start']) {
    assert.ok(log.indexOf('chat.visible:false') < log.indexOf(operation));
    assert.ok(log.indexOf('locations.visible:false') < log.indexOf(operation));
  }
  assert.equal(permissions.checks(), 1); assert.equal(permissions.requests(), 0);
  assert.deepEqual(runtime.getSnapshot().permissions, denied);
  await runtime.start();
  assert.equal(log.filter(entry => entry === 'engine.start').length, 1, 'start is idempotent');
});

test('initial background startup loads durable features without starting radio discovery or exposing either screen', async t => {
  const { runtime, state, log, permissions } = fixture(t, false);
  await runtime.start();
  assert.equal(runtime.getSnapshot().status, 'ready');
  assert.equal(runtime.getSnapshot().foreground, false);
  assert.equal(state.chatVisible, false); assert.equal(state.locationsVisible, false);
  assert.ok(log.includes('engine.start')); assert.ok(log.includes('chat.start')); assert.ok(log.includes('locations.start'));
  assert.equal(log.includes('mesh.start'), false);
  assert.equal(permissions.requests(), 0);
});

test('navigation and foreground state expose exactly the selected feature and backgrounding keeps archives and the engine running', async t => {
  const { runtime, state, log, permissions } = fixture(t);
  await runtime.start();
  runtime.navigate('maps');
  assert.equal(state.chatVisible, false); assert.equal(state.locationsVisible, true);
  runtime.setForeground(false);
  assert.equal(state.chatVisible, false); assert.equal(state.locationsVisible, false);
  await until(() => !state.discovery, 'radio discovery stopped');
  assert.equal(log.includes('chat.stop'), false); assert.equal(log.includes('locations.stop'), false); assert.equal(log.includes('node.stop'), false);
  runtime.navigate('chat');
  assert.equal(state.chatVisible, false); assert.equal(state.locationsVisible, false);
  runtime.setForeground(true);
  await until(() => state.discovery && log.includes('chat.refresh') && log.includes('locations.refresh'), 'foreground reconnection and refresh');
  assert.equal(state.chatVisible, true); assert.equal(state.locationsVisible, false);
  assert.ok(permissions.checks() >= 2, 'resume rechecks already granted permissions');
  assert.equal(permissions.requests(), 0, 'resume cannot open a native permission prompt');
});

test('a new foreground discovery start waits for every earlier stop despite rapid visibility changes', { timeout: 5_000 }, async t => {
  const firstRelease = deferred(); const laterRelease = deferred(); const entered = deferred();
  t.after(() => { firstRelease.resolve(); laterRelease.resolve(); });
  const { runtime, state, effects, startsDuringStop } = fixture(t);
  await runtime.start(); await settle();
  let stops = 0;
  effects['mesh.stop'] = async () => {
    stops += 1; entered.resolve();
    await (stops === 1 ? firstRelease.promise : laterRelease.promise);
  };
  runtime.setForeground(false); await entered.promise;
  runtime.setForeground(true); runtime.setForeground(false); runtime.setForeground(true);
  firstRelease.resolve(); await settle();
  assert.equal(startsDuringStop(), 0, 'a queued stale resume must not restart discovery while a later stop is pending');
  laterRelease.resolve();
  await until(() => state.discovery && runtime.getSnapshot().foreground, 'latest foreground radio state');
  await settle();
  assert.equal(state.discovery, true);
  assert.equal(startsDuringStop(), 0);
});

test('permission prompts are explicit, single-flight, and followed by a radio refresh; denied access still allows local SOS', { timeout: 5_000 }, async t => {
  const release = deferred<RadioPermissionReport>();
  t.after(() => release.resolve(denied));
  const { runtime, permissions, log } = fixture(t);
  permissions.setRequest(() => release.promise); permissions.setCheck(async () => granted);
  await runtime.start();
  const first = runtime.requestPermissions(); const repeated = runtime.requestPermissions();
  assert.equal(runtime.getSnapshot().requestingPermissions, true);
  assert.equal(permissions.requests(), 1);
  release.resolve(denied); await Promise.all([first, repeated]);
  assert.equal(runtime.getSnapshot().requestingPermissions, false);
  assert.ok(log.includes('mesh.refresh'));
  assert.equal(runtime.getSnapshot().status, 'ready');
  assert.equal((await runtime.sendSos()).status, 'queued');
  runtime.setForeground(false); await settle();
  await runtime.requestPermissions();
  assert.equal(permissions.requests(), 1, 'a hidden app must not open a permission prompt');
});

test('a permission-check failure is recoverable without tearing down offline messaging or SOS', async t => {
  const { runtime, permissions } = fixture(t);
  permissions.setCheck(async () => { throw new Error('Native permissions module unavailable'); });
  await runtime.start();
  assert.equal(runtime.getSnapshot().status, 'ready');
  assert.equal(runtime.getSnapshot().issue, 'permissions-unavailable');
  assert.equal((await runtime.sendSos()).status, 'queued');
  permissions.setCheck(async () => granted);
  await runtime.requestPermissions();
  assert.deepEqual(runtime.getSnapshot().permissions, granted);
  assert.equal(runtime.getSnapshot().requestingPermissions, false);
});

test('radio events update peer and radio status while stale callbacks after stop cannot change the snapshot', async t => {
  const { runtime, emit, subscriptions, listeners } = fixture(t);
  await runtime.start();
  emit({ type: 'peers', peers: ['bob', 'carol'] });
  emit({ type: 'radio-status', radio: 'ble', status: { available: false, reason: 'powered-off' } });
  assert.equal(runtime.getSnapshot().connectedPeers, 2);
  assert.deepEqual(runtime.getSnapshot().radios.ble, { available: false, reason: 'powered-off' });
  emit({ type: 'error', operation: 'discover', error: new Error('Adapter temporarily unavailable') });
  assert.equal(runtime.getSnapshot().issue, 'radio-error');
  runtime.dismissIssue(); assert.equal(runtime.getSnapshot().issue, null);
  const stale = subscriptions[0]!;
  await runtime.stop();
  assert.equal(listeners.size, 0);
  const stopped = runtime.getSnapshot();
  stale({ type: 'peers', peers: ['late-peer'] });
  stale({ type: 'error', operation: 'discover', error: new Error('Late native error') });
  assert.equal(runtime.getSnapshot(), stopped, 'generation guards reject detached native callbacks');
});

test('shared SOS uses the location service from either route and exposes truthful capacity and failure outcomes', async t => {
  const { runtime, state, setSos } = fixture(t);
  await runtime.start();
  for (const route of ['chat', 'maps'] as const) {
    runtime.navigate(route);
    assert.equal((await runtime.sendSos()).status, 'queued');
    assert.equal(runtime.getSnapshot().notice, 'sos-queued');
    runtime.dismissNotice(); assert.equal(runtime.getSnapshot().notice, null);
  }
  assert.equal(state.sosCalls, 2); assert.equal(state.chatSosCalls, 0); assert.equal(state.enginePublications, 0);
  setSos(async () => ({ status: 'rejected', reason: 'capacity' }));
  assert.deepEqual(await runtime.sendSos(), { status: 'rejected', reason: 'capacity' });
  assert.equal(runtime.getSnapshot().issue, 'queue-full'); assert.equal(runtime.getSnapshot().notice, null);
  setSos(async () => { throw new Error('Routing database unavailable'); });
  assert.deepEqual(await runtime.sendSos(), { status: 'rejected', reason: 'unavailable' });
  assert.equal(runtime.getSnapshot().issue, 'sos-unavailable'); assert.equal(runtime.getSnapshot().pendingSos, false);
});

test('SOS rejects before startup and prevents duplicate taps during a pending durable commit', { timeout: 5_000 }, async t => {
  const release = deferred<LocationActionResult>();
  t.after(() => release.resolve({ status: 'rejected', reason: 'unavailable' }));
  const { runtime, state, setSos } = fixture(t);
  assert.deepEqual(await runtime.sendSos(), { status: 'rejected', reason: 'unavailable' });
  assert.equal(state.sosCalls, 0);
  await runtime.start();
  setSos(() => release.promise);
  const sending = runtime.sendSos();
  assert.equal(runtime.getSnapshot().pendingSos, true);
  assert.deepEqual(await runtime.sendSos(), { status: 'rejected', reason: 'busy' });
  assert.equal(state.sosCalls, 1);
  release.resolve({ status: 'queued', messageId: randomUUID() });
  assert.equal((await sending).status, 'queued');
  assert.equal(runtime.getSnapshot().pendingSos, false);
});

test('battery mode reaches both routing and location sharing without recreating resources', async t => {
  const { runtime, power, log } = fixture(t);
  runtime.setPowerMode('conserve');
  await runtime.start();
  assert.equal(runtime.getSnapshot().powerMode, 'conserve');
  assert.deepEqual(power, { engine: 'conserve', locations: 'conserve' });
  runtime.setPowerMode('normal');
  assert.deepEqual(power, { engine: 'normal', locations: 'normal' });
  assert.equal(log.filter(entry => entry === 'engine.start').length, 1);
});

test('shutdown hides both features immediately, completes all stops despite failures, and releases handles last', { timeout: 5_000 }, async t => {
  const chatRelease = deferred(); const nodeRelease = deferred();
  t.after(() => { chatRelease.resolve(); nodeRelease.resolve(); });
  const { runtime, state, log, effects } = fixture(t);
  await runtime.start(); runtime.navigate('maps');
  effects['chat.stop'] = async () => { await chatRelease.promise; throw new Error('Chat unsubscribe failed'); };
  effects['locations.stop'] = async () => { throw new Error('GPS cleanup failed'); };
  effects['node.stop'] = () => nodeRelease.promise;
  const stopping = runtime.stop();
  assert.equal(state.chatVisible, false); assert.equal(state.locationsVisible, false);
  assert.equal(runtime.getSnapshot().foreground, false);
  await until(() => log.includes('chat.stop'), 'feature shutdown');
  assert.equal(log.includes('release'), false);
  chatRelease.resolve();
  await until(() => log.includes('locations.stop') && log.includes('node.stop'), 'all cleanup operations');
  assert.equal(log.includes('release'), false, 'SQLite handles must stay open while node shutdown is pending');
  nodeRelease.resolve(); await stopping;
  assert.equal(log.at(-1), 'release');
  assert.equal(runtime.getSnapshot().status, 'idle'); assert.equal(runtime.getSnapshot().resources, null);
});

test('a resource-factory failure leaves an actionable startup error and retries with fresh resources', async t => {
  const controlled = controlledResources(); const permissions = controlledPermissions();
  let creates = 0;
  const runtime = new AppRuntime({
    permissions: permissions.permissions,
    async createResources() { creates += 1; if (creates === 1) throw new Error('SQLite open failed'); return controlled.resources; },
  });
  t.after(() => runtime.stop());
  await runtime.start();
  assert.equal(runtime.getSnapshot().status, 'error'); assert.equal(runtime.getSnapshot().issue, 'startup-failed');
  assert.equal(runtime.getSnapshot().startupFailure, 'unknown');
  assert.equal(JSON.stringify(runtime.getSnapshot()).includes('SQLite open failed'), false);
  assert.equal(runtime.getSnapshot().resources, null);
  await runtime.start();
  assert.equal(creates, 2); assert.equal(runtime.getSnapshot().status, 'ready');
  assert.equal(runtime.getSnapshot().startupFailure, null);
  assert.equal(runtime.getSnapshot().resources, controlled.resources);
});

for (const code of ['secure-storage-unavailable', 'encryption-unavailable', 'data-recovery-required',
  'identity-recovery-required', 'provisioning-incomplete'] satisfies BootstrapErrorCode[]) {
  test(`sanitizes ${code} into a recovery category and clears it throughout a successful retry`, async t => {
    const controlled = controlledResources(); const permissions = controlledPermissions();
    let failure = true;
    const runtime = new AppRuntime({ permissions: permissions.permissions,
      async createResources() { if (failure) throw new BootstrapError(code); return controlled.resources; } });
    t.after(() => runtime.stop());
    await runtime.start();
    assert.equal(runtime.getSnapshot().status, 'error');
    assert.equal(runtime.getSnapshot().startupFailure, code);
    assert.equal(runtime.getSnapshot().resources, null);
    assert.equal(controlled.log.includes('engine.start'), false);
    assert.equal((await runtime.sendSos()).status, 'rejected');
    assert.equal(controlled.state.sosCalls, 0);
    const seen: { status: string; failure: string | null }[] = [];
    const unsubscribe = runtime.subscribe(() => { const snapshot = runtime.getSnapshot(); seen.push({ status: snapshot.status, failure: snapshot.startupFailure }); });
    failure = false;
    await runtime.start();
    unsubscribe();
    assert.equal(runtime.getSnapshot().status, 'ready');
    assert.equal(runtime.getSnapshot().startupFailure, null);
    assert.equal(runtime.getSnapshot().issue, null);
    assert.ok(seen.some(snapshot => snapshot.status === 'starting' && snapshot.failure === null));
    await runtime.stop();
    assert.equal(runtime.getSnapshot().startupFailure, null);
  });
}

test('untrusted error-like values never select privileged recovery guidance or expose their native messages', async t => {
  for (const failure of [Object.assign(new Error('private-native-path-and-key'), { code: 'identity-recovery-required' }),
    { code: 'data-recovery-required', message: 'private-native-path-and-key' }, 'private-native-path-and-key', null]) {
    const runtime = new AppRuntime({ permissions: controlledPermissions().permissions,
      async createResources() { throw failure; } });
    t.after(() => runtime.stop());
    await runtime.start();
    assert.equal(runtime.getSnapshot().status, 'error');
    assert.equal(runtime.getSnapshot().startupFailure, 'unknown');
    assert.equal(JSON.stringify(runtime.getSnapshot()).includes('private-native-path-and-key'), false);
  }
});

test('a failed engine startup cleans every resource and cannot retain an unusable runtime', async t => {
  const { runtime, effects, log } = fixture(t);
  effects['engine.start'] = async () => { throw new Error('Routing store migration failed'); };
  await runtime.start();
  assert.equal(runtime.getSnapshot().status, 'error'); assert.equal(runtime.getSnapshot().issue, 'startup-failed');
  assert.equal(runtime.getSnapshot().resources, null);
  assert.ok(log.includes('chat.stop')); assert.ok(log.includes('locations.stop')); assert.ok(log.includes('node.stop'));
  assert.equal(log.at(-1), 'release');
  assert.equal(log.includes('mesh.start'), false);
});

test('a failed feature startup waits for its still-starting sibling before stopping features or releasing storage', { timeout: 5_000 }, async t => {
  const release = deferred();
  t.after(() => release.resolve());
  const { runtime, effects, log } = fixture(t);
  effects['chat.start'] = async () => { throw new Error('Chat archive migration failed'); };
  effects['locations.start'] = () => release.promise;
  const starting = runtime.start();
  await until(() => log.includes('chat.start') && log.includes('locations.start'));
  await settle();
  assert.equal(log.includes('chat.stop'), false);
  assert.equal(log.includes('release'), false, 'a still-starting location service may still use its database');
  release.resolve(); await starting;
  assert.equal(runtime.getSnapshot().status, 'error');
  assert.ok(log.includes('chat.stop')); assert.ok(log.includes('locations.stop')); assert.ok(log.includes('node.stop'));
  assert.equal(log.at(-1), 'release');
});

test('a radio startup failure leaves local features and SOS usable and can recover after an explicit retry', async t => {
  const { runtime, effects, log } = fixture(t);
  effects['mesh.start'] = async () => { throw new Error('Bluetooth is powered off'); };
  await runtime.start();
  await until(() => runtime.getSnapshot().issue === 'radio-error');
  assert.equal(runtime.getSnapshot().status, 'ready');
  assert.equal(log.includes('chat.stop'), false); assert.equal(log.includes('locations.stop'), false);
  assert.equal((await runtime.sendSos()).status, 'queued');
  delete effects['mesh.start'];
  await runtime.requestPermissions();
  assert.ok(log.includes('mesh.refresh'));
  assert.equal(runtime.getSnapshot().issue, null);
});

test('a delayed startup permission check cannot overwrite the newer report from an explicit permission request', { timeout: 5_000 }, async t => {
  const release = deferred<RadioPermissionReport>();
  t.after(() => release.resolve(denied));
  const { runtime, permissions } = fixture(t);
  permissions.setCheck(() => release.promise);
  await runtime.start();
  await runtime.requestPermissions();
  assert.deepEqual(runtime.getSnapshot().permissions, granted);
  release.resolve(denied); await settle();
  assert.deepEqual(runtime.getSnapshot().permissions, granted, 'an earlier read-only check must not replace the later authorization result');
});

test('stopping during resource creation releases the late resource without starting a stale engine or native radio', { timeout: 5_000 }, async t => {
  const release = deferred<RuntimeResources>(); const entered = deferred();
  t.after(() => release.resolve(controlled.resources));
  const controlled = controlledResources(); const permissions = controlledPermissions();
  const runtime = new AppRuntime({
    permissions: permissions.permissions,
    createResources: () => { entered.resolve(); return release.promise; },
  });
  t.after(() => runtime.stop());
  const starting = runtime.start(); await entered.promise;
  const stopping = runtime.stop();
  release.resolve(controlled.resources);
  await Promise.all([starting, stopping]);
  assert.equal(runtime.getSnapshot().status, 'idle'); assert.equal(runtime.getSnapshot().resources, null);
  assert.equal(controlled.log.includes('engine.start'), false); assert.equal(controlled.log.includes('mesh.start'), false);
  assert.equal(controlled.log.filter(entry => entry === 'release').length, 1);
});

test('a late permission result after stop cannot refresh radios or mutate a replacement runtime', { timeout: 5_000 }, async t => {
  const release = deferred<RadioPermissionReport>();
  t.after(() => release.resolve(granted));
  const first = controlledResources(); const second = controlledResources(); const permissions = controlledPermissions();
  permissions.setRequest(() => release.promise);
  let creates = 0;
  const runtime = new AppRuntime({ createResources: async () => (++creates === 1 ? first.resources : second.resources), permissions: permissions.permissions });
  t.after(() => runtime.stop());
  await runtime.start();
  const requesting = runtime.requestPermissions();
  assert.equal(permissions.requests(), 1);
  await runtime.stop(); await runtime.start(); await settle();
  const snapshot = runtime.getSnapshot();
  const refreshes = second.log.filter(entry => entry === 'mesh.refresh').length;
  release.resolve(granted); await requesting; await settle();
  assert.equal(runtime.getSnapshot(), snapshot);
  assert.equal(second.log.filter(entry => entry === 'mesh.refresh').length, refreshes);
});

test('platform startup reads battery and alert permission without prompting or enabling background execution', async t => {
  const platform = controlledPlatform();
  const { runtime, permissions } = fixture(t, true, platform.platformRuntime);
  await runtime.start(); await settle();
  assert.equal(platform.calls.checks, 1);
  assert.equal(platform.calls.batteryReads, 1);
  assert.equal(platform.calls.requests, 0);
  assert.equal(platform.calls.starts, 0);
  assert.equal(permissions.requests(), 0);
  assert.equal(runtime.getSnapshot().backgroundSupported, true);
  assert.equal(runtime.getSnapshot().backgroundEnabled, false);
  assert.equal(runtime.getSnapshot().alertsEnabled, false);
  assert.deepEqual(runtime.getSnapshot().battery, { level: 0.7, charging: false, lowPower: false });
  runtime.setForeground(false); runtime.setForeground(true); await settle();
  assert.equal(platform.calls.requests, 0, 'resuming must never open a notification permission prompt');
});

test('automatic low battery and OS power saving reach routing and GPS while SOS remains available', async t => {
  const platform = controlledPlatform();
  platform.setBatteryRead(async () => ({ level: 0.2, charging: false, lowPower: false }));
  const { runtime, power, state } = fixture(t, true, platform.platformRuntime);
  await runtime.start(); await settle();
  assert.equal(runtime.getSnapshot().automaticPowerMode, true);
  assert.deepEqual(power, { engine: 'conserve', locations: 'conserve' });
  assert.equal((await runtime.sendSos()).status, 'queued');
  assert.equal(state.sosCalls, 1);
  platform.emit({ type: 'battery', battery: { level: 0.1, charging: true, lowPower: false } });
  assert.deepEqual(power, { engine: 'normal', locations: 'normal' });
  platform.emit({ type: 'battery', battery: { level: 0.9, charging: true, lowPower: true } });
  assert.deepEqual(power, { engine: 'conserve', locations: 'conserve' });
  runtime.setPowerMode('normal');
  assert.equal(runtime.getSnapshot().automaticPowerMode, false);
  platform.emit({ type: 'battery', battery: { level: 0.05, charging: false, lowPower: true } });
  assert.deepEqual(power, { engine: 'normal', locations: 'normal' }, 'manual override must survive later battery events');
  runtime.setAutomaticPowerMode(true);
  assert.deepEqual(power, { engine: 'conserve', locations: 'conserve' });
  runtime.setAutomaticPowerMode(false);
  assert.deepEqual(power, { engine: 'normal', locations: 'normal' }, 'leaving automatic mode restores the manual choice');
});

test('denied notification permission never starts a background service or blocks local SOS', async t => {
  const platform = controlledPlatform();
  platform.setNotificationRequest(async () => false);
  const { runtime } = fixture(t, true, platform.platformRuntime);
  await runtime.start(); await settle();
  await runtime.setBackgroundEnabled(true);
  assert.equal(platform.calls.requests, 1);
  assert.equal(platform.calls.starts, 0);
  assert.equal(runtime.getSnapshot().backgroundEnabled, false);
  assert.equal(runtime.getSnapshot().backgroundBusy, false);
  assert.equal(runtime.getSnapshot().issue, 'background-unavailable');
  assert.equal((await runtime.sendSos()).status, 'queued');
});

test('explicit background opt-in keeps radios active with hidden UI until the user disables it', async t => {
  const platform = controlledPlatform();
  const { runtime, state, log } = fixture(t, true, platform.platformRuntime);
  await runtime.start(); await settle();
  await runtime.setBackgroundEnabled(true);
  assert.equal(platform.calls.requests, 1);
  assert.equal(platform.calls.starts, 1);
  assert.equal(runtime.getSnapshot().backgroundEnabled, true);
  assert.equal(runtime.getSnapshot().alertsEnabled, true);
  const previousStops = log.filter(entry => entry === 'mesh.stop').length;
  runtime.setForeground(false); await settle();
  assert.equal(state.discovery, true);
  assert.equal(state.chatVisible, false); assert.equal(state.locationsVisible, false);
  assert.equal(log.filter(entry => entry === 'mesh.stop').length, previousStops);
  await runtime.setBackgroundEnabled(false);
  await until(() => !state.discovery, 'discovery paused after background opt-out');
  assert.equal(platform.calls.stops, 1);
  assert.equal(runtime.getSnapshot().backgroundEnabled, false);
  assert.equal(runtime.getSnapshot().backgroundBusy, false);
});

test('stopping from the native notification pauses hidden mesh without restarting the service', async t => {
  const platform = controlledPlatform();
  const { runtime, state, log } = fixture(t, true, platform.platformRuntime);
  await runtime.start(); await settle();
  await runtime.setBackgroundEnabled(true);
  runtime.setForeground(false); await settle();
  assert.equal(state.discovery, true);
  platform.emit({ type: 'background', running: false, reason: 'user-stopped' });
  await until(() => !state.discovery, 'native notification stop pauses hidden radios');
  assert.equal(runtime.getSnapshot().backgroundEnabled, false);
  assert.equal(platform.calls.starts, 1);
  assert.equal(log.includes('chat.stop'), false);
  assert.equal(log.includes('locations.stop'), false);
});

test('cancelling background opt-in while its OS permission dialog is pending prevents a stale service start', { timeout: 5_000 }, async t => {
  const permission = deferred<boolean>();
  t.after(() => permission.resolve(true));
  const platform = controlledPlatform();
  platform.setNotificationRequest(() => permission.promise);
  const { runtime } = fixture(t, true, platform.platformRuntime);
  await runtime.start(); await settle();
  const enabling = runtime.setBackgroundEnabled(true);
  await until(() => platform.calls.requests === 1);
  assert.equal(runtime.getSnapshot().backgroundBusy, true);
  const cancelling = runtime.setBackgroundEnabled(false);
  permission.resolve(true);
  await Promise.all([enabling, cancelling]);
  assert.equal(platform.calls.starts, 0);
  assert.equal(platform.calls.stops, 1);
  assert.equal(runtime.getSnapshot().backgroundEnabled, false);
  assert.equal(runtime.getSnapshot().backgroundBusy, false);
});

test('runtime shutdown closes resources before an unanswered notification dialog resolves', { timeout: 5_000 }, async t => {
  const permission = deferred<boolean>();
  t.after(() => permission.resolve(true));
  const platform = controlledPlatform();
  platform.setNotificationRequest(() => permission.promise);
  const { runtime, log } = fixture(t, true, platform.platformRuntime);
  await runtime.start(); await settle();
  const enabling = runtime.setBackgroundEnabled(true);
  await until(() => platform.calls.requests === 1);
  const stopping = runtime.stop();
  await until(() => log.includes('release'), 'storage cleanup cannot wait for an unanswerable OS permission dialog');
  await stopping;
  assert.equal(platform.calls.starts, 0);
  assert.equal(platform.calls.stops, 1);
  const stopped = runtime.getSnapshot();
  permission.resolve(true); await enabling; await settle();
  assert.equal(platform.calls.starts, 0);
  assert.equal(runtime.getSnapshot(), stopped, 'a permission result from a stopped runtime must be ignored');
});

test('stopping during native service startup unwinds a late start without resurrecting resources', { timeout: 5_000 }, async t => {
  const start = deferred();
  t.after(() => start.resolve());
  const platform = controlledPlatform();
  platform.setStart(() => start.promise);
  const { runtime, log } = fixture(t, true, platform.platformRuntime);
  await runtime.start(); await settle();
  const enabling = runtime.setBackgroundEnabled(true);
  await until(() => platform.calls.starts === 1);
  await runtime.stop();
  assert.equal(log.includes('release'), true);
  assert.equal(runtime.getSnapshot().backgroundEnabled, false);
  start.resolve(); await enabling; await settle();
  assert.ok(platform.calls.stops >= 2, 'a late native start must be followed by a compensating stop');
  assert.equal(runtime.getSnapshot().status, 'idle');
  assert.equal(runtime.getSnapshot().resources, null);
});

test('unsupported iOS background execution still permits explicit, single-flight alert authorization', { timeout: 5_000 }, async t => {
  const permission = deferred<boolean>();
  t.after(() => permission.resolve(true));
  const platform = controlledPlatform(false);
  platform.setNotificationRequest(() => permission.promise);
  const { runtime } = fixture(t, true, platform.platformRuntime);
  await runtime.start(); await settle();
  assert.equal(runtime.getSnapshot().backgroundSupported, false);
  await runtime.setBackgroundEnabled(true);
  assert.equal(platform.calls.requests, 0);
  assert.equal(platform.calls.starts, 0);
  const first = runtime.requestAlerts(); const repeated = runtime.requestAlerts();
  assert.equal(platform.calls.requests, 1);
  assert.equal(runtime.getSnapshot().alertsBusy, true);
  permission.resolve(true); await Promise.all([first, repeated]);
  assert.equal(runtime.getSnapshot().alertsEnabled, true);
  assert.equal(runtime.getSnapshot().alertsBusy, false);
  assert.equal(runtime.getSnapshot().backgroundEnabled, false);
  runtime.setForeground(false); await runtime.requestAlerts();
  assert.equal(platform.calls.requests, 1, 'a hidden iOS app must not open a permission prompt');
});

test('explicit alert denial is reported without disabling messaging or SOS', async t => {
  const platform = controlledPlatform(false);
  platform.setNotificationRequest(async () => false);
  const { runtime } = fixture(t, true, platform.platformRuntime);
  await runtime.start(); await settle();
  await runtime.requestAlerts();
  assert.equal(runtime.getSnapshot().alertsEnabled, false);
  assert.equal(runtime.getSnapshot().alertsBusy, false);
  assert.equal(runtime.getSnapshot().issue, 'alerts-unavailable');
  assert.equal(runtime.getSnapshot().status, 'ready');
  assert.equal((await runtime.sendSos()).status, 'queued');
});

test('shutdown stops native execution, detaches events, and ignores delayed battery and alert checks', { timeout: 5_000 }, async t => {
  const battery = deferred<BatteryState>(); const checked = deferred<boolean>();
  t.after(() => { battery.resolve({ level: 0.01, charging: false, lowPower: true }); checked.resolve(true); });
  const platform = controlledPlatform();
  platform.setBatteryRead(() => battery.promise);
  platform.setNotificationCheck(() => checked.promise);
  const { runtime, power } = fixture(t, true, platform.platformRuntime);
  await runtime.start(); await settle();
  const stale = platform.subscriptions[0]!;
  await runtime.stop();
  assert.equal(platform.calls.stops, 1);
  assert.equal(platform.listeners.size, 0);
  assert.equal(platform.calls.unsubscribes, 1);
  const stopped = runtime.getSnapshot();
  stale({ type: 'battery', battery: { level: 0.01, charging: false, lowPower: true } });
  stale({ type: 'background', running: false, reason: 'user-stopped' });
  battery.resolve({ level: 0.01, charging: false, lowPower: true }); checked.resolve(true);
  await settle();
  assert.equal(runtime.getSnapshot(), stopped);
  assert.deepEqual(power, { engine: 'normal', locations: 'normal' });
});

test('a delayed startup alert check cannot overwrite a newer explicit authorization result', { timeout: 5_000 }, async t => {
  const checked = deferred<boolean>();
  t.after(() => checked.resolve(false));
  const platform = controlledPlatform();
  platform.setNotificationCheck(() => checked.promise);
  const { runtime } = fixture(t, true, platform.platformRuntime);
  await runtime.start(); await settle();
  await runtime.requestAlerts();
  assert.equal(runtime.getSnapshot().alertsEnabled, true);
  checked.resolve(false); await settle();
  assert.equal(runtime.getSnapshot().alertsEnabled, true, 'an earlier passive check cannot undo the permission granted by the user');
});

test('a delayed alert check cannot overwrite permission granted while enabling background mesh', { timeout: 5_000 }, async t => {
  const checked = deferred<boolean>();
  t.after(() => checked.resolve(false));
  const platform = controlledPlatform();
  platform.setNotificationCheck(() => checked.promise);
  const { runtime } = fixture(t, true, platform.platformRuntime);
  await runtime.start(); await settle();
  await runtime.setBackgroundEnabled(true);
  assert.equal(runtime.getSnapshot().backgroundEnabled, true);
  assert.equal(runtime.getSnapshot().alertsEnabled, true);
  checked.resolve(false); await settle();
  assert.equal(runtime.getSnapshot().alertsEnabled, true);
  assert.equal(runtime.getSnapshot().backgroundEnabled, true);
});

test('battery read failures and native service start failures preserve offline features and SOS', async t => {
  const platform = controlledPlatform();
  platform.setBatteryRead(async () => { throw new Error('Battery reading unavailable'); });
  platform.setStart(async () => { throw new Error('OS declined the foreground service'); });
  const { runtime, power } = fixture(t, true, platform.platformRuntime);
  await runtime.start(); await settle();
  assert.equal(runtime.getSnapshot().status, 'ready');
  assert.equal(runtime.getSnapshot().battery, null);
  assert.deepEqual(power, { engine: 'normal', locations: 'normal' });
  await runtime.setBackgroundEnabled(true);
  assert.equal(runtime.getSnapshot().backgroundEnabled, false);
  assert.equal(runtime.getSnapshot().backgroundBusy, false);
  assert.equal(runtime.getSnapshot().issue, 'background-unavailable');
  assert.equal((await runtime.sendSos()).status, 'queued');
});

test('a delayed startup battery read cannot replace a newer native power-saving event', { timeout: 5_000 }, async t => {
  const reading = deferred<BatteryState>();
  t.after(() => reading.resolve({ level: 0.9, charging: false, lowPower: false }));
  const platform = controlledPlatform();
  platform.setBatteryRead(() => reading.promise);
  const { runtime, power } = fixture(t, true, platform.platformRuntime);
  await runtime.start(); await settle();
  const latest = { level: 0.1, charging: false, lowPower: true };
  platform.emit({ type: 'battery', battery: latest });
  assert.deepEqual(runtime.getSnapshot().battery, latest);
  assert.deepEqual(power, { engine: 'conserve', locations: 'conserve' });
  reading.resolve({ level: 0.9, charging: false, lowPower: false }); await settle();
  assert.deepEqual(runtime.getSnapshot().battery, latest, 'a startup read predating the OS event must be ignored');
  assert.deepEqual(power, { engine: 'conserve', locations: 'conserve' });
  assert.equal((await runtime.sendSos()).status, 'queued');
});

test('the native notification stop overrides an in-flight background service start', { timeout: 5_000 }, async t => {
  const started = deferred();
  t.after(() => started.resolve());
  const platform = controlledPlatform();
  platform.setStart(() => started.promise);
  const { runtime } = fixture(t, true, platform.platformRuntime);
  await runtime.start(); await settle();
  const enabling = runtime.setBackgroundEnabled(true);
  await until(() => platform.calls.starts === 1);
  // The notification action can reach JavaScript before the native start
  // promise is delivered. The user's stop remains the latest session intent.
  platform.emit({ type: 'background', running: false, reason: 'user-stopped' });
  started.resolve(); await enabling; await settle();
  assert.equal(runtime.getSnapshot().backgroundEnabled, false);
  assert.equal(runtime.getSnapshot().backgroundBusy, false);
  assert.equal(platform.calls.stops, 1, 'a late service start must be followed by a compensating stop');
});
