import assert from 'node:assert/strict';
import test from 'node:test';
import { aqabaInitialCamera } from '../src/features/maps/domain/offlineMap';
import type { OfflineMapDescriptor } from '../src/features/maps/domain/types';

const map: OfflineMapDescriptor = {
  tileUrlTemplate: `http://127.0.0.1:23001/${'a'.repeat(32)}/{z}/{x}/{y}.pbf`,
  bounds: [34.85, 29.10, 39.35, 33.45], minZoom: 6, maxZoom: 14,
  sourceLayers: ['transportation', 'building', 'place'], attribution: '© OpenStreetMap contributors',
};

test('Aqaba is the initial viewport without creating a GPS fix or changing region bounds', () => {
  const view = aqabaInitialCamera(map);
  assert.deepEqual(view, { center: [35.006, 29.531], zoom: 13 });
  assert.equal('timestamp' in view, false);
  assert.deepEqual(map.bounds, [34.85, 29.10, 39.35, 33.45]);
});

test('initial camera respects the validated native pack zoom range', () => {
  assert.equal(aqabaInitialCamera({ ...map, minZoom: 14 }).zoom, 14);
  assert.equal(aqabaInitialCamera({ ...map, maxZoom: 12 }).zoom, 12);
});

test('an old or unrelated regional map cannot silently replace the Aqaba map', () => {
  assert.throws(() => aqabaInitialCamera({ ...map, bounds: [34.15, 31.15, 35.65, 32.65] }), /does not cover Aqaba/);
  assert.throws(() => aqabaInitialCamera({ ...map, tileUrlTemplate: 'https://example.com/{z}/{x}/{y}.pbf' }), /loopback/);
});
