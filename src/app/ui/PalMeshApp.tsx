import { ContactNamesProvider } from '../../features/contacts/ContactNames';
import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, AppState, BackHandler, Keyboard, KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, StatusBar, StyleSheet, View, useWindowDimensions } from 'react-native';
import { SafeAreaProvider, SafeAreaView, initialWindowMetrics, useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChatProvider, ChatScreen } from '../../features/chat/ui';
import { MapsProvider, MapsScreen, type MapsUiService } from '../../features/maps/ui';
import type { RadioStatus } from '../../features/mesh';
import { EmergencyBanner, EmergencyInbox } from '../../features/emergency/ui';
import { LocalizedText as Text, useI18n, type Translate } from '../../shared/i18n';
import { SecurityScreen } from './SecurityScreen';
import { SettingsScreen } from './SettingsScreen';
import { ContactsExperienceV2, ProfileExperience } from '../../features/contacts/IdentityExperience';
import { useContactNames } from '../../features/contacts/ContactNames';
import { FirstRun } from '../../features/onboarding/OnboardingScreen';
import { Action, Avatar, Card, Icon, Screen, ui, palette } from '../../shared/ui/design';
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
    refresh: options => locations.refresh(options), refreshLocal: () => locations.refreshLocal(), cancelLocation: () => locations.cancelLocation?.(),
    shareOnce: () => locations.shareOnce(), setSharing: sharing => locations.setSharing(sharing),
    setPowerMode: mode => runtime.setPowerMode(mode),
    sendSos: () => locations.sendSos(), dismissIssue: () => locations.dismissIssue(),
    dismissNotice: () => locations.dismissNotice(),
  }, [locations, runtime]);
}

