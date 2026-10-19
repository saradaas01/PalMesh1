import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { gzipSync } from 'node:zlib';

const compiler = process.env.CC || 'cc';
const compilerAvailable = spawnSync(compiler, ['--version'], { encoding: 'utf8' }).status === 0;

/** Compile the production C header, not a JavaScript copy of its behavior.
 * Apple frameworks and the Objective-C socket/SQLite host still require Xcode. */
describe('iOS production vector tile parser', { skip: !compilerAvailable && 'C compiler unavailable' }, () => {
  let directory: string;
  let executable: string;
  before(() => {
    directory = mkdtempSync(join(tmpdir(), 'palmesh-ios-tiles-'));
    executable = join(directory, 'tile-parser');
    const source = join(directory, 'main.c');
    writeFileSync(source, `#include <stdio.h>
#include "PMVectorTileValidation.h"
int main(void) {
  uint8_t *bytes = malloc(PM_TILE_MAX_STORED_BYTES + 1);
  if (!bytes) return 2;
  size_t count = fread(bytes, 1, PM_TILE_MAX_STORED_BYTES + 1, stdin);
  if (ferror(stdin)) { free(bytes); return 3; }
  bool valid = PMTileValidateStored(bytes, count);
  free(bytes);
  puts(valid ? "valid" : "invalid");
  return 0;
}
`);
    const result = spawnSync(compiler, ['-std=c11', '-Wall', '-Wextra', '-Werror', '-pedantic',
      '-I', resolve('native/palmesh-offline-maps/ios'), source, '-lz', '-o', executable], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  });
  after(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

  const layer = Buffer.from([26, 5, 10, 1, 97, 120, 2]);
  function check(input: Uint8Array, expected: boolean): void {
    const result = spawnSync(executable, [], { input, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), expected ? 'valid' : 'invalid');
  }
  test('accepts uncompressed MVT layer envelopes and legal unknown protobuf fields', () => {
    check(layer, true);
    check(Buffer.concat([Buffer.from([8, ...Array<number>(9).fill(255), 1]), layer]), true);
    check(Buffer.concat([Buffer.from([17, 0, 0, 0, 0, 0, 0, 0, 0]), layer]), true);
    check(Buffer.concat([Buffer.from([37, 0, 0, 0, 0]), layer]), true);
  });
  test('rejects empty tiles, empty layers, zero tags and unsupported wire types', () => {
    for (const bytes of [[], [26, 0], [0], [27], [28], [30], [31], [2, 0], [8, 0]]) check(Uint8Array.from(bytes), false);
  });
  test('rejects truncated lengths, fixed-width values and overflowing varints', () => {
    for (const bytes of [[26], [26, 5, 1], [17, 1], [37, 1],
      [26, ...Array<number>(9).fill(255), 1], [8, ...Array<number>(9).fill(255), 2],
      [8, ...Array<number>(10).fill(128), 0], [255, 255, 255, 255, 31, 0]]) {
      check(Uint8Array.from(bytes), false);
    }
  });
  test('accepts complete gzip data and rejects corrupt CRCs, truncation and trailing members', () => {
    const gzip = gzipSync(layer);
    check(gzip, true);
    check(gzip.subarray(0, gzip.length - 1), false);
    const corrupt = Buffer.from(gzip); corrupt[corrupt.length - 8] = corrupt[corrupt.length - 8]! ^ 1;
    check(corrupt, false);
    check(Buffer.concat([gzip, Buffer.from([0])]), false);
    check(Buffer.concat([gzip, gzip]), false);
    check(gzipSync(Buffer.from([26, 10, 1])), false);
  });
  test('bounds stored and decompressed tile bytes before parsing', () => {
    check(Buffer.alloc(1024 * 1024 + 1), false);
    // A valid length-delimited layer that compresses to a few KB must still be
    // rejected when its output exceeds the fixed 4 MiB decompression budget.
    const length = 5 * 1024 * 1024;
    const largeLayer = Buffer.concat([Buffer.from([26, 128, 128, 192, 2]), Buffer.alloc(length)]);
    check(gzipSync(largeLayer), false);
  });
});
