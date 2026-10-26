import React from 'react';
import { beforeEach, afterEach, expect, jest, test } from '@jest/globals';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { NativeModules, Platform } from 'react-native';
import type { Feature } from 'geojson';
import { NetworkManager } from '@maplibre/maplibre-react-native';
import { OfflineMapView } from '../../src/features/maps/ui/OfflineMapView';

const mockOrder: string[] = [];
const mockQuery = jest.fn<(options?: { layers?: string[] }) => Promise<Feature[]>>();
const mockGetZoom = jest.fn<() => Promise<number>>().mockResolvedValue(8);
const mockGetCenter = jest.fn<() => Promise<[number, number]>>().mockResolvedValue([35,32]);
const mockZoomTo = jest.fn();
const mockEvidence = jest.fn<(...counts: number[]) => Promise<void>>().mockResolvedValue(undefined);
jest.mock('@maplibre/maplibre-react-native', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    NetworkManager: { setConnected: jest.fn(() => { mockOrder.push('local-scheduler'); }) },
    Map: React.forwardRef((props: object, ref: unknown) => {
      mockOrder.push('mount-map');
      React.useImperativeHandle(ref, () => ({ queryRenderedFeatures: mockQuery, getZoom: mockGetZoom, getCenter: mockGetCenter }));
      return React.createElement(View, { ...props, testID: 'native-map' });
    }), Camera: React.forwardRef((_props: object, ref: unknown) => {
      React.useImperativeHandle(ref, () => ({ zoomTo: mockZoomTo })); return null;
    }), Layer: () => null,
    GeoJSONSource: ({ children }: { children: React.ReactNode }) => children,
  };
});
const descriptor = { tileUrlTemplate: `http://127.0.0.1:23001/${'a'.repeat(32)}/{z}/{x}/{y}.pbf`,
  glyphUrlTemplate: `http://127.0.0.1:23001/${'a'.repeat(32)}/fonts/{fontstack}/{range}.pbf`,
  bounds: [34.15, 31.15, 35.65, 32.65] as const, minZoom: 6, maxZoom: 14,
  sourceLayers: ['transportation', 'place'], attribution: '© OpenStreetMap contributors' };
const originalPlatform = Platform.OS;
const originalModule = NativeModules.PalMeshOfflineMaps;
beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  Platform.OS = 'android';
  mockOrder.length = 0;
  mockGetZoom.mockReset().mockResolvedValue(8); mockZoomTo.mockReset();
  mockGetCenter.mockReset().mockResolvedValue([35,32]);
  jest.mocked(NetworkManager.setConnected).mockReset().mockImplementation(() => { mockOrder.push('local-scheduler'); });
  NativeModules.PalMeshOfflineMaps = { renderDiagnosticsEnabled: true, recordRenderEvidence: mockEvidence };
  mockQuery.mockReset().mockImplementation(async options => [{ type: 'Feature', geometry: { type: 'Point', coordinates: [35, 32] },
    properties: options?.layers?.some(id => id.startsWith('label-')) ? { 'name:ar': 'اختبار' } : {} }]);
});
afterEach(() => { Platform.OS = originalPlatform; NativeModules.PalMeshOfflineMaps = originalModule; jest.useRealTimers(); });
const props = { descriptor, localLocation: null, peers: [], powerMode: 'normal' as const };

test('accessible zoom controls wait for geometry and clamp native zoom to map bounds', async () => {
  await render(<OfflineMapView {...props} onUnavailable={jest.fn()} />);
  expect(screen.getByRole('button', { name: 'Zoom in' })).toBeDisabled();
  await act(async () => { jest.advanceTimersByTime(1_000); });
  await act(async () => { fireEvent.press(screen.getByRole('button', { name: 'Zoom in' })); });
  expect(mockZoomTo).toHaveBeenLastCalledWith(9, { duration: 200 });
  mockGetZoom.mockResolvedValue(18);
  await act(async () => { fireEvent.press(screen.getByRole('button', { name: 'Zoom in' })); });
  expect(mockZoomTo).toHaveBeenLastCalledWith(18, { duration: 200 });
  mockGetZoom.mockResolvedValue(6);
  await act(async () => { fireEvent.press(screen.getByRole('button', { name: 'Zoom out' })); });
  expect(mockZoomTo).toHaveBeenLastCalledWith(6, { duration: 200 });
});