export function PalMeshApp({ runtime }: PalMeshAppProps): React.JSX.Element {
  const { t, rowStyle } = useI18n();
  const { width, fontScale } = useWindowDimensions();
  const compactTabs = fontScale > 1.4;
  const subscribe = useCallback((listener: () => void) => runtime.subscribe(listener), [runtime]);
  const getSnapshot = useCallback(() => runtime.getSnapshot(), [runtime]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const [focusSosId,setFocusSosId]=useState<string|null>(null);
  const [emergencyLink,setEmergencyLink]=useState(false);
  useEffect(()=>{const open=(url:string|null|undefined)=>{if(url==='palmesh://emergencies')setEmergencyLink(true);};void Promise.resolve(Linking.getInitialURL()).then(open).catch(()=>{});const link=Linking.addEventListener('url',event=>open(event.url));return()=>link.remove();},[]);
  const [keyboardVisible,setKeyboardVisible]=useState(false);
  useEffect(()=>{const show=Keyboard.addListener('keyboardDidShow',()=>setKeyboardVisible(true));const hide=Keyboard.addListener('keyboardDidHide',()=>setKeyboardVisible(false));return()=>{show.remove();hide.remove();};},[]);
  useEffect(()=>{const back=BackHandler.addEventListener('hardwareBackPress',()=>{if(['profile','settings','emergencies'].includes(snapshot.route)){runtime.navigate('more');return true;}return false;});return()=>back.remove();},[snapshot.route,runtime]);
  const sosInFlight = useRef(false);
  const mapsService = useMapsService(snapshot.resources, runtime);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => runtime.setForeground(state === 'active'));
    runtime.setForeground(AppState.currentState === 'active');
    void runtime.start();
    return () => { subscription.remove(); void runtime.stop(); };
  }, [runtime]);
  const ready = snapshot.status === 'ready' && snapshot.resources !== null && mapsService !== null;
  useEffect(()=>{if(ready&&emergencyLink){runtime.navigate('emergencies');setEmergencyLink(false);}},[ready,emergencyLink,runtime]);
  const requestSos = (): void => {
    if (!ready || sosInFlight.current || snapshot.pendingSos) return;
    sosInFlight.current = true;
    void runtime.sendSos(t('emergency.newHelp')).finally(() => { sosInFlight.current = false; });
  };
  const needsPermissions = snapshot.permissions === null || !snapshot.permissions.bluetooth ||
    (snapshot.permissions.platform === 'android' && !snapshot.permissions.wifiDirect);
  const selectRoute = (route: AppRoute): void => runtime.navigate(route);

  return <SafeAreaProvider initialMetrics={initialWindowMetrics}>
    <ContactNamesProvider service={snapshot.resources?.contacts}>
    <SafeAreaView style={[styles.safeArea, rowStyle]}>
      <StatusBar barStyle="dark-content"/>
      <KeyboardFrame>
      <View style={styles.header}>
        <View style={ui.grow}><Text accessibilityRole="header" style={styles.brand}>PalMesh</Text><Text style={styles.caption}>{t('ui.offline')}</Text></View>
        <Pressable accessibilityRole="button" accessibilityLabel={t('common.sos')} accessibilityHint={t('ui.sosHint')}
          accessibilityState={{disabled:!ready||snapshot.pendingSos,busy:snapshot.pendingSos}} disabled={!ready||snapshot.pendingSos} onPress={requestSos} style={styles.sos}>
          <Text style={styles.sosText}>{t(snapshot.pendingSos?'common.queueingSos':'ui.sos')}</Text>
        </Pressable>
      </View>
      {ready && snapshot.resources?.emergency !== undefined && snapshot.route !== 'emergencies' &&
        <EmergencyBanner service={snapshot.resources.emergency} onOpen={() => selectRoute('emergencies')} />}

      <View style={styles.content}>
        <FirstRun preferences={ready?snapshot.resources?.onboarding:undefined}>
        {ready && snapshot.resources !== null && mapsService !== null ? snapshot.route === 'chat' ?
          <ChatProvider service={snapshot.resources.chat} manageLifecycle={false} manageVisibility={false}
            visible={snapshot.foreground}>
            <ChatScreen embedded showSos={false} savedRecipients={snapshot.resources.security?.savedPeerIds() ?? []}
              onOpenContacts={() => selectRoute('contacts')} />
          </ChatProvider> : snapshot.route === 'maps' ?
          <MapsProvider service={mapsService} manageLifecycle={false} manageVisibility={false}
            visible={snapshot.foreground}>
            <MapsScreen embedded showSos={false} emergency={snapshot.resources.emergency} focusSosId={focusSosId} />
          </MapsProvider> : snapshot.route === 'emergencies' ?
            snapshot.resources.emergency !== undefined ? <EmergencyInbox service={snapshot.resources.emergency} onViewMap={id=>{setFocusSosId(id);selectRoute('maps');}} /> :
              <Text style={styles.body}>{t('emergency.problem')}</Text> :
            snapshot.route === 'contacts' && snapshot.resources.contacts ? <ContactsExperienceV2 onOpen={async id=>{await snapshot.resources!.chat.openConversation(id);selectRoute('chat');}} onProfile={()=>selectRoute('profile')}/> :
            snapshot.route === 'profile' && snapshot.resources.security ? <ProfileExperience security={snapshot.resources.security}/> :
            snapshot.route === 'settings' ? <SettingsScreen runtime={runtime} snapshot={snapshot}/> :
            snapshot.route === 'more' ? <MoreScreen snapshot={snapshot} navigate={selectRoute}/> :
            <SecurityScreen runtime={runtime} snapshot={snapshot} /> :
          <ScrollView contentContainerStyle={styles.startup}>
            {snapshot.status === 'starting' || snapshot.status === 'idle' ? <>
              <ActivityIndicator accessibilityLabel={t('app.starting')} color={palette.primary} />
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
        </FirstRun>
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
      {!keyboardVisible && <View accessibilityRole="tablist" style={styles.tabs}>
        {(['chat','contacts','maps','more'] as const).map((route,index)=><Pressable key={route} accessibilityRole="tab" accessibilityLabel={t((['ui.messages','ui.contacts','ui.map','ui.more'] as const)[index]!)} disabled={!ready} accessibilityState={{disabled:!ready,selected:snapshot.route===route||route==='more'&&['profile','settings','emergencies'].includes(snapshot.route)}} onPress={()=>selectRoute(route)} style={[styles.tab,compactTabs&&styles.tabCompact,(snapshot.route===route||route==='more'&&['profile','settings','emergencies'].includes(snapshot.route))&&styles.selectedTab]}><Icon name={(['message','people','map','more'] as const)[index]!} color={snapshot.route===route?palette.primary:palette.muted}/><Text style={styles.tabText}>{t((['ui.messages','ui.contacts','ui.map','ui.more'] as const)[index]!)}</Text></Pressable>)}
      </View>}
      </KeyboardFrame>
    </SafeAreaView>
    </ContactNamesProvider>
  </SafeAreaProvider>;
}

function KeyboardFrame({children}:{readonly children:React.ReactNode}) {
 const insets=useSafeAreaInsets();
 return <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS==='ios'?'padding':'height'} keyboardVerticalOffset={insets.top}>{children}</KeyboardAvoidingView>;
}
function MoreScreen({snapshot,navigate}:{readonly snapshot:ReturnType<AppUiRuntime['getSnapshot']>;readonly navigate:(route:AppRoute)=>void}) {
 const {t}=useI18n();const {state}=useContactNames();return <Screen title={t('ui.more')}><Card><View style={ui.row}><Avatar name={state.profileName}/><View style={ui.grow}><Text style={ui.heading}>{state.profileName||t('ui.profile')}</Text><Text style={ui.muted}>{t('ui.offline')}</Text></View></View><Action label={t('ui.profile')} icon="profile" onPress={()=>navigate('profile')}/></Card><Action label={t('ui.settings')} icon="settings" onPress={()=>navigate('settings')}/><Action label={t('ui.helpInbox')} icon="help" onPress={()=>navigate('emergencies')}/><Card><Text style={ui.heading}>{t('ui.sosInfo')}</Text><Text style={ui.muted}>{t('ui.sosHint')}</Text></Card></Screen>;
}
const styles=StyleSheet.create({safeArea:{flex:1,backgroundColor:palette.background},screen:{flex:1},header:{paddingHorizontal:20,paddingVertical:10,flexDirection:'row',alignItems:'center',gap:16,borderBottomWidth:1,borderColor:palette.line,backgroundColor:palette.surface},brand:{fontSize:20,fontWeight:'800',color:palette.ink},caption:{fontSize:12,lineHeight:18,color:palette.primary},body:{fontSize:16,lineHeight:24,color:palette.ink},secondary:{fontSize:15,lineHeight:23,color:palette.muted},content:{flex:1,minHeight:0},startup:{flexGrow:1,justifyContent:'center',padding:24,gap:18},sos:{minHeight:48,minWidth:64,justifyContent:'center',alignItems:'center',paddingHorizontal:16,paddingVertical:10,borderRadius:14,backgroundColor:palette.danger},sosText:{fontSize:16,fontWeight:'800',color:'#FFFFFF',textAlign:'center'},tabs:{flexDirection:'row',flexWrap:'wrap',borderTopWidth:1,borderColor:palette.line,backgroundColor:palette.surface},tab:{flex:1,minHeight:64,paddingVertical:10,paddingHorizontal:4,gap:4,alignItems:'center',justifyContent:'center'},tabCompact:{flexBasis:'50%',flexGrow:0,flexShrink:0,flexDirection:'row'},tabText:{fontSize:13,fontWeight:'600',color:palette.ink,textAlign:'center'},selectedTab:{backgroundColor:palette.soft},button:{minHeight:48,padding:12,borderRadius:12,backgroundColor:palette.primary},buttonText:{fontSize:16,color:'#FFFFFF',fontWeight:'700',textAlign:'center'},feedback:{maxHeight:160,flexShrink:1,padding:12,backgroundColor:palette.warningSoft},disabled:{opacity:0.5},pressed:{opacity:0.75}});
