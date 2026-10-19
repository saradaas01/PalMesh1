import React, { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { ActivityIndicator, AppState, I18nManager, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView, initialWindowMetrics } from 'react-native-safe-area-context';
import { ChatProvider, ChatScreen } from '../../features/chat/ui';
import { MapsProvider, MapsScreen, type MapsUiService } from '../../features/maps/ui';
import type { RadioStatus } from '../../features/mesh';
import type { AppRuntime } from '../application/AppRuntime';
import type { AppRoute, AppSnapshot, RuntimeResources } from '../domain/types';

export type AppUiRuntime = Pick<AppRuntime, 'getSnapshot' | 'subscribe' | 'start' | 'stop' |
  'setForeground' | 'navigate' | 'requestPermissions' | 'sendSos' | 'setPowerMode' | 'dismissIssue' | 'dismissNotice'>;

export interface PalMeshAppProps { readonly runtime: AppUiRuntime }

const issues: Readonly<Record<NonNullable<AppSnapshot['issue']>, string>> = {
  'startup-failed': 'PalMesh could not start its local services. Retry to make messaging and SOS queues available.',
  'permissions-unavailable': 'Nearby connection permissions could not be enabled. Check the device settings and try again.',
  'radio-error': 'A nearby radio reported a problem. Queued messages wait for an available mesh route.',
  'queue-full': 'SOS was not queued. Local emergency capacity is full. Please try again when space is available.',
  'sos-unavailable': 'SOS could not be queued on this device. Please try again.',
};

function Button({ label, onPress, disabled = false }: {
  readonly label: string; readonly onPress: () => void; readonly disabled?: boolean;
}): React.JSX.Element {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }}
    disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.button, disabled && styles.disabled, pressed && styles.pressed]}>
    <Text style={styles.buttonText}>{label}</Text>
  </Pressable>;
}

function radioLabel(status: RadioStatus | undefined): string {
  if (status?.available) return 'ready';
  if (status?.reason === 'permission-denied') return 'permission needed';
  if (status?.reason === 'powered-off') return 'off';
  if (status?.reason === 'unsupported') return 'unsupported';
  return 'unavailable';
}

/** Public-method delegation keeps power conservation owned by the runtime,
 * which applies the same choice to the routing engine and location service. */
function useMapsService(resources: RuntimeResources | null, runtime: AppUiRuntime): MapsUiService | null {
  const locations = resources?.locations;
  return useMemo(() => locations === undefined ? null : {
    deviceId: locations.deviceId,
    getSnapshot: () => locations.getSnapshot(),
    subscribe: listener => locations.subscribe(listener),
    start: () => locations.start(), stop: () => locations.stop(),
    setVisible: visible => locations.setVisible(visible),
    refresh: () => locations.refresh(), refreshLocal: () => locations.refreshLocal(),
    shareOnce: () => locations.shareOnce(), setSharing: sharing => locations.setSharing(sharing),
    setPowerMode: mode => runtime.setPowerMode(mode),
    sendSos: () => locations.sendSos(), dismissIssue: () => locations.dismissIssue(),
    dismissNotice: () => locations.dismissNotice(),
  }, [locations, runtime]);
}

