import { Action, Disclosure, ui, palette } from '../../../shared/ui/design';
import { useContactNames } from '../../contacts/ContactNames';
import React, { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView, initialWindowMetrics } from 'react-native-safe-area-context';
import { LocalizedText as Text, reportAge, useI18n, type TranslationKey } from '../../../shared/i18n';
import type { LocationIssue, OfflineMapDescriptor, PeerLocation } from '../domain/types';
import { MapsProvider, type MapsUiService, useMaps } from './MapsProvider';
import { OfflineMapView } from './OfflineMapView';

const issueLabels: Readonly<Record<LocationIssue, TranslationKey>> = {
  'storage-unavailable': 'maps.issue.storage-unavailable',
  'gps-denied': 'maps.issue.gps-denied',
  'gps-unavailable': 'maps.issue.gps-unavailable',
  'queue-full': 'maps.issue.queue-full',
  'broadcast-unavailable': 'maps.issue.broadcast-unavailable',
  'routing-error': 'maps.issue.routing-error',
};

function Button({ label, onPress, disabled = false }: {
  readonly label: string; readonly onPress: () => void; readonly disabled?: boolean;
}): React.JSX.Element {
  return <Action label={label} onPress={onPress} disabled={disabled}/>;
}

function PeerReport({ peer, now }: { readonly peer: PeerLocation; readonly now: number }): React.JSX.Element {
  const { t } = useI18n();
  const names=useContactNames();
  return <View style={[styles.peer, peer.origin === 'sos' && styles.sosPeer]}>
    <Text selectable style={styles.peerName}>{peer.origin === 'sos' ? 'SOS · ' : ''}{names.label(peer.deviceId)}</Text>
    <Text selectable style={styles.body}>{t('maps.coordinates', { latitude: peer.location.latitude.toFixed(5), longitude: peer.location.longitude.toFixed(5) })}</Text>
    <Text style={styles.secondary}>{t('maps.fixAge', { age: reportAge(peer.location.timestamp, now, t) })}</Text>
    <Text style={styles.secondary}>{t('maps.reportAge', { age: reportAge(peer.receivedAt, now, t) })}</Text>
  </View>;
}

export interface MapsScreenProps {
  readonly embedded?: boolean;
  readonly showSos?: boolean;
}

