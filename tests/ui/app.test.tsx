import { shortIdentity } from '../../src/features/contacts/ContactDirectory';
import React from 'react';
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import * as ReactNative from 'react-native';
import { AppState } from 'react-native';
import type { AppRoute, AppSnapshot, RuntimeResources } from '../../src/app/domain/types';
import type { BootstrapErrorCode } from '../../src/app/domain/BootstrapError';
import { PalMeshApp, type AppUiRuntime } from '../../src/app/ui';
import type { ChatUiService } from '../../src/features/chat/ui';
import type { ChatActionResult, ChatMessage, ChatSnapshot } from '../../src/features/chat/domain/types';
import type { MapsUiService } from '../../src/features/maps/ui';
import type { LocationActionResult, MapsSnapshot } from '../../src/features/maps/domain/types';
import type { LocationFix, OutgoingMessage, PowerMode } from '../../src/features/dtn/domain/types';
import { createMessage } from '../../src/features/dtn/domain/validation';
import { EmergencyService, type EmergencyEntry } from '../../src/features/emergency';
import { SecurityService } from '../../src/features/security';
import { I18nProvider, ar, en } from '../../src/shared/i18n';

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
  emergencyEntries: EmergencyEntry[] = [];
  readonly emergency = new EmergencyService({
    engine: { deviceId: 'local-device', subscribe: () => () => {}, historyWithCustody: async () => [],
      publish: async input => {
        const message = createMessage(input, '12345678-1234-4234-8234-123456789abc', 'local-device', NOW);
        return { status: 'accepted', record: { message, receivedAt: NOW, expiresAt: NOW + 60_000, dedupExpiresAt: NOW + 120_000, forwardable: true } };
      } },
    repository: { initialize: async () => {}, ingest: async () => {}, read: async () => this.emergencyEntries,
      dismiss: async id => { this.emergencyEntries = this.emergencyEntries.map(entry => entry.id === id ? { ...entry, dismissed: true } : entry); },
      claimNotification: async () => false },
    clock: { now: () => NOW },
  });
  resources: RuntimeResources = {
    deviceId: 'local-device', chat: this.chat, locations: this.locations,
    emergency: this.emergency,
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
  snapshot: AppSnapshot = { status: 'idle', startupFailure: null, route: 'chat', foreground: true, resources: null,
    permissions: null, radios: {}, connectedPeers: 0, requestingPermissions: false, pendingSos: false,
    powerMode: 'normal', issue: null, notice: null, backgroundEnabled: false, backgroundBusy: false,
    backgroundSupported: true, battery: null, automaticPowerMode: true, alertsEnabled: false, alertsBusy: false };
  failStartup = false;
  startupFailure: BootstrapErrorCode | 'unknown' = 'unknown';
  patch(change: Partial<AppSnapshot>): void { this.snapshot = Object.freeze({ ...this.snapshot, ...change }); for (const listener of this.listeners) listener(); }
  getSnapshot = (): AppSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  start = jest.fn(async (): Promise<void> => {
    if (this.failStartup) { this.patch({ status: 'error', startupFailure: this.startupFailure, resources: null, issue: 'startup-failed' }); return; }
    await this.resources.node.start(); await this.chat.start(); await this.locations.start(); await this.emergency.start();
    this.patch({ status: 'ready', startupFailure: null, resources: this.resources, issue: null,
      permissions: { platform: 'android', wifiDirect: false, bluetooth: false, canRequest: true } });
    this.applyVisibility();
  });
  stop = jest.fn(async (): Promise<void> => { await this.chat.stop(); await this.locations.stop(); await this.emergency.stop(); await this.resources.node.stop(); });
  setForeground = jest.fn((foreground: boolean): void => { this.patch({ foreground }); this.applyVisibility(); });
  navigate = jest.fn((route: AppRoute): void => { this.patch({ route }); this.applyVisibility(); });
  requestPermissions = jest.fn(async (): Promise<void> => { this.patch({
    permissions: { platform: 'android', wifiDirect: true, bluetooth: true, canRequest: true },
    radios: { 'wifi-direct': { available: true }, ble: { available: true } },
  }); });
  sendSos = jest.fn(async (_text?: string): Promise<LocationActionResult> => {
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
  setAutomaticPowerMode = jest.fn((automaticPowerMode: boolean): void => { this.patch({ automaticPowerMode }); });
  setBackgroundEnabled = jest.fn(async (backgroundEnabled: boolean): Promise<void> => { this.patch({ backgroundEnabled }); });
  requestAlerts = jest.fn(async (): Promise<void> => { this.patch({ alertsEnabled: true }); });
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
    await fireEvent.press(screen.getByRole('button',{name:'Location & sharing'}));
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

  test('reports unavailable startup queues, disables SOS and retries without claiming it was queued', async () => {
    const runtime = new RuntimeDouble(); runtime.failStartup = true;
    await render(<PalMeshApp runtime={runtime} />);
    expect(screen.getByText(/Messages and SOS cannot be queued until startup succeeds/)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'I Need Help · SOS' })).toBeDisabled();
    await fireEvent.press(screen.getByRole('button', { name: 'I Need Help · SOS' }));
    expect(runtime.sendSos).not.toHaveBeenCalled();
    expect(screen.queryByText(/SOS queued on this device/)).toBeNull();
    expect(runtime.locations.sendSos).not.toHaveBeenCalled();
    runtime.failStartup = false;
    await fireEvent.press(screen.getByRole('button', { name: 'Retry starting PalMesh' }));
    expect(runtime.start).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'New message' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'I Need Help · SOS' })).toBeEnabled();
    expect(screen.queryByText(en['app.recovery.title'])).toBeNull();
  });

  test('keeps loading queues explicitly unavailable and SOS visible but disabled until startup completes', async () => {
    const runtime = new RuntimeDouble();
    runtime.start.mockImplementation(async () => { runtime.patch({ status: 'starting' }); });
    await render(<PalMeshApp runtime={runtime} />);
    expect(screen.getByLabelText('Starting PalMesh')).toBeOnTheScreen();
    expect(screen.getByText('Messaging queues are not ready yet.')).toBeOnTheScreen();
    expect(screen.getByRole('tab', { name: 'Messages' })).toBeDisabled();
    expect(screen.getByRole('tab', { name: 'Map' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'I Need Help · SOS' })).toBeDisabled();
    await fireEvent.press(screen.getByRole('button', { name: 'I Need Help · SOS' }));
    expect(runtime.sendSos).not.toHaveBeenCalled();
    expect(screen.queryByText(/SOS queued on this device/)).toBeNull();
  });

  for (const language of ['en', 'ar'] as const) {
    for (const failure of ['secure-storage-unavailable', 'encryption-unavailable', 'data-recovery-required',
      'identity-recovery-required', 'provisioning-incomplete', 'unknown'] as const) {
      test(`provides ${language} data-preserving guidance for ${failure} and re-enables SOS only after recovery`, async () => {
        const runtime = new RuntimeDouble(); runtime.failStartup = true; runtime.startupFailure = failure;
        const translations = language === 'ar' ? ar : en;
        await render(<I18nProvider initialLanguage={language}><PalMeshApp runtime={runtime} /></I18nProvider>);
        expect(screen.getByText(translations['app.recovery.title'])).toBeOnTheScreen();
        expect(screen.getByText(translations[`app.recovery.${failure}`])).toBeOnTheScreen();
        expect(screen.getByText(translations['app.recovery.preserve'])).toBeOnTheScreen();
        expect(screen.getByRole('button', { name: translations['common.sos'] })).toBeDisabled();
        await fireEvent.press(screen.getByRole('button', { name: translations['common.sos'] }));
        expect(runtime.sendSos).not.toHaveBeenCalled();
        expect(screen.queryByText(/private-native-path|private-key|SQLITE_CORRUPT/)).toBeNull();
        runtime.failStartup = false;
        await fireEvent.press(screen.getByRole('button', { name: translations['app.retry'] }));
        expect(screen.queryByText(translations['app.recovery.title'])).toBeNull();
        expect(screen.getByRole('button', { name: translations['common.sos'] })).toBeEnabled();
        await fireEvent.press(screen.getByRole('button', { name: translations['common.sos'] }));
        expect(runtime.sendSos).toHaveBeenCalledTimes(1);
      });
    }
  }

  test('requires a deliberate action before requesting nearby radio permissions', async () => {
    const runtime = new RuntimeDouble();
    await render(<PalMeshApp runtime={runtime} />);
    expect(runtime.requestPermissions).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('tab',{name:'More'}));
    await fireEvent.press(screen.getByRole('button',{name:'Settings'}));
    await fireEvent.press(screen.getByRole('button', { name: 'Connect nearby' }));
    expect(runtime.requestPermissions).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Wi-Fi Direct: ready · Bluetooth: ready')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Connect nearby' })).toBeNull();
  });

  test('routes map low-battery mode through the runtime to both routing and location services', async () => {
    const runtime = new RuntimeDouble();
    await render(<PalMeshApp runtime={runtime} />);
    await fireEvent.press(screen.getByRole('tab', { name: 'Map' }));
    await fireEvent.press(screen.getByRole('button',{name:'Location & sharing'}));
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
    await fireEvent.press(screen.getByRole('button', { name: 'Back' }));
    await fireEvent.press(screen.getByRole('button', { name: 'I Need Help · SOS' }));
    expect(runtime.sendSos).toHaveBeenCalledTimes(1);
    expect(runtime.locations.sendSos).toHaveBeenCalledTimes(1);
  });
});