test('invalid native zoom fails honestly without sending invalid camera coordinates', async () => {
  const failed = jest.fn(); await render(<OfflineMapView {...props} onUnavailable={failed} />);
  await act(async () => { jest.advanceTimersByTime(1_000); });
  mockGetZoom.mockResolvedValue(Number.NaN);
  await act(async () => { fireEvent.press(screen.getByRole('button', { name: 'Zoom in' })); });
  expect(mockZoomTo).not.toHaveBeenCalled(); expect(failed).toHaveBeenCalled();
});

test('enables the SDK local HTTP scheduler before mounting; style and glyphs remain loopback only', async () => {
  const failed = jest.fn();
  await render(<OfflineMapView {...props} onUnavailable={failed} />);
  expect(mockOrder.indexOf('local-scheduler')).toBeLessThan(mockOrder.indexOf('mount-map'));
  expect(NetworkManager.setConnected).toHaveBeenCalledWith(true);
  const style = screen.getByTestId('native-map').props.mapStyle;
  expect(style.glyphs).toBe(descriptor.glyphUrlTemplate);
  expect(style.sources.offline.tiles).toEqual([descriptor.tileUrlTemplate]);
  await act(async () => { jest.advanceTimersByTime(1_000); });
  expect(screen.getByText('Offline map ready')).toBeOnTheScreen();
  expect(mockEvidence).toHaveBeenCalledWith(1, 1, 1, 1, 8, 0);
  expect(failed).not.toHaveBeenCalled();
});

test('nested-map gestures are explicit and pan evidence never exports center coordinates', async () => {
  await render(<OfflineMapView {...props} onUnavailable={jest.fn()} />);
  expect(screen.getByTestId('native-map').props.dragPan).toBe(true);
  expect(screen.getByTestId('native-map').props.touchZoom).toBe(true);
  await act(async () => { jest.advanceTimersByTime(1_000); });
  mockGetCenter.mockResolvedValue([35.01,32.01]);
  await act(async () => { jest.advanceTimersByTime(1_000); });
  expect(mockEvidence).toHaveBeenLastCalledWith(1, 1, 1, 1, 8, 1);
});

test('a blank renderer cannot report ready and times out into the existing honest error path', async () => {
  mockQuery.mockResolvedValue([]);
  const failed = jest.fn();
  await render(<OfflineMapView {...props} onUnavailable={failed} />);
  await act(async () => { jest.advanceTimersByTime(30_000); });
  expect(failed).toHaveBeenCalled();
  expect(screen.queryByText('Offline map ready')).toBeNull();
});

test('unmount cancels the render deadline and does not produce a later unavailable error', async () => {
  mockQuery.mockResolvedValue([]);
  const failed = jest.fn(); const view = await render(<OfflineMapView {...props} onUnavailable={failed} />);
  await view.unmount();
  await act(async () => { jest.advanceTimersByTime(31_000); });
  expect(failed).not.toHaveBeenCalled();
});

test('SDK initialization failure never mounts a misleading blank map', async () => {
  jest.mocked(NetworkManager.setConnected).mockImplementation(() => { throw new Error('native unavailable'); });
  const failed = jest.fn();
  await render(<OfflineMapView {...props} onUnavailable={failed} />);
  expect(failed).toHaveBeenCalled();
  expect(screen.queryByTestId('native-map')).toBeNull();
});

test('iOS does not receive the Android connectivity override', async () => {
  Platform.OS = 'ios';
  await render(<OfflineMapView {...props} onUnavailable={jest.fn()} />);
  expect(NetworkManager.setConnected).not.toHaveBeenCalled();
});

test('invalid remote resource descriptors fail before enabling the SDK or mounting a map', async () => {
  const failed = jest.fn();
  await render(<OfflineMapView {...props} descriptor={{ ...descriptor, tileUrlTemplate: 'https://example.com/{z}/{x}/{y}.pbf' }} onUnavailable={failed} />);
  expect(failed).toHaveBeenCalled();
  expect(NetworkManager.setConnected).not.toHaveBeenCalled();
  expect(screen.queryByTestId('native-map')).toBeNull();
});