export function MapsScreen({ embedded = false, showSos = true }: MapsScreenProps): React.JSX.Element {
  const { t, direction } = useI18n();
  const { snapshot, deviceId, visible, refresh, refreshLocal, shareOnce, setSharing, setPowerMode,
    sendSos, dismissIssue, dismissNotice } = useMaps();
  const [failedDescriptor, setFailedDescriptor] = useState<OfflineMapDescriptor | null>(null);
  const sosInFlight = useRef(false);
  const renderFailed = snapshot.map !== null && failedDescriptor === snapshot.map;
  const reportUnavailable = useCallback(() => setFailedDescriptor(snapshot.map), [snapshot.map]);
  const retry = (): void => { setFailedDescriptor(null); void refresh({ retryMap: true }); };
  const requestSos = (): void => {
    if (sosInFlight.current || snapshot.pendingSos) return;
    sosInFlight.current = true;
    void sendSos().finally(() => { sosInFlight.current = false; });
  };
  const sharingStatus = !snapshot.sharing ? t('maps.sharingOff')
    : !visible ? t('maps.sharingHidden')
      : snapshot.powerMode === 'conserve' ? t('maps.sharingBattery')
        : t('maps.sharingOn');
  // The app shell owns the shared SOS result; embedded maps keep their own
  // location-sharing feedback without repeating that global confirmation.
  const featureNotice = embedded && snapshot.notice === 'sos-queued' ? null : snapshot.notice;

  const Container = embedded ? View : SafeAreaView;
  return <Container style={[styles.safeArea, { direction }]}>
    {!embedded && <View style={styles.header}>
      <Text accessibilityRole="header" style={styles.title}>{t('maps.title')}</Text>
      <Text style={styles.secondary}>{t('maps.subtitle')}</Text>
    </View>}
    <FlatList style={styles.list} data={snapshot.peers} keyExtractor={peer => peer.deviceId}
      renderItem={({ item }) => <PeerReport peer={item} now={snapshot.now} />}
      contentContainerStyle={styles.listContent} keyboardShouldPersistTaps="handled"
      ListHeaderComponent={<>
        {snapshot.mapStatus === 'loading' ? <View style={styles.loading}>
          <ActivityIndicator accessibilityLabel={t('maps.opening')} color={palette.primary} />
          <Text style={styles.body}>{t('maps.openingProgress')}</Text>
        </View> : snapshot.mapStatus !== 'ready' || snapshot.map === null || renderFailed ? <View style={styles.unavailable}>
          <Text accessibilityRole="alert" style={styles.body}>{renderFailed
            ? t('maps.renderError')
            : t('maps.unavailable')}</Text>
          <Button label={t('maps.retry')} onPress={retry} />
        </View> : <>
          <View accessibilityLabel={t('maps.coverage')} style={styles.mapFrame}>
            <OfflineMapView descriptor={snapshot.map} localLocation={snapshot.localLocation}
              peers={snapshot.peers} powerMode={snapshot.powerMode} onUnavailable={reportUnavailable} />
          </View>
          <Text selectable style={styles.attribution}>{snapshot.map.attribution}</Text>
          <Disclosure title={t('ui.details')}><Text style={ui.muted}>{t('maps.legend')}</Text><Text style={ui.muted}>{t('maps.stale')}</Text></Disclosure>
        </>}
        <Disclosure title={t('ui.mapOptions')}>
        <Text style={ui.muted}>{t('maps.stale')}</Text>
        <View style={styles.section}>
          <Text accessibilityRole="header" style={styles.heading}>{t('maps.lastFix')}</Text>
          {snapshot.localLocation === null ? <Text style={styles.body}>{t('maps.noFix')}</Text> : <>
            <Text selectable style={styles.body}>{t('maps.coordinates', { latitude: snapshot.localLocation.latitude.toFixed(5), longitude: snapshot.localLocation.longitude.toFixed(5) })}</Text>
            <Text style={styles.secondary}>{t('maps.fixAge', { age: reportAge(snapshot.localLocation.timestamp, snapshot.now, t) })}</Text>
          </>}
          <Button label={t(snapshot.locating ? 'maps.updatingGps' : 'maps.updateGps')} disabled={snapshot.locating}
            onPress={() => { void refreshLocal(); }} />
          <Button label={t('maps.shareOnce')} disabled={snapshot.locating}
            onPress={() => { void shareOnce(); }} />
          <Text style={styles.explanation}>{t('maps.shareOnceHelp')}</Text>
        </View>
        <View style={styles.section}>
          <View style={styles.setting}>
            <Text style={[styles.body, styles.grow]}>{t('maps.periodic')}</Text>
            <Switch accessibilityLabel={t('maps.periodic')} value={snapshot.sharing}
              trackColor={{ false: '#526272', true: '#2270a2' }} thumbColor="#ffffff"
              onValueChange={value => { void setSharing(value); }} style={styles.switch} />
          </View>
          <Text accessibilityLiveRegion="polite" style={styles.secondary}>{sharingStatus}</Text>
          <Text style={styles.explanation}>{t('maps.privacy')}</Text>
          <View style={styles.setting}>
            <Text style={[styles.body, styles.grow]}>{t('maps.lowBattery')}</Text>
            <Switch accessibilityLabel={t('maps.lowBattery')} value={snapshot.powerMode === 'conserve'}
              trackColor={{ false: '#526272', true: '#2270a2' }} thumbColor="#ffffff"
              onValueChange={value => setPowerMode(value ? 'conserve' : 'normal')} style={styles.switch} />
          </View>
        </View>
        </Disclosure>
        {snapshot.status === 'loading' && <Text style={styles.secondary}>{t('maps.loadingReports')}</Text>}
        <View style={styles.sectionHeading}>
          <Text accessibilityRole="header" style={styles.heading}>{t('maps.peerReports')}</Text>
          <Button label={t('maps.reload')} onPress={() => { void refresh(); }} />
        </View>
      </>}
      ListEmptyComponent={<Text style={styles.empty}>{t('maps.empty')}</Text>} />
    {(snapshot.issue !== null || featureNotice !== null) && <ScrollView style={styles.feedback} keyboardShouldPersistTaps="handled">
      {snapshot.issue !== null && <>
        <Text accessibilityRole="alert" accessibilityLiveRegion="assertive" style={styles.body}>{t(issueLabels[snapshot.issue])}</Text>
        <Button label={t('maps.dismissError')} onPress={dismissIssue} />
      </>}
      {featureNotice !== null && <>
        <Text accessibilityLiveRegion="polite" style={styles.body}>{featureNotice === 'sos-queued'
          ? t('maps.sosQueued')
          : t('maps.locationQueued')}</Text>
        <Button label={t('maps.dismissNotice')} onPress={dismissNotice} />
      </>}
    </ScrollView>}
    {showSos && <View style={styles.sosContainer}>
      <Pressable accessibilityRole="button" accessibilityLabel={t('common.sos')}
        accessibilityHint={t('common.sosGpsHint')}
        accessibilityState={{ disabled: snapshot.pendingSos, busy: snapshot.pendingSos }} disabled={snapshot.pendingSos}
        onPress={requestSos} style={({ pressed }) => [styles.sos, snapshot.pendingSos && styles.disabled, pressed && styles.pressed]}>
        <Text style={styles.sosText}>{t(snapshot.pendingSos ? 'common.queueingSos' : 'common.sos')}</Text>
      </Pressable>
      <Text style={styles.sosHint}>{t('common.cachedGps')}</Text>
    </View>}
  </Container>;
}

