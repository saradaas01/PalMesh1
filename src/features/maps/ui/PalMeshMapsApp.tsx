import { Action, Disclosure, ui, palette } from '../../../shared/ui/design';
import { useContactNames } from '../../contacts/ContactNames';
import React, { useCallback, useRef, useState, useEffect, useSyncExternalStore, useMemo } from 'react';
import { ActivityIndicator, FlatList, Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView, initialWindowMetrics } from 'react-native-safe-area-context';
import { LocalizedText as Text, reportAge, useI18n, type TranslationKey } from '../../../shared/i18n';
import type { LocationIssue, OfflineMapDescriptor, PeerLocation } from '../domain/types';
import { MapsProvider, type MapsUiService, useMaps } from './MapsProvider';
import type {EmergencyUiService} from '../../emergency/ui/EmergencyInbox';
import type {EmergencySnapshot,EmergencyEntry} from '../../emergency/domain/types';
import {insideCoverage,sosLocation,type MapFocus} from '../domain/emergencyMap';
import {SosMapDetails,LocationDetails} from './LocationDetails';
import { OfflineMapView } from './OfflineMapView';

const issueLabels: Readonly<Record<LocationIssue, TranslationKey>> = {
  'storage-unavailable': 'maps.issue.storage-unavailable',
  'gps-denied': 'maps.issue.gps-denied',
  'gps-disabled': 'maps.issue.gps-disabled',
  'gps-timeout': 'maps.issue.gps-timeout',
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

function PeerReport({ peer, now, onView }: { readonly peer: PeerLocation; readonly now: number; readonly onView:()=>void }): React.JSX.Element {
  const { t } = useI18n();
  const names=useContactNames();
  return <View style={[styles.peer, peer.origin === 'sos' && styles.sosPeer]}>
    <Text selectable style={styles.peerName}>{peer.origin === 'sos' ? 'SOS · ' : ''}{names.label(peer.deviceId)}</Text>
    <LocationDetails location={peer.location} now={now}/><Action label={t('emMap.view')} onPress={onView}/>
    <Text style={ui.muted}>{t('emMap.notLive')}</Text>
    <Text style={styles.secondary}>{t('maps.reportAge', { age: reportAge(peer.receivedAt, now, t) })}</Text>
  </View>;
}

type MapListItem={readonly kind:'sos';readonly entry:EmergencyEntry}|{readonly kind:'peer';readonly peer:PeerLocation}|{readonly kind:'peers-title'};
export interface MapsScreenProps {
  readonly embedded?: boolean;
  readonly showSos?: boolean;
  readonly emergency?: EmergencyUiService | undefined;
  readonly focusSosId?: string | null;
}

const EMPTY_EMERGENCY:EmergencySnapshot=Object.freeze({status:'ready',entries:Object.freeze([]),urgent:null,pendingResponseIds:Object.freeze([]),issue:null,now:0});
const noSubscribe=()=>()=>{};const emptyEmergency=()=>EMPTY_EMERGENCY;
export function MapsScreen({ embedded = false, showSos = true, emergency, focusSosId = null }: MapsScreenProps): React.JSX.Element {
  const { t, direction } = useI18n();
  const { snapshot, service, deviceId, visible, refresh, refreshLocal, shareOnce, setSharing, setPowerMode,
    sendSos, dismissIssue, dismissNotice, cancelLocation } = useMaps();
  const emergencies=useSyncExternalStore(emergency?.subscribe??noSubscribe,emergency?.getSnapshot??emptyEmergency,emergency?.getSnapshot??emptyEmergency);
  const sharedPeers=useMemo(()=>snapshot.peers.filter(p=>p.origin==='location'),[snapshot.peers]);
  const incomingSos=useMemo(()=>emergencies.entries.filter(e=>!e.outgoing),[emergencies.entries]);
  const items=useMemo<MapListItem[]>(()=>[...incomingSos.map(entry=>({kind:'sos' as const,entry})),...(sharedPeers.length?[{kind:'peers-title' as const},...sharedPeers.map(peer=>({kind:'peer' as const,peer}))]:[])],[incomingSos,sharedPeers]);
  const [focus,setFocus]=useState<MapFocus|null>(null);
  const [selectedSos,setSelectedSos]=useState<string|null>(focusSosId);
  const [outside,setOutside]=useState(false);const revision=useRef(0);const list=useRef<FlatList<MapListItem>>(null);
  const focusPoint=(id:string,location:MapFocus['location'])=>{const valid=!!snapshot.map&&insideCoverage(location,snapshot.map);setOutside(!valid);if(valid)setFocus({id,location,revision:++revision.current});else setFocus(null);list.current?.scrollToOffset({offset:0,animated:false});};
  const viewSos=(id:string)=>{const entry=emergencies.entries.find(e=>e.id===id);const location=entry&&sosLocation(entry,snapshot.now);setSelectedSos(id);if(location)focusPoint('sos:'+id,location);};
  const handled=useRef<string|null>(null);
  useEffect(()=>{if(focusSosId&&snapshot.map&&handled.current!==focusSosId&&emergencies.entries.some(e=>e.id===focusSosId)){handled.current=focusSosId;viewSos(focusSosId);}},[focusSosId,snapshot.map,emergencies.entries]);
  const myLocation=async()=>{if(snapshot.localLocation)focusPoint('local',snapshot.localLocation);const result=await refreshLocal();if(result.status==='updated'){const location=service.getSnapshot().localLocation;if(location)focusPoint('local',location);}};
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
    <FlatList ref={list} style={styles.list} data={items} keyExtractor={item=>item.kind==='sos'?'sos:'+item.entry.id:item.kind==='peer'?'peer:'+item.peer.messageId:'peers-title'}
      renderItem={({item})=>item.kind==='sos'?<SosMapDetails entry={item.entry} now={snapshot.now} onView={viewSos}/>:item.kind==='peers-title'?<Text accessibilityRole="header" style={ui.heading}>{t('maps.peerReports')}</Text>:<PeerReport peer={item.peer} now={snapshot.now} onView={()=>{setSelectedSos(null);focusPoint('peer:'+item.peer.messageId,item.peer.location);}}/>}
      contentContainerStyle={styles.listContent} keyboardShouldPersistTaps="handled"
      ListHeaderComponent={<>
        <Text accessibilityRole="header" style={ui.title}>{t('emMap.title')}</Text>
        <Action label={t(snapshot.locating?'maps.updatingGps':'emMap.mine')} variant="primary" disabled={snapshot.locating} onPress={()=>{void myLocation();}}/>
        {snapshot.locating&&<><Text accessibilityLiveRegion="polite" style={ui.muted}>{t('emMap.acquiring')}</Text><Action label={t('emMap.cancel')} onPress={cancelLocation}/></>}
        {snapshot.localLocation?<LocationDetails location={snapshot.localLocation} now={snapshot.now} quality={snapshot.localQuality}/>:<Text style={ui.muted}>{t('maps.noFix')}</Text>}
        {outside&&<Text accessibilityRole="alert" style={ui.error}>{t('emMap.outside')}</Text>}

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
              peers={sharedPeers} emergencies={emergencies.entries.filter(e=>!e.outgoing||e.id===selectedSos)} focus={focus} onSelect={id=>{if(id.startsWith('sos:'))viewSos(id.slice(4));else if(id==='local'&&snapshot.localLocation){setSelectedSos(null);focusPoint(id,snapshot.localLocation);}else{const peer=snapshot.peers.find(p=>'peer:'+p.messageId===id);if(peer){setSelectedSos(null);focusPoint(id,peer.location);}}}} powerMode={snapshot.powerMode} onUnavailable={reportUnavailable} />
          </View>
          <Text selectable style={styles.attribution}>{snapshot.map.attribution}</Text>
          <Disclosure title={t('ui.details')}><Text style={ui.muted}>{t('maps.legend')}</Text><Text style={ui.muted}>{t('maps.stale')}</Text></Disclosure>
        </>}
        {focus?.id.startsWith('peer:')&&snapshot.peers.filter(p=>'peer:'+p.messageId===focus.id).map(peer=><PeerReport key={'selected:'+peer.messageId} peer={peer} now={snapshot.now} onView={()=>focusPoint(focus.id,peer.location)}/>)}
        {selectedSos&&emergencies.entries.filter(e=>e.id===selectedSos).map(entry=><SosMapDetails key={'selected:'+entry.id} entry={entry} now={snapshot.now}/>)}
        <Disclosure title={t('ui.mapOptions')}>
        <Text accessibilityRole="header" style={ui.heading}>{t('emMap.privacy')}</Text>

        <Text style={ui.muted}>{t('maps.stale')}</Text>
        <View style={styles.section}>
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
          <Text accessibilityRole="header" style={styles.heading}>{t('emMap.sosList')}</Text>
          {incomingSos.length===0&&<Text style={ui.muted}>{t('emMap.noSos')}</Text>}
          {emergencies.status==='error'&&<Text accessibilityRole="alert" style={ui.error}>{t('emergency.problem')}</Text>}
          <Button label={t('maps.reload')} onPress={() => { void refresh();void emergency?.refresh(); }} />
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
