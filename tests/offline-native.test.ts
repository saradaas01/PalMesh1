import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeOfflineMapSource, validateOfflineMapDescriptor } from '../src/features/maps/infrastructure/NativeOfflineMapSource';
import type { NativeOfflineMapsBridge } from '../src/features/maps/infrastructure/NativeOfflineMapSource';

const descriptor = {
  tileUrlTemplate: `http://127.0.0.1:23001/${'a'.repeat(32)}/{z}/{x}/{y}.pbf`,
  bounds: [34.1, 31.1, 35.7, 32.8], minZoom: 0, maxZoom: 14,
  sourceLayers: ['water', 'transportation'], attribution: '© OpenStreetMap contributors',
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

test('offline native descriptor accepts only immutable bounded loopback vector metadata', () => {
  const result = validateOfflineMapDescriptor(descriptor);
  assert.deepEqual(result, descriptor);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.bounds));
  assert.ok(Object.isFrozen(result.sourceLayers));
  const invalid: unknown[] = [null, {},
    { ...descriptor, tileUrlTemplate: 'https://example.com/{z}/{x}/{y}.pbf' },
    { ...descriptor, tileUrlTemplate: descriptor.tileUrlTemplate.replace('127.0.0.1', 'localhost') },
    { ...descriptor, tileUrlTemplate: descriptor.tileUrlTemplate.replace('23001', '65536') },
    { ...descriptor, tileUrlTemplate: `${descriptor.tileUrlTemplate}?remote=https://example.com` },
    { ...descriptor, bounds: [34, NaN, 35, 32] },
    { ...descriptor, bounds: [36, 31, 35, 32] },
    { ...descriptor, minZoom: 4, maxZoom: 3 },
    { ...descriptor, maxZoom: 23 },
    { ...descriptor, minZoom: 0.5 },
    { ...descriptor, sourceLayers: [] },
    { ...descriptor, sourceLayers: ['water', 'water'] },
    { ...descriptor, sourceLayers: ['https://tiles'] },
    { ...descriptor, attribution: '<a href="http://remote">Maps</a>' },
  ];
  for (const value of invalid) assert.throws(() => validateOfflineMapDescriptor(value));
});

test('offline native source fails cleanly without a bridge or with invalid asset/checksum config', async () => {
  await assert.rejects(new NativeOfflineMapSource(undefined).open(new AbortController().signal), /unavailable/);
  assert.throws(() => new NativeOfflineMapSource(undefined, { assetName: '../palestine.mbtiles' }));
  assert.throws(() => new NativeOfflineMapSource(undefined, { expectedSha256: 'not-a-digest' }));
  let calls = 0;
  const source = new NativeOfflineMapSource({ open: async () => { calls++; return descriptor; }, close: async () => undefined });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(source.open(controller.signal), { name: 'AbortError' });
  assert.equal(calls, 0);
});

test('offline native source passes asset checksum explicitly and closes owned session', async () => {
  const calls: unknown[] = [];
  const bridge: NativeOfflineMapsBridge = {
    open: async options => { calls.push(options); return descriptor; },
    close: async () => { calls.push('close'); },
  };
  const source = new NativeOfflineMapSource(bridge, { expectedSha256: 'B'.repeat(64) });
  assert.deepEqual(await source.open(new AbortController().signal), descriptor);
  assert.deepEqual(calls, [{ assetName: 'palmesh/palestine.mbtiles', expectedSha256: 'b'.repeat(64) }]);
  await source.close();
  assert.ok((calls as unknown[]).includes('close'));
});

test('aborted native open settles promptly and late completion is cleaned before restart', async () => {
  const late = deferred<unknown>();
  const events: string[] = [];
  let opens = 0;
  const source = new NativeOfflineMapSource({
    open: async () => { events.push(`open:${++opens}`); return opens === 1 ? late.promise : descriptor; },
    close: async () => { events.push('close'); },
  });
  const firstController = new AbortController();
  const first = source.open(firstController.signal);
  await turn();
  firstController.abort();
  await assert.rejects(first, { name: 'AbortError' });
  const second = source.open(new AbortController().signal);
  await turn();
  assert.equal(opens, 1, 'a new session must wait for late native completion and cleanup');
  late.resolve(descriptor);
  await second;
  assert.deepEqual(events, ['open:1', 'close', 'close', 'open:2']);
  await source.close();
});

test('new open supersedes queued attempts without closing the new owner', async () => {
  const late = deferred<unknown>();
  let opens = 0;
  let closes = 0;
  const source = new NativeOfflineMapSource({
    open: async () => ++opens === 1 ? late.promise : descriptor,
    close: async () => { closes++; },
  });
  const first = source.open(new AbortController().signal);
  await turn();
  const rejectedFirst = assert.rejects(first, { name: 'AbortError' });
  const second = source.open(new AbortController().signal);
  const rejectedSecond = assert.rejects(second, { name: 'AbortError' });
  const thirdController = new AbortController();
  const third = source.open(thirdController.signal);
  late.resolve(descriptor);
  await Promise.all([rejectedFirst, rejectedSecond, third]);
  assert.equal(opens, 2);
  const before = closes;
  await turn();
  assert.equal(closes, before, 'late cleanup must finish before third session starts');
  await source.close();
});

test('invalid native descriptor is rejected and native host is closed before retry', async () => {
  const events: string[] = [];
  const source = new NativeOfflineMapSource({
    open: async () => { events.push('open'); return events.length === 1 ? {} : descriptor; },
    close: async () => { events.push('close'); },
  });
  await assert.rejects(source.open(new AbortController().signal), /Invalid loopback/);
  await source.open(new AbortController().signal);
  assert.ok(events.indexOf('close') < events.lastIndexOf('open'));
  await source.close();
});

test('close cancels an opening session immediately and waits for late cleanup', async () => {
  const late = deferred<unknown>();
  let closes = 0;
  const source = new NativeOfflineMapSource({ open: async () => late.promise, close: async () => { closes++; } });
  const opening = source.open(new AbortController().signal);
  await turn();
  const closed = source.close();
  await assert.rejects(opening, { name: 'AbortError' });
  let completed = false;
  void closed.then(() => { completed = true; });
  await turn();
  assert.equal(completed, false);
  late.reject(new Error('cancelled in native'));
  await closed;
  assert.equal(closes, 2);
});

test('native close failures are reported while a later open can recover ownership', async () => {
  let fail = true;
  const source = new NativeOfflineMapSource({
    open: async () => descriptor,
    close: async () => { if (fail) throw new Error('close failed'); },
  });
  await source.open(new AbortController().signal);
  await assert.rejects(source.close(), /close failed/);
  fail = false;
  await source.open(new AbortController().signal);
  await source.close();
});