export interface PalMeshMapsAppProps {
  readonly service: MapsUiService;
  readonly visible?: boolean;
}

export function PalMeshMapsApp({ service, visible = true }: PalMeshMapsAppProps): React.JSX.Element {
  return <SafeAreaProvider initialMetrics={initialWindowMetrics}>
    <MapsProvider service={service} visible={visible}><MapsScreen /></MapsProvider>
  </SafeAreaProvider>;
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#F4F7F8' },
  header: { padding: 16, borderBottomColor: '#DEE7E9', borderBottomWidth: 1, flexShrink: 0 },
  title: { color: '#18343D', fontSize: 25, fontWeight: '800', writingDirection: 'auto' },
  heading: { color: '#18343D', fontSize: 21, fontWeight: '700', writingDirection: 'auto' },
  body: { color: '#18343D', fontSize: 17, lineHeight: 25, writingDirection: 'auto' },
  secondary: { color: '#536B75', fontSize: 15, lineHeight: 23, writingDirection: 'auto' },
  explanation: { color: '#536B75', fontSize: 14, lineHeight: 21, marginVertical: 8, writingDirection: 'auto' },
  list: { flex: 1, minHeight: 0 },
  listContent: { padding: 16, paddingBottom: 24 },
  section: { marginTop: 18, gap: 8, paddingTop: 14, borderTopColor: '#DEE7E9', borderTopWidth: 1 },
  sectionHeading: { marginTop: 24, gap: 10, marginBottom: 12 },
  loading: { minHeight: 160, justifyContent: 'center', alignItems: 'center', gap: 12 },
  unavailable: { padding: 14, backgroundColor: '#FFF5DA', borderRadius: 8, marginVertical: 12, gap: 10 },
  mapFrame: { height: 340, marginTop: 12, backgroundColor: palette.soft, borderWidth: 1, borderColor: '#DEE7E9', borderRadius: 8, overflow: 'hidden' },
  attribution: { color: '#536B75', fontSize: 12, marginTop: 6, writingDirection: 'auto' },
  button: { minHeight: 48, minWidth: 48, padding: 12, borderRadius: 8, justifyContent: 'center', alignItems: 'center', backgroundColor: '#087F82' },
  buttonText: { color: '#FFFFFF', fontSize: 16, fontWeight: '700', textAlign: 'center', writingDirection: 'auto' },
  setting: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48 },
  grow: { flex: 1 },
  switch: { minWidth: 48, minHeight: 48 },
  peer: { marginVertical: 7, padding: 14, backgroundColor: palette.surface, borderRadius: 8, gap: 7 },
  sosPeer: { borderColor: '#ff6675', borderWidth: 2 },
  peerName: { color: '#18343D', fontSize: 18, fontWeight: '700', writingDirection: 'auto' },
  empty: { color: '#536B75', fontSize: 17, lineHeight: 25, paddingVertical: 16, writingDirection: 'auto' },
  feedback: { padding: 12, backgroundColor: '#E3F3F1', flexGrow: 0, flexShrink: 1, maxHeight: 160 },
  sosContainer: { padding: 12, borderTopColor: '#DEE7E9', borderTopWidth: 1, backgroundColor: '#F4F7F8', flexShrink: 0, zIndex: 1 },
  sos: { minHeight: 68, padding: 14, backgroundColor: '#b91525', borderColor: '#ff919c', borderWidth: 2, borderRadius: 10, justifyContent: 'center', alignItems: 'center' },
  sosText: { color: '#FFFFFF', fontSize: 23, fontWeight: '800', textAlign: 'center', writingDirection: 'auto' },
  sosHint: { color: '#536B75', fontSize: 12, textAlign: 'center', marginTop: 6, writingDirection: 'auto' },
  disabled: { opacity: 0.55 },
  pressed: { opacity: 0.75 },
});
