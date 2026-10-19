import React from 'react';
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AppState } from 'react-native';
import type { AppRoute, AppSnapshot, RuntimeResources } from '../../src/app/domain/types';
import { PalMeshApp, type AppUiRuntime } from '../../src/app/ui';
import type { ChatUiService } from '../../src/features/chat/ui';
import type { ChatActionResult, ChatMessage, ChatSnapshot } from '../../src/features/chat/domain/types';
import type { MapsUiService } from '../../src/features/maps/ui';
import type { LocationActionResult, MapsSnapshot } from '../../src/features/maps/domain/types';
import type { LocationFix, OutgoingMessage, PowerMode } from '../../src/features/dtn/domain/types';
import { createMessage } from '../../src/features/dtn/domain/validation';

jest.mock('../../src/features/maps/ui/OfflineMapView', () => ({ OfflineMapView: jest.fn(() => null) }));

const NOW = 1_800_000_000_000;
const originalAppState = AppState.currentState;
beforeEach(() => { AppState.currentState = 'active'; });
afterEach(() => { AppState.currentState = originalAppState; });

class ChatDouble implements ChatUiService {
  readonly deviceId = 'local-device';
  readonly listeners = new Set<() => void>();
  readonly received: ChatMessage = { id: 'hello', sequence: 1, conversationId: 'peer-alice',
    source: 'peer-alice', destination: 'local-device', kind: 'chat', text: 'Hello nearby',
    createdAt: NOW, receivedAt: NOW, expiresAt: NOW + 60_000, outgoing: false, peerStored: false, read: false };
  snapshot: ChatSnapshot = { status: 'idle', conversations: [{ id: 'peer-alice', lastMessage: this.received, unreadCount: 1 }],
    messages: [], selectedConversationId: null, connectedPeers: [], draft: '', pendingSend: false, pendingSos: false,
    hasOlderMessages: false, issue: null, notice: null, now: NOW };
  patch(change: Partial<ChatSnapshot>): void { this.snapshot = Object.freeze({ ...this.snapshot, ...change }); for (const listener of this.listeners) listener(); }
  getSnapshot = (): ChatSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  start = jest.fn(async (): Promise<void> => { this.patch({ status: 'ready' }); });
  stop = jest.fn(async (): Promise<void> => {});
  setVisible = jest.fn((_visible: boolean): void => {});
  openConversation = jest.fn(async (id: string): Promise<void> => { this.patch({ selectedConversationId: id, messages: id === 'peer-alice' ? [this.received] : [] }); });
  closeConversation = jest.fn((): void => { this.patch({ selectedConversationId: null, messages: [] }); });
  setDraft = jest.fn((draft: string): void => { this.patch({ draft }); });
  send = jest.fn(async (): Promise<ChatActionResult> => { this.patch({ draft: '' }); return { status: 'queued', messageId: 'chat' }; });
  sendSos = jest.fn(async (): Promise<ChatActionResult> => ({ status: 'queued', messageId: 'chat-sos' }));
  loadOlder = jest.fn(async (): Promise<void> => {});
  refresh = jest.fn(async (): Promise<void> => {});
  dismissIssue = jest.fn((): void => { this.patch({ issue: null }); });
  dismissNotice = jest.fn((): void => { this.patch({ notice: null }); });
}

class MapsDouble implements MapsUiService {
  readonly deviceId = 'local-device';
  readonly listeners = new Set<() => void>();
  snapshot: MapsSnapshot = { status: 'idle', mapStatus: 'unavailable', map: null,
    localLocation: { latitude: 31.5, longitude: 34.47, timestamp: NOW - 60_000 }, peers: [],
    sharing: false, powerMode: 'normal', locating: false, pendingSos: false, issue: null, notice: null, now: NOW };
  sosGate: Promise<void> | null = null;
  lastSosLocation: LocationFix | null = null;
  patch(change: Partial<MapsSnapshot>): void { this.snapshot = Object.freeze({ ...this.snapshot, ...change }); for (const listener of this.listeners) listener(); }
  getSnapshot = (): MapsSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  start = jest.fn(async (): Promise<void> => { this.patch({ status: 'ready' }); });
  stop = jest.fn(async (): Promise<void> => {});
  setVisible = jest.fn((_visible: boolean): void => {});
  refresh = jest.fn(async (): Promise<void> => {});
  refreshLocal = jest.fn(async (): Promise<LocationActionResult> => ({ status: 'updated' }));
  shareOnce = jest.fn(async (): Promise<LocationActionResult> => ({ status: 'queued', messageId: 'location' }));
  setSharing = jest.fn(async (sharing: boolean): Promise<void> => { this.patch({ sharing }); });
  setPowerMode = jest.fn((powerMode: PowerMode): void => { this.patch({ powerMode }); });
  sendSos = jest.fn(async (): Promise<LocationActionResult> => {
    this.lastSosLocation = this.snapshot.localLocation;
    if (this.sosGate) await this.sosGate;
    this.patch({ notice: 'sos-queued' });
    return { status: 'queued', messageId: 'sos' };
  });
  dismissIssue = jest.fn((): void => { this.patch({ issue: null }); });
  dismissNotice = jest.fn((): void => { this.patch({ notice: null }); });
}

