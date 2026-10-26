import React, { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { ActivityIndicator, AppState, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { SafeAreaProvider, SafeAreaView, initialWindowMetrics } from 'react-native-safe-area-context';
import { ChatProvider, ChatScreen } from '../../features/chat/ui';
import { MapsProvider, MapsScreen, type MapsUiService } from '../../features/maps/ui';
import type { RadioStatus } from '../../features/mesh';
import { EmergencyBanner, EmergencyInbox } from '../../features/emergency/ui';
import { LocalizedText as Text, useI18n, type Translate } from '../../shared/i18n';
import { SecurityScreen } from './SecurityScreen';
import type { AppRuntime } from '../application/AppRuntime';
import type { AppRoute, RuntimeResources } from '../domain/types';

export type AppUiRuntime = Pick<AppRuntime, 'getSnapshot' | 'subscribe' | 'start' | 'stop' |
  'setForeground' | 'navigate' | 'requestPermissions' | 'sendSos' | 'setPowerMode' | 'setBackgroundEnabled' |
  'setAutomaticPowerMode' | 'requestAlerts' | 'dismissIssue' | 'dismissNotice'>;

export interface PalMeshAppProps { readonly runtime: AppUiRuntime }

function Button({ label, onPress, disabled = false }: {
  readonly label: string; readonly onPress: () => void; readonly disabled?: boolean;
}): React.JSX.Element {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }}
    disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.button, disabled && styles.disabled, pressed && styles.pressed]}>
    <Text style={styles.buttonText}>{label}</Text>
  </Pressable>;
}

