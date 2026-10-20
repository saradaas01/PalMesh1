import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOfflineStyle } from '../src/features/maps/domain/offlineStyle';
import type { OfflineMapDescriptor } from '../src/features/maps/domain/types';

const descriptor: OfflineMapDescriptor = {
  tileUrlTemplate: `http://127.0.0.1:4242/${'a'.repeat(32)}/{z}/{x}/{y}.pbf`,
  bounds: [34.1, 31.2, 35.6, 32.6], minZoom: 0, maxZoom: 14,
  sourceLayers: ['transportation', 'water', 'buildings'], attribution: '© OpenStreetMap contributors',
};

test('offline style contains only bundled vector geometry and a loopback tile source', () => {
  const style = buildOfflineStyle(descriptor);
  assert.equal(style.version, 8);
  assert.deepEqual(Object.values(style.sources).flatMap(source => source.tiles), [descriptor.tileUrlTemplate]);
  assert.deepEqual([...new Set(style.layers.flatMap(layer => 'source-layer' in layer ? [layer['source-layer']] : []))], descriptor.sourceLayers);
  const serialized = JSON.stringify(style);
  assert.equal(/https:\/\/|glyphs|sprite|terrain|raster-dem|mapbox:\/\//i.test(serialized), false);
  assert.equal(style.layers.some(layer => (layer.type as string) === 'symbol'), false, 'no unbundled font atlas is requested');
});

test('a custom pack schema remains renderable without assuming OpenMapTiles layer IDs', () => {
  const style = buildOfflineStyle({ ...descriptor, sourceLayers: ['custom_roads', 'custom_land'] });
  const referenced = style.layers.filter(layer => 'source-layer' in layer);
  assert.ok(referenced.some(layer => 'source-layer' in layer && layer['source-layer'] === 'custom_roads'));
  assert.ok(referenced.some(layer => 'source-layer' in layer && layer['source-layer'] === 'custom_land'));
  assert.equal(new Set(style.layers.map(layer => layer.id)).size, style.layers.length);
});

test('a remote fallback or injected external URL is rejected before style construction', () => {
  for (const url of ['https://tiles.example.org/{z}/{x}/{y}.pbf',
    'http://127.0.0.1.evil.example:4242/a/{z}/{x}/{y}.pbf',
    descriptor.tileUrlTemplate + '?fallback=https://tiles.example.org']) {
    assert.throws(() => buildOfflineStyle({ ...descriptor, tileUrlTemplate: url }), /loopback/);
  }
});

test('Arabic labels use bundled Noto fonts on the same token-protected host', () => {
  const glyphUrlTemplate = descriptor.tileUrlTemplate.replace('/{z}/{x}/{y}.pbf', '/fonts/{fontstack}/{range}.pbf');
  const style = buildOfflineStyle({ ...descriptor, sourceLayers: ['transportation_name', 'place', 'poi', 'building'], glyphUrlTemplate });
  assert.equal(style.glyphs, glyphUrlTemplate);
  const labels = style.layers.filter(layer => layer.type === 'symbol');
  assert.equal(labels.length, 3);
  for (const label of labels) {
    assert.deepEqual(label.layout['text-font'], ['Klokantech Noto Sans Regular']);
    assert.deepEqual(label.layout['text-field'][1], ['get', 'name:ar']);
  }
  assert.equal(/https:\/\/|mapbox:\/\/|sprite/.test(JSON.stringify(style)), false);
  assert.equal(style.layers.at(-1)?.type, 'symbol');
});

test('glyphs on another port, token or remote host are rejected', () => {
  const glyph = descriptor.tileUrlTemplate.replace('/{z}/{x}/{y}.pbf', '/fonts/{fontstack}/{range}.pbf');
  for (const glyphUrlTemplate of [glyph.replace(':4242', ':4243'), glyph.replace('a'.repeat(32), 'b'.repeat(32)), 'https://example.com/{fontstack}/{range}.pbf']) {
    assert.throws(() => buildOfflineStyle({ ...descriptor, glyphUrlTemplate }), /loopback glyph/);
  }
});