export function PalMeshApp({ runtime }: PalMeshAppProps): React.JSX.Element {
  const subscribe = useCallback((listener: () => void) => runtime.subscribe(listener), [runtime]);
  const getSnapshot = useCallback(() => runtime.getSnapshot(), [runtime]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const sosInFlight = useRef(false);
  const mapsService = useMapsService(snapshot.resources, runtime);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => runtime.setForeground(state === 'active'));
    runtime.setForeground(AppState.currentState === 'active');
    void runtime.start();
    return () => { subscription.remove(); void runtime.stop(); };
  }, [runtime]);
  const ready = snapshot.status === 'ready' && snapshot.resources !== null && mapsService !== null;
  const requestSos = (): void => {
    if (sosInFlight.current || snapshot.pendingSos) return;
    sosInFlight.current = true;
    void runtime.sendSos().finally(() => { sosInFlight.current = false; });
  };
  const needsPermissions = snapshot.permissions === null || !snapshot.permissions.bluetooth ||
    (snapshot.permissions.platform === 'android' && !snapshot.permissions.wifiDirect);
  const selectRoute = (route: AppRoute): void => runtime.navigate(route);

  return <SafeAreaProvider initialMetrics={initialWindowMetrics}>
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.header}>
        <Text accessibilityRole="header" style={styles.brand}>PalMesh</Text>
        <Text style={styles.secondary}>{snapshot.connectedPeers} connected mesh {snapshot.connectedPeers === 1 ? 'peer' : 'peers'}</Text>
        <Text style={styles.caption}>Messages are not encrypted yet.</Text>
      </View>
      <View accessibilityRole="tablist" style={styles.tabs}>
        {(['chat', 'maps'] as const).map(route => <Pressable key={route} accessibilityRole="tab"
          accessibilityLabel={route === 'chat' ? 'Messages' : 'Map'}
          accessibilityState={{ selected: snapshot.route === route, disabled: !ready }} disabled={!ready}
          onPress={() => selectRoute(route)} style={({ pressed }) => [styles.tab, snapshot.route === route && styles.selectedTab, pressed && styles.pressed]}>
          <Text style={styles.buttonText}>{route === 'chat' ? 'Messages' : 'Map'}</Text>
        </Pressable>)}
      </View>
      {ready && <View style={styles.connections}>
        <Text style={styles.caption}>Wi-Fi Direct: {radioLabel(snapshot.radios['wifi-direct'])} · Bluetooth: {radioLabel(snapshot.radios.ble)}</Text>
        {needsPermissions && snapshot.permissions?.canRequest !== false && <Button
          label={snapshot.requestingPermissions ? 'Enabling nearby connections' : 'Enable nearby connections'}
          disabled={snapshot.requestingPermissions} onPress={() => { void runtime.requestPermissions(); }} />}
        {needsPermissions && snapshot.permissions?.canRequest === false &&
          <Text style={styles.caption}>{snapshot.permissions.platform === 'unsupported'
            ? 'Nearby radios are not supported on this platform.'
            : 'Nearby permissions must be enabled in device settings.'}</Text>}
      </View>}

      <View style={styles.content}>
        {ready && snapshot.resources !== null && mapsService !== null ? snapshot.route === 'chat' ?
          <ChatProvider service={snapshot.resources.chat} manageLifecycle={false} manageVisibility={false}
            visible={snapshot.foreground}>
            <ChatScreen embedded showSos={false} />
          </ChatProvider> :
          <MapsProvider service={mapsService} manageLifecycle={false} manageVisibility={false}
            visible={snapshot.foreground}>
            <MapsScreen embedded showSos={false} />
          </MapsProvider> :
          <ScrollView contentContainerStyle={styles.startup}>
            {snapshot.status === 'starting' || snapshot.status === 'idle' ? <>
              <ActivityIndicator accessibilityLabel="Starting PalMesh" color="#ffffff" />
              <Text style={styles.body}>Starting local storage and mesh…</Text>
              <Text style={styles.secondary}>Messaging queues are not ready yet.</Text>
            </> : <>
              <Text accessibilityRole="alert" style={styles.body}>Local services are unavailable. Messages and SOS cannot be queued until startup succeeds.</Text>
              <Button label="Retry starting PalMesh" onPress={() => { void runtime.start(); }} />
            </>}
          </ScrollView>}
      </View>

      {(snapshot.issue !== null || snapshot.notice !== null) && <ScrollView style={styles.feedback} keyboardShouldPersistTaps="handled">
        {snapshot.issue !== null && <>
          <Text accessibilityRole="alert" accessibilityLiveRegion="assertive" style={styles.body}>{issues[snapshot.issue]}</Text>
          <Button label="Dismiss app error" onPress={() => runtime.dismissIssue()} />
        </>}
        {snapshot.notice === 'sos-queued' && <>
          <Text accessibilityLiveRegion="polite" style={styles.body}>SOS queued on this device. Receipt or assistance is not confirmed.</Text>
          <Button label="Dismiss SOS notice" onPress={() => runtime.dismissNotice()} />
        </>}
      </ScrollView>}
      <View style={styles.sosContainer}>
        <Pressable accessibilityRole="button" accessibilityLabel="I Need Help · SOS"
          accessibilityHint="Queues an emergency broadcast with the last stored GPS fix when available"
          accessibilityState={{ disabled: snapshot.pendingSos, busy: snapshot.pendingSos }} disabled={snapshot.pendingSos}
          onPress={requestSos} style={({ pressed }) => [styles.sos, snapshot.pendingSos && styles.disabled, pressed && styles.pressed]}>
          <Text style={styles.sosText}>{snapshot.pendingSos ? 'Queueing SOS…' : 'I Need Help · SOS'}</Text>
        </Pressable>
        <Text style={styles.caption}>Uses a stored GPS fix if available. No new GPS fix is required.</Text>
      </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  </SafeAreaProvider>;
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#0a1118', direction: I18nManager.isRTL ? 'rtl' : 'ltr' },
  screen: { flex: 1 },
  header: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 8, flexShrink: 0 },
  brand: { color: '#ffffff', fontSize: 25, fontWeight: '800', writingDirection: 'auto' },
  body: { color: '#ffffff', fontSize: 16, lineHeight: 24, writingDirection: 'auto' },
  secondary: { color: '#d2dde8', fontSize: 15, lineHeight: 23, writingDirection: 'auto' },
  caption: { color: '#c2d1df', fontSize: 12, lineHeight: 18, writingDirection: 'auto' },
  tabs: { flexDirection: 'row', paddingHorizontal: 12, gap: 8, borderBottomWidth: 1, borderBottomColor: '#405264' },
  tab: { flex: 1, minHeight: 48, justifyContent: 'center', alignItems: 'center', padding: 12, borderBottomWidth: 3, borderBottomColor: 'transparent' },
  selectedTab: { borderBottomColor: '#6bceff', backgroundColor: '#15364b' },
  connections: { paddingHorizontal: 16, paddingVertical: 6, flexShrink: 0 },
  content: { flex: 1, minHeight: 0 },
  startup: { flexGrow: 1, justifyContent: 'center', padding: 20, gap: 18 },
  button: { minHeight: 48, minWidth: 48, padding: 12, marginVertical: 4, borderRadius: 8, justifyContent: 'center', alignItems: 'center', backgroundColor: '#164c74' },
  buttonText: { color: '#ffffff', fontSize: 16, fontWeight: '700', textAlign: 'center', writingDirection: 'auto' },
  feedback: { maxHeight: 150, flexGrow: 0, flexShrink: 1, paddingHorizontal: 16, backgroundColor: '#3d2a20' },
  sosContainer: { padding: 12, borderTopWidth: 1, borderTopColor: '#405264', backgroundColor: '#0a1118', flexShrink: 0, zIndex: 1 },
  sos: { minHeight: 68, padding: 14, backgroundColor: '#b91525', borderWidth: 2, borderColor: '#ff919c', borderRadius: 10, justifyContent: 'center', alignItems: 'center' },
  sosText: { color: '#ffffff', fontSize: 23, fontWeight: '800', textAlign: 'center', writingDirection: 'auto' },
  disabled: { opacity: 0.55 },
  pressed: { opacity: 0.75 },
});
