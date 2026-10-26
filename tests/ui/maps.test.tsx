import React from 'react';
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AppState } from 'react-native';
import type { PowerMode } from '../../src/features/dtn/domain/types';
import type { LocationActionResult, MapsSnapshot, OfflineMapDescriptor, PeerLocation } from '../../src/features/maps/domain/types';
import type { MapsUiService } from '../../src/features/maps/ui/MapsProvider';
import { OfflineMapView } from '../../src/features/maps/ui/OfflineMapView';
import { PalMeshMapsApp } from '../../src/features/maps/ui/PalMeshMapsApp';

// Tests exercise the real screen and application boundary, not a fake map SDK.
// Native drawing, tile HTTP, and GPU behavior require device validation.
jest.mock('../../src/features/maps/ui/OfflineMapView', () => ({ OfflineMapView: jest.fn(() => null) }));

const NOW = 1_800_000_000_000;
const descriptor: OfflineMapDescriptor = Object.freeze({
  tileUrlTemplate: 'http://127.0.0.1:8765/0123456789abcdef0123456789abcdef/{z}/{x}/{y}.pbf',
  bounds: [34.2, 31.2, 35.6, 32.6] as const, minZoom: 0, maxZoom: 14,
  sourceLayers: ['water', 'transportation', 'building'], attribution: 'Bundled map attribution',
});
const initialAppState = AppState.currentState;
beforeEach(() => { AppState.currentState = 'active'; });
afterEach(() => { AppState.currentState = initialAppState; });

function peer(overrides: Partial<PeerLocation> = {}): PeerLocation {
  return { deviceId: 'peer-alice', location: { latitude: 31.5, longitude: 34.47, timestamp: NOW - 600_000 },
    receivedAt: NOW - 180_000, messageId: '12345678-1234-4234-8234-123456789abc', origin: 'location', ...overrides };
}

class ReactiveMapsService implements MapsUiService {
  readonly deviceId = 'local-device';
  private readonly listeners = new Set<() => void>();
  snapshot: MapsSnapshot = Object.freeze({
    status: 'idle', mapStatus: 'unavailable', map: null, localLocation: null, peers: [],
    sharing: false, powerMode: 'normal', locating: false, pendingSos: false, issue: null, notice: null, now: NOW,
  });
  sosGate: Promise<void> | null = null;
  patch(change: Partial<MapsSnapshot>): void {
    this.snapshot = Object.freeze({ ...this.snapshot, ...change });
    for (const listener of this.listeners) listener();
  }
  getSnapshot = (): MapsSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  start = jest.fn(async (): Promise<void> => { this.patch({ status: 'ready' }); });
  stop = jest.fn(async (): Promise<void> => {});
  setVisible = jest.fn((_visible: boolean): void => {});
  refresh = jest.fn(async (): Promise<void> => { this.patch({ status: 'ready', issue: null }); });
  refreshLocal = jest.fn(async (): Promise<LocationActionResult> => {
    this.patch({ localLocation: { latitude: 31.5, longitude: 34.47, timestamp: NOW }, locating: false });
    return { status: 'updated' };
  });
  shareOnce = jest.fn(async (): Promise<LocationActionResult> => {
    this.patch({ notice: 'location-queued' });
    return { status: 'queued', messageId: 'location-report' };
  });
  setSharing = jest.fn(async (sharing: boolean): Promise<void> => { this.patch({ sharing }); });
  setPowerMode = jest.fn((powerMode: PowerMode): void => { this.patch({ powerMode }); });
  sendSos = jest.fn(async (): Promise<LocationActionResult> => {
    this.patch({ pendingSos: true });
    if (this.sosGate !== null) await this.sosGate;
    this.patch({ pendingSos: false, notice: 'sos-queued' });
    return { status: 'queued', messageId: 'sos-report' };
  });
  dismissIssue = jest.fn((): void => { this.patch({ issue: null }); });
  dismissNotice = jest.fn((): void => { this.patch({ notice: null }); });
}

