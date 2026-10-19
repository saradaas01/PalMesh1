import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { FrameQueueFullError, FrameWriter, type FrameWriterOptions } from '../src/features/mesh/application/FrameWriter';
import { abortError, runBounded } from '../src/features/mesh/application/async';
import type { RadioAdapter } from '../src/features/mesh/domain/ports';
import type { WireFrame } from '../src/features/mesh/domain/types';
import { FrameDecoder } from '../src/features/mesh/domain/wire';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function hello(index: number): WireFrame {
  return { v: 1, type: 'hello', peerId: 'peer', nonce: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}` };
}

function fixture(overrides: Partial<FrameWriterOptions> = {},
  write: (bytes: Uint8Array, signal: AbortSignal) => Promise<void> = async () => undefined): {
    writer: FrameWriter; controller: AbortController; chunks: Uint8Array[]; failures: unknown[]; signals: AbortSignal[];
  } {
  const controller = new AbortController();
  const chunks: Uint8Array[] = [];
  const failures: unknown[] = [];
  const signals: AbortSignal[] = [];
  const radio: RadioAdapter = {
    kind: 'ble', getStatus: async () => ({ available: true }), subscribe: () => () => undefined,
    start: async () => undefined, stop: async () => undefined,
    connect: async endpointId => ({ id: 'link', endpointId, maxChunkBytes: 20 }), disconnect: async () => undefined,
    write: async (_link, bytes, signal) => {
      chunks.push(bytes.slice());
      signals.push(signal);
      await write(bytes, signal);
    },
  };
  const writer = new FrameWriter({ radio, link: { id: 'link', endpointId: 'endpoint', maxChunkBytes: 20 },
    signal: controller.signal, writeTimeoutMs: 1000, maxFrameBytes: 20 * 1024,
    maxQueuedFrames: 8, reservedControlFrames: 2, onFailure: error => failures.push(error), ...overrides });
  return { writer, controller, chunks, failures, signals };
}

function decodedNonces(chunks: readonly Uint8Array[]): string[] {
  const decoder = new FrameDecoder();
  return chunks.flatMap(chunk => decoder.push(chunk)).map(frame => {
    assert.equal(frame.type, 'hello');
    return frame.type === 'hello' ? frame.nonce : '';
  });
}

test('frame writer serializes whole frames and prioritizes controls after the active frame', async () => {
  const firstWrite = deferred<void>();
  let activeWrites = 0;
  let maxActiveWrites = 0;
  let writes = 0;
  const { writer, chunks, failures } = fixture({}, async () => {
    activeWrites += 1;
    maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
    if (writes++ === 0) await firstWrite.promise;
    activeWrites -= 1;
  });
  const first = writer.send(hello(1), false);
  const second = writer.send(hello(2), false);
  const control = writer.send(hello(3), true);
  await nextTurn();
  assert.equal(chunks.length, 1);
  firstWrite.resolve();
  await Promise.all([first, second, control]);
  assert.equal(maxActiveWrites, 1);
  assert.ok(chunks.every(chunk => chunk.length <= 20));
  assert.deepEqual(decodedNonces(chunks), [hello(1), hello(3), hello(2)].map(frame => frame.type === 'hello' ? frame.nonce : ''));
  assert.deepEqual(failures, []);
  writer.close();
});

test('frame completion waits for native write completion and immediately frees capacity', async () => {
  const nativeWrite = deferred<void>();
  const { writer } = fixture({ link: { id: 'link', endpointId: 'endpoint', maxChunkBytes: 8192 },
    maxQueuedFrames: 1, reservedControlFrames: 0 }, () => nativeWrite.promise);
  let completed = false;
  const first = writer.send(hello(1), false).then(() => { completed = true; });
  await nextTurn();
  assert.equal(completed, false);
  nativeWrite.resolve();
  await first;
  await writer.send(hello(2), false);
  writer.close();
});

test('canceling a queued frame removes only that frame and keeps the stream usable', async () => {
  const firstWrite = deferred<void>();
  let count = 0;
  const { writer, chunks, failures } = fixture({}, async () => { if (count++ === 0) await firstWrite.promise; });
  const queued = new AbortController();
  const first = writer.send(hello(1), false);
  const canceled = writer.send(hello(2), false, queued.signal);
  const last = writer.send(hello(3), false);
  queued.abort();
  await assert.rejects(canceled, { name: 'AbortError' });
  assert.equal(getEventListeners(queued.signal, 'abort').length, 0);
  firstWrite.resolve();
  await Promise.all([first, last]);
  assert.deepEqual(decodedNonces(chunks), [hello(1), hello(3)].map(frame => frame.type === 'hello' ? frame.nonce : ''));
  assert.deepEqual(failures, []);
  writer.close();
});

test('frame queue reserves bounded capacity for control frames and recovers canceled slots', async () => {
  const firstWrite = deferred<void>();
  const { writer } = fixture({ maxQueuedFrames: 3, reservedControlFrames: 1 }, () => firstWrite.promise);
  const cancelQueued = new AbortController();
  const first = writer.send(hello(1), false);
  const second = writer.send(hello(2), false, cancelQueued.signal);
  await assert.rejects(writer.send(hello(3), false), FrameQueueFullError);
  const control = writer.send(hello(4), true);
  await assert.rejects(writer.send(hello(5), true), FrameQueueFullError);
  cancelQueued.abort();
  await assert.rejects(second, { name: 'AbortError' });
  const replacement = writer.send(hello(6), true);
  firstWrite.resolve();
  await Promise.all([first, control, replacement]);
  writer.close();
});

test('canceling an active frame invalidates the stream and aborts hung native writes', async () => {
  const nativeWrite = deferred<void>();
  const { writer, chunks, failures, signals } = fixture({}, () => nativeWrite.promise);
  const active = new AbortController();
  const first = writer.send(hello(1), false, active.signal);
  const queued = writer.send(hello(2), false);
  active.abort();
  await assert.rejects(first, { name: 'AbortError' });
  await assert.rejects(queued, { name: 'AbortError' });
  assert.equal(signals[0]?.aborted, true);
  assert.equal(failures.length, 1);
  await assert.rejects(writer.send(hello(3), true), { name: 'AbortError' });
  nativeWrite.resolve();
  await nextTurn();
  assert.equal(chunks.length, 1);
  assert.equal(getEventListeners(active.signal, 'abort').length, 0);
});

test('hanging native writes time out, report one failure, and reject every waiting frame', async () => {
  const nativeWrite = deferred<void>();
  const { writer, failures, signals } = fixture({ writeTimeoutMs: 10 }, () => nativeWrite.promise);
  const first = writer.send(hello(1), false);
  const second = writer.send(hello(2), true);
  await assert.rejects(first, { name: 'TimeoutError' });
  await assert.rejects(second, { name: 'TimeoutError' });
  assert.equal(signals[0]?.aborted, true);
  assert.equal(failures.length, 1);
  nativeWrite.reject(new Error('late native failure'));
  await nextTurn();
  assert.equal(failures.length, 1);
});

test('native write errors preserve the original reason and invalidate queued work', async () => {
  const original = new Error('native socket failed');
  const nativeWrite = deferred<void>();
  const { writer, chunks, failures } = fixture({}, () => nativeWrite.promise);
  const first = writer.send(hello(1), false);
  const second = writer.send(hello(2), true);
  nativeWrite.reject(original);
  await assert.rejects(first, error => error === original);
  await assert.rejects(second, error => error === original);
  await assert.rejects(writer.send(hello(3), true), error => error === original);
  assert.equal(chunks.length, 1);
  assert.deepEqual(failures, [original]);
});

test('the write timeout covers the whole frame rather than restarting for every chunk', async () => {
  const { writer, chunks, failures } = fixture({ writeTimeoutMs: 20 }, async () => { await delay(9); });
  await assert.rejects(writer.send(hello(1), false), { name: 'TimeoutError' });
  const countAtTimeout = chunks.length;
  assert.ok(countAtTimeout < 6);
  await delay(15);
  assert.equal(chunks.length, countAtTimeout);
  assert.equal(failures.length, 1);
});

test('explicit close rejects active and queued frames, removes listeners, and does not report another failure', async () => {
  const nativeWrite = deferred<void>();
  const { writer, controller, failures, signals } = fixture({}, () => nativeWrite.promise);
  const child = new AbortController();
  const first = writer.send(hello(1), false, child.signal);
  const second = writer.send(hello(2), true);
  const reason = new Error('link closed');
  writer.close(reason);
  writer.close(new Error('second close'));
  await assert.rejects(first, error => error === reason);
  await assert.rejects(second, error => error === reason);
  assert.equal(signals[0]?.aborted, true);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(getEventListeners(child.signal, 'abort').length, 0);
  assert.deepEqual(failures, []);
  nativeWrite.resolve();
});

test('parent cancellation cleans up writer work and prevents later sends', async () => {
  const nativeWrite = deferred<void>();
  const { writer, controller, failures } = fixture({}, () => nativeWrite.promise);
  const sent = writer.send(hello(1), false);
  controller.abort();
  await assert.rejects(sent, { name: 'AbortError' });
  await assert.rejects(writer.send(hello(2), true), { name: 'AbortError' });
  assert.equal(failures.length, 1);
  nativeWrite.resolve();
});

test('frame encoding errors reject without throwing synchronously or poisoning a usable writer', async () => {
  const { writer, failures } = fixture();
  const invalid = { ...hello(1), nonce: 'invalid' } as WireFrame;
  let rejected!: Promise<void>;
  assert.doesNotThrow(() => { rejected = writer.send(invalid, false); });
  await assert.rejects(rejected, /UUID/);
  await writer.send(hello(2), false);
  assert.deepEqual(failures, []);
  writer.close();
});

test('runBounded handles successful work, preserves original failures, and removes parent listeners', async () => {
  const parent = new AbortController();
  const other = new AbortController();
  assert.equal(await runBounded(async () => 42, [parent.signal, other.signal, parent.signal], 100), 42);
  assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
  assert.equal(getEventListeners(other.signal, 'abort').length, 0);
  const original = new Error('native bridge failed');
  let operationSignal!: AbortSignal;
  await assert.rejects(runBounded(async signal => { operationSignal = signal; throw original; }, [parent.signal], 100), error => error === original);
  assert.equal(operationSignal.aborted, true);
  assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
  await assert.rejects(runBounded(() => { throw original; }, [], 100), error => error === original);
  assert.equal(abortError().name, 'AbortError');
});

test('runBounded cancels a hung operation on any parent and observes late rejections', async () => {
  const parent = new AbortController();
  const other = new AbortController();
  const hung = deferred<void>();
  let operationSignal!: AbortSignal;
  const running = runBounded(signal => { operationSignal = signal; return hung.promise; }, [parent.signal, other.signal], 100);
  other.abort();
  await assert.rejects(running, { name: 'AbortError' });
  assert.equal(operationSignal.aborted, true);
  assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
  assert.equal(getEventListeners(other.signal, 'abort').length, 0);
  hung.reject(new Error('late native rejection'));
  await nextTurn();
  let called = false;
  await assert.rejects(runBounded(async () => { called = true; }, [other.signal], 100), { name: 'AbortError' });
  assert.equal(called, false);
});

test('runBounded deadlines abort hung operations and release listeners', async () => {
  const parent = new AbortController();
  let operationSignal!: AbortSignal;
  await assert.rejects(runBounded(signal => {
    operationSignal = signal;
    return new Promise<void>(() => undefined);
  }, [parent.signal], 10), { name: 'TimeoutError' });
  assert.equal(operationSignal.aborted, true);
  assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
  await assert.rejects(runBounded(async () => undefined, [], 0), /timeoutMs/);
});
