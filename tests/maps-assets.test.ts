import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

test('all bundled map glyph pages retain their reviewed hashes on Android and iOS', () => {
  const root = resolve(import.meta.dirname, '..');
  const manifest = JSON.parse(readFileSync(resolve(root, 'assets/map-fonts/manifest.json'), 'utf8')) as {
    rangeCount: number; ranges: Record<string, string>;
  };
  assert.equal(manifest.rangeCount, 256);
  assert.equal(Object.keys(manifest.ranges).length, 256);
  for (const [relative, digest] of Object.entries(manifest.ranges)) {
    for (const directory of ['assets/map-fonts', 'android/app/src/main/assets/palmesh/fonts', 'ios/PalMesh/palmesh/fonts']) {
      assert.equal(createHash('sha256').update(readFileSync(resolve(root, directory, relative))).digest('hex'), digest, relative);
    }
  }
  for (const start of [0, 1536, 1792, 64256, 64512, 64768, 65024]) {
    const file = `Klokantech Noto Sans Regular/${start}-${start + 255}.pbf`;
    assert.ok(readFileSync(resolve(root, 'assets/map-fonts', file)).length > 1000, 'Latin/Arabic and shaping glyph pages contain actual glyphs');
  }
});

test('map pack validation rejects corrupt, unsafe and falsely advertised artifacts', () => {
  const result = spawnSync('python3', ['-m', 'unittest', 'discover', '-s', 'scripts/maps/tests'], {
    cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8', timeout: 20_000,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
