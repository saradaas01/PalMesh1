import React, {useRef,useState} from 'react';
import {Switch,View} from 'react-native';
import {LocalizedText as Text,useI18n} from '../../shared/i18n';
import {Action,Disclosure,ui} from '../../shared/ui/design';
import {useContactNames} from './ContactNames';

/** Public profile sharing is optional and never implied by entering a local name. */
export function NameSharingControls():React.JSX.Element|null {
 const {t}=useI18n();const {service,state}=useContactNames();const sharing=state.nameSharing;
 const [queued,setQueued]=useState(false);const [failed,setFailed]=useState(false);const lock=useRef(false);
 if(!service||!sharing)return null;
 const run=async(operation:()=>Promise<void>)=>{if(lock.current)return;lock.current=true;setQueued(false);setFailed(false);try{await operation();setQueued(true);}catch{setFailed(true);}finally{lock.current=false;}};
 return <>
 {(sharing.error||failed)&&<Text accessibilityRole="alert" style={ui.error}>{t('names.sharingError')}</Text>}
 <Disclosure title={t('names.sharingTitle')}>
  <Text style={ui.muted}>{t('names.publicHelp')}</Text>
  <View style={ui.row}><Text style={[ui.text,ui.grow]}>{t('names.sharePublic')}</Text><Switch accessibilityLabel={t('names.sharePublic')}
   value={sharing.sharingEnabled} disabled={!sharing.loaded||sharing.busy||(!state.profileName&&!sharing.sharingEnabled)}
   onValueChange={enabled=>{void run(()=>service.setNameSharing(enabled));}}/></View>
  {!state.profileName&&<Text style={ui.muted}>{t('names.needName')}</Text>}
  <Text style={ui.muted}>{t('names.selfDeclared')}</Text>
  {(sharing.error||failed)&&<Action label={t('names.retry')} disabled={sharing.busy||!sharing.loaded} onPress={()=>{void run(()=>service.retryNameSharing());}}/>}
  {queued&&<Text accessibilityLiveRegion="polite" style={ui.notice}>{t('names.queued')}</Text>}
 </Disclosure></>;
}