describe('PalMesh offline maps UI', () => {
  test('clearly reports missing bundled tiles without requesting GPS or enabling sharing', async () => {
    const service = new ReactiveMapsService();
    await render(<PalMeshMapsApp service={service} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/bundled Palestine MBTiles asset is missing or could not be opened/);
    expect(screen.getByText('No GPS fix stored. Update GPS to obtain one.')).toBeOnTheScreen();
    expect(screen.getByRole('switch', { name: 'Share location periodically' })).not.toBeChecked();
    expect(service.refreshLocal).not.toHaveBeenCalled();
    expect(service.shareOnce).not.toHaveBeenCalled();
    expect(service.setSharing).not.toHaveBeenCalled();
    expect(OfflineMapView).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('button', { name: 'I Need Help · SOS' }));
    expect(service.sendSos).toHaveBeenCalledTimes(1);
    expect(screen.getByText('SOS queued locally. Receipt or assistance is not confirmed.')).toBeOnTheScreen();
  });

  test('passes only the supplied offline descriptor and timestamped points to the native renderer', async () => {
    const service = new ReactiveMapsService();
    const report = peer();
    const localLocation = { latitude: 31.6, longitude: 35.1, timestamp: NOW - 60_000 };
    service.patch({ mapStatus: 'ready', map: descriptor, peers: [report], localLocation });
    await render(<PalMeshMapsApp service={service} />);
    expect(screen.getByLabelText('Offline map of bundled coverage')).toBeOnTheScreen();
    const props = jest.mocked(OfflineMapView).mock.calls.at(-1)![0];
    expect(props.descriptor).toBe(descriptor);
    expect(props.localLocation).toBe(localLocation);
    expect(props.peers).toEqual([report]);
    expect(props.powerMode).toBe('normal');
    expect(screen.getByText('Bundled map attribution')).toBeOnTheScreen();
    expect(screen.getByText('Last report received 3 minutes ago')).toBeOnTheScreen();
    expect(screen.getByText('GPS fix obtained 10 minutes ago')).toBeOnTheScreen();
    expect(screen.getByText('GPS fix obtained 1 minute ago')).toBeOnTheScreen();
    expect(screen.getByText('Latitude 31.50000, longitude 34.47000')).toBeOnTheScreen();
    expect(screen.queryByText(/peer-alice is online/i)).toBeNull();
  });

  test('updates report age reactively and distinguishes SOS reports without claiming peer presence', async () => {
    const service = new ReactiveMapsService();
    service.patch({ peers: [peer({ origin: 'sos' })] });
    await render(<PalMeshMapsApp service={service} />);
    expect(screen.getByText('SOS · peer-alice')).toBeOnTheScreen();
    expect(screen.getByText('Last report received 3 minutes ago')).toBeOnTheScreen();
    await act(async () => { service.patch({ now: NOW + 60_000 }); });
    expect(screen.getByText('Last report received 4 minutes ago')).toBeOnTheScreen();
    expect(screen.getByText(/They do not confirm that a peer is connected/)).toBeOnTheScreen();
  });

  test('distinguishes a just-arrived report from its old GPS fix after a long store-and-forward delay', async () => {
    const service = new ReactiveMapsService();
    service.patch({ peers: [peer({ receivedAt: NOW,
      location: { latitude: 31.5, longitude: 34.47, timestamp: NOW - 2 * 86_400_000 } })] });
    await render(<PalMeshMapsApp service={service} />);
    expect(screen.getByText('Last report received just now')).toBeOnTheScreen();
    expect(screen.getByText('GPS fix obtained 2 days ago')).toBeOnTheScreen();
  });

  test('updates GPS only on explicit request and allows one-off sharing before a stored fix exists', async () => {
    const service = new ReactiveMapsService();
    await render(<PalMeshMapsApp service={service} />);
    expect(screen.getByRole('button', { name: 'Share location once' })).toBeEnabled();
    await fireEvent.press(screen.getByRole('button', { name: 'Update GPS' }));
    expect(service.refreshLocal).toHaveBeenCalledTimes(1);
    expect(screen.getByText('GPS fix obtained just now')).toBeOnTheScreen();
    expect(service.shareOnce).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('button', { name: 'Share location once' }));
    expect(service.shareOnce).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Location report queued locally. Delivery is not confirmed.')).toBeOnTheScreen();
  });

  test('opts into periodic sharing, reports low-battery pause, and leaves SOS usable', async () => {
    const service = new ReactiveMapsService();
    await render(<PalMeshMapsApp service={service} />);
    expect(screen.getByText('Periodic sharing is off.')).toBeOnTheScreen();
    await fireEvent(screen.getByRole('switch', { name: 'Share location periodically' }), 'change', { nativeEvent: { value: true } });
    expect(service.setSharing).toHaveBeenLastCalledWith(true);
    expect(screen.getByText('Periodic sharing is on while this screen is visible.')).toBeOnTheScreen();
    await fireEvent(screen.getByRole('switch', { name: 'Low battery mode' }), 'change', { nativeEvent: { value: true } });
    expect(service.setPowerMode).toHaveBeenLastCalledWith('conserve');
    expect(screen.getByText('Periodic sharing paused in low battery mode.')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'I Need Help · SOS' })).toBeEnabled();
    await fireEvent(screen.getByRole('switch', { name: 'Share location periodically' }), 'change', { nativeEvent: { value: false } });
    expect(service.setSharing).toHaveBeenLastCalledWith(false);
  });

  test('shows GPS denial and a missing map while keeping the emergency action reachable', async () => {
    const service = new ReactiveMapsService();
    service.patch({ issue: 'gps-denied', status: 'error' });
    await render(<PalMeshMapsApp service={service} />);
    expect(screen.getByText(/Location access was denied/)).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'I Need Help · SOS' }));
    expect(service.sendSos).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByRole('button', { name: 'Dismiss map error' }));
    expect(service.dismissIssue).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByRole('button', { name: 'Retry offline map' }));
    expect(service.refresh).toHaveBeenCalledTimes(1);
  });

  test('does not duplicate emergency publication while GPS and SOS operations are busy', async () => {
    const service = new ReactiveMapsService();
    service.patch({ locating: true });
    let finish!: () => void;
    service.sosGate = new Promise<void>(resolve => { finish = resolve; });
    await render(<PalMeshMapsApp service={service} />);
    expect(screen.getByRole('button', { name: 'Updating GPS' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Share location once' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'I Need Help · SOS' })).toBeEnabled();
    await fireEvent.press(screen.getByRole('button', { name: 'I Need Help · SOS' }));
    await fireEvent.press(screen.getByRole('button', { name: 'I Need Help · SOS' }));
    expect(service.sendSos).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'I Need Help · SOS' })).toBeDisabled();
    await act(async () => { finish(); });
    expect(screen.getByRole('button', { name: 'I Need Help · SOS' })).toBeEnabled();
  });

  test('handles a native renderer failure locally, preserves reports, and retries without an online fallback', async () => {
    const service = new ReactiveMapsService();
    service.patch({ mapStatus: 'ready', map: descriptor, peers: [peer()] });
    await render(<PalMeshMapsApp service={service} />);
    const props = jest.mocked(OfflineMapView).mock.calls.at(-1)![0];
    await act(async () => { props.onUnavailable(); });
    expect(screen.getByText(/Offline map could not render/)).toBeOnTheScreen();
    expect(screen.getByText('Last report received 3 minutes ago')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'I Need Help · SOS' })).toBeEnabled();
    await fireEvent.press(screen.getByRole('button', { name: 'Retry offline map' }));
    expect(service.refresh).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Offline map of bundled coverage')).toBeOnTheScreen();
    expect(jest.mocked(OfflineMapView).mock.calls.at(-1)![0].descriptor).toBe(descriptor);
  });

  test('keeps loading feedback separate from the always available SOS action', async () => {
    const service = new ReactiveMapsService();
    service.start.mockImplementation(async () => { service.patch({ status: 'loading', mapStatus: 'loading' }); });
    await render(<PalMeshMapsApp service={service} />);
    expect(screen.getByLabelText('Opening offline map')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'I Need Help · SOS' })).toBeEnabled();
  });

  test('intersects route focus and AppState without restarting location subscriptions', async () => {
    const remove = jest.fn();
    const nativeSubscription = jest.spyOn(AppState, 'addEventListener').mockReturnValue({ remove });
    const service = new ReactiveMapsService();
    service.patch({ sharing: true });
    const view = await render(<PalMeshMapsApp service={service} visible={false} />);
    expect(service.setVisible).toHaveBeenLastCalledWith(false);
    expect(screen.getByText(/Periodic sharing paused while this screen is hidden/)).toBeOnTheScreen();
    const listener = nativeSubscription.mock.calls.find(([event]) => event === 'change')?.[1];
    expect(listener).toBeDefined();
    await act(async () => { listener!('background'); });
    await act(async () => { listener!('active'); });
    expect(service.setVisible.mock.calls.every(([value]) => !value)).toBe(true);
    await view.rerender(<PalMeshMapsApp service={service} visible />);
    expect(service.setVisible).toHaveBeenLastCalledWith(true);
    expect(screen.getByText('Periodic sharing is on while this screen is visible.')).toBeOnTheScreen();
    await act(async () => { listener!('background'); });
    expect(service.setVisible).toHaveBeenLastCalledWith(false);
    expect(screen.getByText(/Periodic sharing paused while this screen is hidden/)).toBeOnTheScreen();
    expect(service.start).toHaveBeenCalledTimes(1);
    expect(service.stop).not.toHaveBeenCalled();
    expect(nativeSubscription).toHaveBeenCalledTimes(1);
    await view.unmount();
    expect(service.stop).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  test('treats unknown native app state as hidden until an active event arrives', async () => {
    AppState.currentState = null;
    const service = new ReactiveMapsService();
    await render(<PalMeshMapsApp service={service} />);
    expect(service.setVisible).toHaveBeenLastCalledWith(false);
    expect(service.start).toHaveBeenCalledTimes(1);
  });
});