async function identity(seed: number): Promise<SecurityService> {
  const records = new Map<string, string>();
  let sequence = seed;
  const security = new SecurityService({ read: async key => records.get(key) ?? null,
    write: async (key, value) => { records.set(key, value); },
    randomBytes: async length => new Uint8Array(length).fill(sequence++) }, { now: () => NOW });
  await security.initialize();
  return security;
}

describe('integrated emergency, identity and offline settings', () => {
  test('opens urgent SOS inline and keeps exactly one SOS action reachable on every route', async () => {
    const runtime = new RuntimeDouble();
    runtime.emergencyEntries = [{ id: 'incoming-help', source: 'peer-bob', text: 'Need water', createdAt: NOW,
      receivedAt: NOW, expiresAt: NOW + 60_000, outgoing: false, dismissed: false, responseId: null, responses: [] }];
    await render(<PalMeshApp runtime={runtime} />);
    expect(screen.getByText('New incoming SOS')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Open SOS inbox' }));
    expect(screen.getByText('Need water')).toBeOnTheScreen();
    expect(screen.queryByText('New incoming SOS')).toBeNull();
    for (const route of ['Contacts', 'Map', 'Messages', 'More']) {
      await fireEvent.press(screen.getByRole('tab', { name: route }));
      expect(screen.getAllByRole('button', { name: 'I Need Help · SOS' })).toHaveLength(1);
    }
    await fireEvent.press(screen.getByRole('button', { name: 'I Need Help · SOS' }));
    expect(runtime.sendSos).toHaveBeenCalledWith('I need help');
  });

  test('requests notification and background permissions only from explicit settings actions', async () => {
    const runtime = new RuntimeDouble();
    await render(<PalMeshApp runtime={runtime} />);
    expect(runtime.requestAlerts).not.toHaveBeenCalled();
    expect(runtime.setBackgroundEnabled).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('tab', { name: 'Contacts' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Enable SOS notifications' }));
    expect(runtime.requestAlerts).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'SOS notifications enabled' })).toBeDisabled();
    await fireEvent.press(screen.getByRole('button', { name: 'Keep mesh active in background' }));
    expect(runtime.setBackgroundEnabled).toHaveBeenLastCalledWith(true);
    await fireEvent.press(screen.getByRole('button', { name: 'Stop background mesh' }));
    expect(runtime.setBackgroundEnabled).toHaveBeenLastCalledWith(false);
    await fireEvent(screen.getByRole('switch', { name: 'Automatic battery conservation' }), 'change', { nativeEvent: { value: false } });
    expect(runtime.setAutomaticPowerMode).toHaveBeenLastCalledWith(false);
    await fireEvent(screen.getByRole('switch', { name: 'Manual low battery mode' }), 'change', { nativeEvent: { value: true } });
    expect(runtime.setPowerMode).toHaveBeenLastCalledWith('conserve');
  });

  test('keeps unsupported background execution unavailable and still offers notification opt-in', async () => {
    const runtime = new RuntimeDouble(); runtime.patch({ backgroundSupported: false });
    await render(<PalMeshApp runtime={runtime} />);
    await fireEvent.press(screen.getByRole('tab', { name: 'Contacts' }));
    expect(screen.queryByRole('button', { name: 'Keep mesh active in background' })).toBeNull();
    expect(screen.getByText('Background mesh is unavailable. Keep PalMesh open for nearby connections.')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Enable SOS notifications' })).toBeEnabled();
  });

  test('imports public keys through the strict security validator and never displays private identity material', async () => {
    const runtime = new RuntimeDouble();
    const own = await identity(1); const peer = await identity(10);
    runtime.resources = { ...runtime.resources, security: own };
    await render(<PalMeshApp runtime={runtime} />);
    await fireEvent.press(screen.getByRole('tab', { name: 'Contacts' }));
    expect(screen.getByLabelText('Your identity fingerprint')).toHaveTextContent(own.deviceId);
    expect(screen.getByLabelText('Your public identity JSON')).toHaveTextContent(JSON.stringify(own.publicIdentity));
    expect(screen.queryByText(/signingSecret|encryptionSecret/)).toBeNull();
    const input = screen.getByLabelText('Contact public identity JSON');
    for (const invalid of ['{', 'x'.repeat(2049), JSON.stringify(own.publicIdentity),
      JSON.stringify({ ...peer.publicIdentity, signingSecret: 'unsafe' })]) {
      await fireEvent.changeText(input, invalid);
      await fireEvent.press(screen.getByRole('button', { name: 'Save contact identity' }));
      expect(screen.getByRole('alert')).toHaveTextContent(/Contact identity could not be saved/);
    }
    await fireEvent.changeText(input, JSON.stringify(peer.publicIdentity));
    await fireEvent.press(screen.getByRole('button', { name: 'Save contact identity' }));
    expect(screen.getByText('Contact identity saved.')).toBeOnTheScreen();
    expect(screen.getByText(peer.deviceId)).toBeOnTheScreen();
    expect(screen.getByLabelText('Contact public identity JSON')).toHaveDisplayValue('');
    await fireEvent.press(screen.getByRole('tab', { name: 'Messages' }));
    await fireEvent.press(screen.getByRole('button', { name: 'New message' }));
    await fireEvent.press(screen.getByRole('button', { name: shortIdentity(peer.deviceId) }));
    expect(runtime.chat.openConversation).toHaveBeenLastCalledWith(peer.deviceId);

    await fireEvent.press(screen.getByRole('button', { name: 'I Need Help · SOS' }));
    expect(runtime.sendSos).toHaveBeenCalledTimes(1);
  });

  test('private recovery opens contacts and returns without erasing the draft', async () => {
    const runtime = new RuntimeDouble();
    await render(<PalMeshApp runtime={runtime} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Open conversation with peer-alice, 1 unread' }));
    await fireEvent.changeText(screen.getByLabelText('Message'), 'Keep my private draft');
    await act(async () => { runtime.chat.patch({ issue: 'recipient-unknown' }); });
    await fireEvent.press(screen.getByRole('button', { name: 'Open identity and contacts' }));
    expect(runtime.getSnapshot().route).toBe('contacts');
    expect(screen.getByRole('button', { name: 'I Need Help · SOS' })).toBeEnabled();
    await fireEvent.press(screen.getByRole('tab', { name: 'Messages' }));
    expect(screen.getByLabelText('Message')).toHaveDisplayValue('Keep my private draft');
  });

  test('offers setup guidance without requesting permissions and keeps SOS reachable', async () => {
    const runtime = new RuntimeDouble();
    await render(<PalMeshApp runtime={runtime} />);
    await fireEvent.press(screen.getByRole('tab', { name: 'Contacts' }));
    const guide = screen.getByRole('button', { name: 'Offline messaging setup guide' });
    expect(guide.props.accessibilityState).toEqual({ expanded: false });
    await fireEvent.press(guide);
    expect(screen.getByText(/Messages queue on this phone without internet/)).toBeOnTheScreen();
    expect(screen.getByText(/Never share private keys/)).toBeOnTheScreen();
    expect(runtime.requestPermissions).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'I Need Help · SOS' })).toBeEnabled();
  });

  test('narrow large-font screens use two-column tabs without truncating labels or disabling SOS', async () => {
    jest.spyOn(ReactNative, 'useWindowDimensions').mockReturnValue({ width: 320, height: 640, scale: 2, fontScale: 1.8 });
    const runtime = new RuntimeDouble();
    await render(<PalMeshApp runtime={runtime} />);
    for (const tab of screen.getAllByRole('tab')) expect(tab).toHaveStyle({ flexBasis: '50%' });
    expect(screen.getByRole('button', { name: 'I Need Help · SOS' })).toBeEnabled();
    await fireEvent.press(screen.getByRole('tab', { name: 'Contacts' }));
    expect(screen.getByRole('button', { name: 'Offline messaging setup guide' })).toBeEnabled();
  });

  test('renders all app routes in Arabic with one reachable localized SOS and translated SOS payload', async () => {
    const runtime = new RuntimeDouble();
    await render(<I18nProvider initialLanguage="ar"><PalMeshApp runtime={runtime} /></I18nProvider>);
    for (const route of ['ui.contacts', 'ui.map', 'ui.more', 'ui.messages'] as const) {
      await fireEvent.press(screen.getByRole('tab', { name: ar[route] }));
      expect(screen.getAllByRole('button', { name: ar['common.sos'] })).toHaveLength(1);
    }
    await fireEvent.press(screen.getByRole('button', { name: ar['common.sos'] }));
    expect(runtime.sendSos).toHaveBeenCalledWith(ar['emergency.newHelp']);
    expect(screen.queryByText('Messages are not encrypted yet.')).toBeNull();
  });
});
