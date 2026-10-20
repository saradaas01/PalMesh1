import type { OfflineMapDescriptor } from './types';
import { validateOfflineMapDescriptor } from './offlineMap';

type GeometryFilter = ['==', '$type', 'Polygon' | 'LineString' | 'Point'];
type FillLayer = { id: string; type: 'fill'; source: string; 'source-layer': string; filter: GeometryFilter; paint: { 'fill-color': string; 'fill-opacity': number } };
type LineLayer = { id: string; type: 'line'; source: string; 'source-layer': string; filter: GeometryFilter; paint: { 'line-color': string; 'line-width': number } };
type CircleLayer = { id: string; type: 'circle'; source: string; 'source-layer': string; filter: GeometryFilter; paint: { 'circle-color': string; 'circle-radius': number } };
type BackgroundLayer = { id: string; type: 'background'; paint: { 'background-color': string } };
type SymbolLayer = {
  id: string; type: 'symbol'; source: string; 'source-layer': string; minzoom: number;
  layout: {
    'text-field': ['coalesce', ['get', 'name:ar'], ['get', 'name'], ['get', 'name:en'], ['get', 'name:latin'], ''];
    'text-font': string[]; 'text-size': number; 'symbol-placement': 'line' | 'point';
    'text-max-width': number; 'text-padding': number;
  };
  paint: { 'text-color': string; 'text-halo-color': string; 'text-halo-width': number };
};
type OfflineLayer = FillLayer | LineLayer | CircleLayer | BackgroundLayer | SymbolLayer;

/** Every resource comes from one token-protected loopback host. Glyphs are
 * optional, so older/custom packs keep rendering geometry without fonts.
 * Native MapLibre performs Arabic shaping using the bundled Noto glyph pages. */
export function buildOfflineStyle(input: OfflineMapDescriptor): {
  version: 8;
  glyphs?: string;
  sources: Record<string, { type: 'vector'; tiles: string[]; minzoom: number; maxzoom: number }>;
  layers: OfflineLayer[];
} {
  const map = validateOfflineMapDescriptor(input);
  const layers: OfflineLayer[] = [
    { id: 'background', type: 'background', paint: { 'background-color': '#17232d' } },
  ];
  const labels: SymbolLayer[] = [];
  for (const [index, sourceLayer] of map.sourceLayers.entries()) {
    const water = /water|ocean|lake|river/i.test(sourceLayer);
    const road = /road|transport|street|path/i.test(sourceLayer);
    const building = /building/i.test(sourceLayer);
    layers.push({ id: `fill-${index}`, type: 'fill', source: 'offline', 'source-layer': sourceLayer,
      filter: ['==', '$type', 'Polygon'],
      paint: { 'fill-color': water ? '#1b5876' : building ? '#52616c' : '#30463e', 'fill-opacity': 0.8 } });
    layers.push({ id: `line-${index}`, type: 'line', source: 'offline', 'source-layer': sourceLayer,
      filter: ['==', '$type', 'LineString'],
      paint: { 'line-color': water ? '#60abc9' : road ? '#e2d39f' : '#738493', 'line-width': road ? 1.8 : 0.6 } });
    layers.push({ id: `point-${index}`, type: 'circle', source: 'offline', 'source-layer': sourceLayer,
      filter: ['==', '$type', 'Point'],
      paint: { 'circle-color': '#c5d5df', 'circle-radius': 1.5 } });
    if (map.glyphUrlTemplate !== undefined && /name|place|poi|road|street/i.test(sourceLayer)) {
      labels.push({ id: `label-${index}`, type: 'symbol', source: 'offline', 'source-layer': sourceLayer,
        minzoom: /place/i.test(sourceLayer) ? 5 : road ? 13 : 14,
        layout: {
          'text-field': ['coalesce', ['get', 'name:ar'], ['get', 'name'], ['get', 'name:en'], ['get', 'name:latin'], ''],
          'text-font': ['Klokantech Noto Sans Regular'], 'text-size': road ? 12 : 14,
          'symbol-placement': road ? 'line' : 'point', 'text-max-width': 12, 'text-padding': 4,
        },
        paint: { 'text-color': '#ffffff', 'text-halo-color': '#17232d', 'text-halo-width': 1.5 },
      });
    }
  }
  // Put labels above every geometry layer, regardless of pack metadata order.
  layers.push(...labels);
  return { version: 8, ...(map.glyphUrlTemplate === undefined ? {} : { glyphs: map.glyphUrlTemplate }),
    sources: { offline: { type: 'vector', tiles: [map.tileUrlTemplate], minzoom: map.minZoom, maxzoom: map.maxZoom } }, layers };
}