function radioLabel(status: RadioStatus | undefined, t: Translate): string {
  if (status?.available) return t('app.ready');
  if (status?.reason === 'permission-denied') return t('app.permissionNeeded');
  if (status?.reason === 'powered-off') return t('app.off');
  if (status?.reason === 'unsupported') return t('app.unsupported');
  return t('app.unavailable');
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
  const { t, rowStyle } = useI18n();
  const { width, fontScale } = useWindowDimensions();
  const compactTabs = width < 380 || fontScale > 1.3;
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
    if (!ready || sosInFlight.current || snapshot.pendingSos) return;
    sosInFlight.current = true;
    void runtime.sendSos(t('emergency.newHelp')).finally(() => { sosInFlight.current = false; });
  };
  const needsPermissions = snapshot.permissions === null || !snapshot.permissions.bluetooth ||
    (snapshot.permissions.platform === 'android' && !snapshot.permissions.wifiDirect);
  const selectRoute = (route: AppRoute): void => runtime.navigate(route);

  return <SafeAreaProvider initialMetrics={initialWindowMetrics}>
    <SafeAreaView style={[styles.safeArea, rowStyle]}>
      <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.header}>
        <Text accessibilityRole="header" style={styles.brand}>PalMesh</Text>
        <Text style={styles.secondary}>{t(snapshot.connectedPeers === 1 ? 'common.connectedPeer' : 'common.connectedPeers', { count: snapshot.connectedPeers })}</Text>
        <Text style={styles.caption}>{t('common.securityNotice')}</Text>
      </View>
      <View accessibilityRole="tablist" style={styles.tabs}>
        {(['chat', 'maps', 'emergencies', 'contacts'] as const).map(route => <Pressable key={route} accessibilityRole="tab"
          accessibilityLabel={t(route === 'chat' ? 'app.messages' : route === 'maps' ? 'app.map' : route === 'emergencies' ? 'app.emergencies' : 'app.security')}
          accessibilityState={{ selected: snapshot.route === route, disabled: !ready }} disabled={!ready}
          onPress={() => selectRoute(route)} style={({ pressed }) => [styles.tab, compactTabs && styles.tabCompact, snapshot.route === route && styles.selectedTab, pressed && styles.pressed]}>
          <Text style={styles.tabText}>{t(route === 'chat' ? 'app.messages' : route === 'maps' ? 'app.map' : route === 'emergencies' ? 'app.emergencies' : 'app.security')}</Text>
        </Pressable>)}
      </View>
      {ready && <View style={styles.connections}>
        <Text style={styles.caption}>{t('app.radios', { wifi: radioLabel(snapshot.radios['wifi-direct'], t), bluetooth: radioLabel(snapshot.radios.ble, t) })}</Text>
        {needsPermissions && snapshot.permissions?.canRequest !== false && <Button
          label={t(snapshot.requestingPermissions ? 'app.enabling' : 'app.enable')}
          disabled={snapshot.requestingPermissions} onPress={() => { void runtime.requestPermissions(); }} />}
        {needsPermissions && snapshot.permissions?.canRequest === false &&
          <Text style={styles.caption}>{snapshot.permissions.platform === 'unsupported'
            ? t('app.radiosUnsupported')
            : t('app.permissionsSettings')}</Text>}
      </View>}
      {ready && snapshot.resources?.emergency !== undefined && snapshot.route !== 'emergencies' &&
        <EmergencyBanner service={snapshot.resources.emergency} onOpen={() => selectRoute('emergencies')} />}

      <View style={styles.content}>
        {ready && snapshot.resources !== null && mapsService !== null ? snapshot.route === 'chat' ?
          <ChatProvider service={snapshot.resources.chat} manageLifecycle={false} manageVisibility={false}
            visible={snapshot.foreground}>
            <ChatScreen embedded showSos={false} savedRecipients={snapshot.resources.security?.savedPeerIds() ?? []} />
          </ChatProvider> : snapshot.route === 'maps' ?
          <MapsProvider service={mapsService} manageLifecycle={false} manageVisibility={false}
            visible={snapshot.foreground}>
            <MapsScreen embedded showSos={false} />
          </MapsProvider> : snapshot.route === 'emergencies' ?
            snapshot.resources.emergency !== undefined ? <EmergencyInbox service={snapshot.resources.emergency} /> :
              <Text style={styles.body}>{t('emergency.problem')}</Text> :
            <SecurityScreen runtime={runtime} snapshot={snapshot} /> :
          <ScrollView contentContainerStyle={styles.startup}>
            {snapshot.status === 'starting' || snapshot.status === 'idle' ? <>
              <ActivityIndicator accessibilityLabel={t('app.starting')} color="#ffffff" />
              <Text style={styles.body}>{t('app.startingProgress')}</Text>
              <Text style={styles.secondary}>{t('app.queuesNotReady')}</Text>
            </> : <>
              <Text accessibilityRole="alert" style={styles.body}>{t('app.servicesUnavailable')}</Text>
              <Text accessibilityRole="header" style={styles.body}>{t('app.recovery.title')}</Text>
              <Text style={styles.secondary}>{t(`app.recovery.${snapshot.startupFailure ?? 'unknown'}`)}</Text>
              <Text style={styles.secondary}>{t('app.recovery.preserve')}</Text>
              <Button label={t('app.retry')} onPress={() => { void runtime.start(); }} />
            </>}
          </ScrollView>}
      </View>

      {(snapshot.issue !== null || snapshot.notice !== null) && <ScrollView style={styles.feedback} keyboardShouldPersistTaps="handled">
        {snapshot.issue !== null && <>
          <Text accessibilityRole="alert" accessibilityLiveRegion="assertive" style={styles.body}>{snapshot.issue === 'background-unavailable' ? t('app.backgroundUnavailable') : t(`app.issue.${snapshot.issue}`)}</Text>
          <Button label={t('app.dismissError')} onPress={() => runtime.dismissIssue()} />
        </>}
        {snapshot.notice === 'sos-queued' && <>
          <Text accessibilityLiveRegion="polite" style={styles.body}>{t('app.sosQueued')}</Text>
          <Button label={t('app.dismissSos')} onPress={() => runtime.dismissNotice()} />
        </>}
      </ScrollView>}
      <View style={styles.sosContainer}>
        <Pressable accessibilityRole="button" accessibilityLabel={t('common.sos')}
          accessibilityHint={t('app.cachedGpsHint')}
          accessibilityState={{ disabled: !ready || snapshot.pendingSos, busy: snapshot.pendingSos }} disabled={!ready || snapshot.pendingSos}
          onPress={requestSos} style={({ pressed }) => [styles.sos, (!ready || snapshot.pendingSos) && styles.disabled, pressed && styles.pressed]}>
          <Text style={styles.sosText}>{t(snapshot.pendingSos ? 'common.queueingSos' : 'common.sos')}</Text>
        </Pressable>
        <Text style={styles.caption}>{t('app.cachedGps')}</Text>
      </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  </SafeAreaProvider>;
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#0a1118' },
  screen: { flex: 1 },
  header: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 8, flexShrink: 0 },
  brand: { color: '#ffffff', fontSize: 25, fontWeight: '800', writingDirection: 'auto' },
  body: { color: '#ffffff', fontSize: 16, lineHeight: 24, writingDirection: 'auto' },
  secondary: { color: '#d2dde8', fontSize: 15, lineHeight: 23, writingDirection: 'auto' },
  caption: { color: '#c2d1df', fontSize: 12, lineHeight: 18, writingDirection: 'auto' },
  tabs: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 8, borderBottomWidth: 1, borderBottomColor: '#405264' },
  tab: { flex: 1, minHeight: 48, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 4, paddingVertical: 10, borderBottomWidth: 3, borderBottomColor: 'transparent' },
  tabCompact: { flexBasis: '50%', flexGrow: 0, flexShrink: 0 },
  tabText: { color: '#ffffff', fontSize: 14, fontWeight: '700', textAlign: 'center' },
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