/** The fake implements the runtime boundary and delegates feature ownership.
 * Real SQLite/native/routing startup behavior is covered by runtime core tests. */
class RuntimeDouble implements AppUiRuntime {
  readonly listeners = new Set<() => void>();
  readonly chat = new ChatDouble();
  readonly locations = new MapsDouble();
  readonly resources: RuntimeResources = {
    deviceId: 'local-device', chat: this.chat, locations: this.locations,
    node: {
      engine: {
        start: async () => {},
        async publish(input: OutgoingMessage) {
          const message = createMessage(input, '12345678-1234-4234-8234-123456789abc', 'local-device', NOW);
          return { status: 'accepted' as const, record: { message, receivedAt: NOW, expiresAt: NOW + 60_000, dedupExpiresAt: NOW + 120_000, forwardable: true } };
        },
        setPowerMode: jest.fn((_mode: PowerMode): void => {}),
      },
      mesh: { start: async () => {}, stop: async () => {}, refreshRadios: async () => {}, connectedPeers: () => [], subscribe: () => () => {} },
      start: async () => {}, stop: async () => {},
    },
    release: async () => {},
  };
  snapshot: AppSnapshot = { status: 'idle', route: 'chat', foreground: true, resources: null,
    permissions: null, radios: {}, connectedPeers: 0, requestingPermissions: false, pendingSos: false,
    powerMode: 'normal', issue: null, notice: null };
  failStartup = false;
  patch(change: Partial<AppSnapshot>): void { this.snapshot = Object.freeze({ ...this.snapshot, ...change }); for (const listener of this.listeners) listener(); }
  getSnapshot = (): AppSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  start = jest.fn(async (): Promise<void> => {
    if (this.failStartup) { this.patch({ status: 'error', resources: null, issue: 'startup-failed' }); return; }
    await this.resources.node.start(); await this.chat.start(); await this.locations.start();
    this.patch({ status: 'ready', resources: this.resources, issue: null,
      permissions: { platform: 'android', wifiDirect: false, bluetooth: false, canRequest: true } });
    this.applyVisibility();
  });
  stop = jest.fn(async (): Promise<void> => { await this.chat.stop(); await this.locations.stop(); await this.resources.node.stop(); });
  setForeground = jest.fn((foreground: boolean): void => { this.patch({ foreground }); this.applyVisibility(); });
  navigate = jest.fn((route: AppRoute): void => { this.patch({ route }); this.applyVisibility(); });
  requestPermissions = jest.fn(async (): Promise<void> => { this.patch({
    permissions: { platform: 'android', wifiDirect: true, bluetooth: true, canRequest: true },
    radios: { 'wifi-direct': { available: true }, ble: { available: true } },
  }); });
  sendSos = jest.fn(async (): Promise<LocationActionResult> => {
    if (this.snapshot.status !== 'ready' || this.snapshot.resources === null) {
      this.patch({ issue: 'sos-unavailable', notice: null });
      return { status: 'rejected', reason: 'unavailable' };
    }
    this.patch({ pendingSos: true, issue: null });
    const result = await this.locations.sendSos();
    this.patch({ pendingSos: false, notice: result.status === 'queued' ? 'sos-queued' : null });
    return result;
  });
  setPowerMode = jest.fn((powerMode: PowerMode): void => {
    this.resources.node.engine.setPowerMode(powerMode);
    this.locations.setPowerMode(powerMode);
    this.patch({ powerMode });
  });
  dismissIssue = jest.fn((): void => { this.patch({ issue: null }); });
  dismissNotice = jest.fn((): void => { this.patch({ notice: null }); });
  private applyVisibility(): void {
    if (this.snapshot.resources === null) return;
    this.chat.setVisible(this.snapshot.foreground && this.snapshot.route === 'chat');
    this.locations.setVisible(this.snapshot.foreground && this.snapshot.route === 'maps');
  }
}

