import type { OfflineMapDescriptor } from './types';

export function validateOfflineMapDescriptor(value: unknown): OfflineMapDescriptor {
  if (!value || typeof value !== 'object') throw new Error('Invalid offline map descriptor');
  const record = value as Record<string, unknown>;
  // No public hosts, credentials, query strings or remote fallback paths are permitted.
  const match = typeof record.tileUrlTemplate === 'string'
    ? /^http:\/\/127\.0\.0\.1:([0-9]{1,5})\/[a-f0-9]{32,64}\/\{z\}\/\{x\}\/\{y\}\.pbf$/.exec(record.tileUrlTemplate) : null;
  if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535) throw new Error('Invalid loopback tile URL');
  const glyphUrlTemplate = record.glyphUrlTemplate;
  const expectedGlyphUrl = (record.tileUrlTemplate as string).replace('/{z}/{x}/{y}.pbf', '/fonts/{fontstack}/{range}.pbf');
  if (glyphUrlTemplate !== undefined && glyphUrlTemplate !== expectedGlyphUrl) {
    throw new Error('Invalid loopback glyph URL');
  }
  const bounds = record.bounds;
  if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(item => typeof item === 'number' && Number.isFinite(item))
    || bounds[0] < -180 || bounds[2] > 180 || bounds[1] < -90 || bounds[3] > 90
    || bounds[0] >= bounds[2] || bounds[1] >= bounds[3]) throw new Error('Invalid offline map bounds');
  const minZoom = record.minZoom, maxZoom = record.maxZoom;
  if (!Number.isInteger(minZoom) || !Number.isInteger(maxZoom) || (minZoom as number) < 0
    || (maxZoom as number) > 22 || (minZoom as number) > (maxZoom as number)) throw new Error('Invalid offline map zoom range');
  if (!Array.isArray(record.sourceLayers) || record.sourceLayers.length < 1 || record.sourceLayers.length > 128
    || !record.sourceLayers.every(layer => typeof layer === 'string' && /^[A-Za-z_][A-Za-z0-9_-]{0,127}$/.test(layer))
    || new Set(record.sourceLayers).size !== record.sourceLayers.length) throw new Error('Invalid vector source layers');
  if (typeof record.attribution !== 'string' || record.attribution.length > 1024
    || /[<>\u0000-\u001f\u007f]/.test(record.attribution)) throw new Error('Invalid plain-text attribution');
  return Object.freeze({ tileUrlTemplate: record.tileUrlTemplate as string,
    ...(glyphUrlTemplate === undefined ? {} : { glyphUrlTemplate: glyphUrlTemplate as string }),
    bounds: Object.freeze([...bounds]) as unknown as readonly [number, number, number, number],
    minZoom: minZoom as number, maxZoom: maxZoom as number,
    sourceLayers: Object.freeze([...record.sourceLayers]) as readonly string[], attribution: record.attribution });
}