describe('PalMesh app shell', () => {
  test('preserves a conversation draft across tabs while both feature services stay running', async () => {
    const runtime = new RuntimeDouble();
    await render(<PalMeshApp runtime={runtime} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Open conversation with peer-alice, 1 unread' }));
    await fireEvent.changeText(screen.getByLabelText('Message'), 'Keep this offline draft');
    await fireEvent.press(screen.getByRole('tab', { name: 'Map' }));
    expect(runtime.chat.setVisible).toHaveBeenLastCalledWith(false);
    expect(runtime.locations.setVisible).toHaveBeenLastCalledWith(true);
    expect(screen.getByText('Your last GPS fix')).toBeOnTheScreen();
    expect(screen.getAllByRole('button', { name: 'I Need Help · SOS' })).toHaveLength(1);
    await fireEvent.press(screen.getByRole('tab', { name: 'Messages' }));
    expect(screen.getByLabelText('Message')).toHaveDisplayValue('Keep this offline draft');
    expect(runtime.chat.start).toHaveBeenCalledTimes(1);
    expect(runtime.locations.start).toHaveBeenCalledTimes(1);
    expect(runtime.chat.stop).not.toHaveBeenCalled();
    expect(runtime.locations.stop).not.toHaveBeenCalled();
    expect(runtime.chat.setVisible).toHaveBeenLastCalledWith(true);
    expect(runtime.locations.setVisible).toHaveBeenLastCalledWith(false);
  });

  test('uses the runtime location-aware SOS from Messages without invoking chat SOS or fresh GPS', async () => {
    const runtime = new RuntimeDouble();
    const storedFix = runtime.locations.snapshot.localLocation;
    await render(<PalMeshApp runtime={runtime} />);
    expect(screen.getAllByRole('button', { name: 'I Need Help · SOS' })).toHaveLength(1);
    await fireEvent.press(screen.getByRole('button', { name: 'I Need Help · SOS' }));
    expect(runtime.sendSos).toHaveBeenCalledTimes(1);
    expect(runtime.locations.sendSos).toHaveBeenCalledTimes(1);
    expect(runtime.chat.sendSos).not.toHaveBeenCalled();
    expect(runtime.locations.refreshLocal).not.toHaveBeenCalled();
    expect(runtime.locations.lastSosLocation).toBe(storedFix);
    expect(screen.getByText('SOS queued on this device. Receipt or assistance is not confirmed.')).toBeOnTheScreen();
  });

  test('keeps one emergency action busy across tab changes without duplicate publication', async () => {
    const runtime = new RuntimeDouble();
    let finish!: () => void;
    runtime.locations.sosGate = new Promise<void>(resolve => { finish = resolve; });
    await render(<PalMeshApp runtime={runtime} />);
    await fireEvent.press(screen.getByRole('button', { name: 'I Need Help · SOS' }));
    await fireEvent.press(screen.getByRole('tab', { name: 'Map' }));
    const sos = screen.getByRole('button', { name: 'I Need Help · SOS' });
    expect(sos).toBeDisabled();
    expect(screen.getAllByRole('button', { name: 'I Need Help · SOS' })).toHaveLength(1);
    await fireEvent.press(sos);
    expect(runtime.sendSos).toHaveBeenCalledTimes(1);
    await act(async () => { finish(); });
    expect(screen.getByRole('button', { name: 'I Need Help · SOS' })).toBeEnabled();
    expect(screen.getByText('SOS queued on this device. Receipt or assistance is not confirmed.')).toBeOnTheScreen();
    expect(screen.queryByText('SOS queued locally. Receipt or assistance is not confirmed.')).toBeNull();
  });

  test('reports unavailable startup queues and failed SOS truthfully, then retries startup', async () => {
    const runtime = new RuntimeDouble(); runtime.failStartup = true;
    await render(<PalMeshApp runtime={runtime} />);
    expect(screen.getByText(/Messages and SOS cannot be queued until startup succeeds/)).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'I Need Help · SOS' }));
    expect(screen.getByText('SOS could not be queued on this device. Please try again.')).toBeOnTheScreen();
    expect(screen.queryByText(/SOS queued on this device/)).toBeNull();
    expect(runtime.locations.sendSos).not.toHaveBeenCalled();
    runtime.failStartup = false;
    await fireEvent.press(screen.getByRole('button', { name: 'Retry starting PalMesh' }));
    expect(runtime.start).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'New message' })).toBeOnTheScreen();
  });

  test('keeps loading queues explicitly unavailable and SOS visible until startup completes', async () => {
    const runtime = new RuntimeDouble();
    runtime.start.mockImplementation(async () => { runtime.patch({ status: 'starting' }); });
    await render(<PalMeshApp runtime={runtime} />);
    expect(screen.getByLabelText('Starting PalMesh')).toBeOnTheScreen();
    expect(screen.getByText('Messaging queues are not ready yet.')).toBeOnTheScreen();
    expect(screen.getByRole('tab', { name: 'Messages' })).toBeDisabled();
    expect(screen.getByRole('tab', { name: 'Map' })).toBeDisabled();
    await fireEvent.press(screen.getByRole('button', { name: 'I Need Help · SOS' }));
    expect(screen.getByText('SOS could not be queued on this device. Please try again.')).toBeOnTheScreen();
    expect(screen.queryByText(/SOS queued on this device/)).toBeNull();
  });

  test('requires a deliberate action before requesting nearby radio permissions', async () => {
    const runtime = new RuntimeDouble();
    await render(<PalMeshApp runtime={runtime} />);
    expect(runtime.requestPermissions).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('button', { name: 'Enable nearby connections' }));
    expect(runtime.requestPermissions).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Wi-Fi Direct: ready · Bluetooth: ready')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Enable nearby connections' })).toBeNull();
  });

  test('routes map low-battery mode through the runtime to both routing and location services', async () => {
    const runtime = new RuntimeDouble();
    await render(<PalMeshApp runtime={runtime} />);
    await fireEvent.press(screen.getByRole('tab', { name: 'Map' }));
    await fireEvent(screen.getByRole('switch', { name: 'Low battery mode' }), 'change', { nativeEvent: { value: true } });
    expect(runtime.setPowerMode).toHaveBeenLastCalledWith('conserve');
    expect(runtime.resources.node.engine.setPowerMode).toHaveBeenLastCalledWith('conserve');
    expect(runtime.locations.setPowerMode).toHaveBeenLastCalledWith('conserve');
    expect(runtime.locations.setPowerMode).toHaveBeenCalledTimes(1);
  });

  test('uses one native foreground listener and does not stop background services or override hidden-route visibility', async () => {
    const remove = jest.fn();
    const subscription = jest.spyOn(AppState, 'addEventListener').mockReturnValue({ remove });
    const runtime = new RuntimeDouble();
    const view = await render(<PalMeshApp runtime={runtime} />);
    const listener = subscription.mock.calls.find(([event]) => event === 'change')?.[1];
    expect(listener).toBeDefined();
    await act(async () => { listener!('background'); });
    expect(runtime.setForeground).toHaveBeenLastCalledWith(false);
    expect(runtime.chat.setVisible).toHaveBeenLastCalledWith(false);
    expect(runtime.locations.setVisible).toHaveBeenLastCalledWith(false);
    await fireEvent.press(screen.getByRole('tab', { name: 'Map' }));
    expect(runtime.locations.setVisible).toHaveBeenLastCalledWith(false);
    await act(async () => { listener!('active'); });
    expect(runtime.chat.setVisible).toHaveBeenLastCalledWith(false);
    expect(runtime.locations.setVisible).toHaveBeenLastCalledWith(true);
    expect(runtime.stop).not.toHaveBeenCalled();
    expect(subscription).toHaveBeenCalledTimes(1);
    await view.unmount();
    expect(runtime.stop).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  test('treats an unknown initial native app state as hidden before local services start', async () => {
    AppState.currentState = null;
    const runtime = new RuntimeDouble();
    await render(<PalMeshApp runtime={runtime} />);
    expect(runtime.setForeground).toHaveBeenLastCalledWith(false);
    expect(runtime.setForeground.mock.invocationCallOrder[0]!).toBeLessThan(runtime.start.mock.invocationCallOrder[0]!);
    expect(runtime.chat.setVisible).toHaveBeenLastCalledWith(false);
    expect(runtime.locations.setVisible).toHaveBeenLastCalledWith(false);
  });

  test('keeps the global SOS at two taps from the new-conversation modal', async () => {
    const runtime = new RuntimeDouble();
    await render(<PalMeshApp runtime={runtime} />);
    await fireEvent.press(screen.getByRole('button', { name: 'New message' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Close new message' }));
    await fireEvent.press(screen.getByRole('button', { name: 'I Need Help · SOS' }));
    expect(runtime.sendSos).toHaveBeenCalledTimes(1);
    expect(runtime.locations.sendSos).toHaveBeenCalledTimes(1);
  });
});
