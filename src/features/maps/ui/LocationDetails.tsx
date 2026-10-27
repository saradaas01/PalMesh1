import React from 'react';
import {View} from 'react-native';
import {LocalizedText as Text,reportAge,useI18n} from '../../../shared/i18n';
import {Action,Card,Disclosure,ui} from '../../../shared/ui/design';
import {useContactNames} from '../../contacts/ContactNames';
import type {EmergencyEntry} from '../../emergency/domain/types';
import type {LocationFix} from '../../dtn/domain/types';
import type {LocationQuality} from '../domain/types';
import {sosLocation} from '../domain/emergencyMap';
export function LocationDetails({location,now,quality}:{readonly location:LocationFix;readonly now:number;readonly quality?:LocationQuality|undefined}) {
 const {t}=useI18n();return <View style={{gap:6}}><Text style={ui.muted}>{t('maps.fixAge',{age:reportAge(location.timestamp,now,t)})}</Text>
 {now-location.timestamp>=15*60000&&<Text style={ui.error}>{t('emMap.old')}</Text>}
 <Text style={ui.muted}>{quality?.timestamp===location.timestamp&&typeof quality.accuracyMeters==='number'?t(quality.approximate?'emMap.approximate':'emMap.accuracy',{meters:Math.ceil(quality.accuracyMeters)}):t('emMap.unknownAccuracy')}</Text>
 <Disclosure title={t('emMap.coordinates')}><Text selectable style={ui.fingerprint}>{t('maps.coordinates',{latitude:location.latitude.toFixed(5),longitude:location.longitude.toFixed(5)})}</Text></Disclosure></View>;
}
export function SosMapDetails({entry,now,onView}:{readonly entry:EmergencyEntry;readonly now:number;readonly onView?:((id:string)=>void)|undefined}){
 const {t,language}=useI18n();const names=useContactNames();const fix=sosLocation(entry,now);
 const reported=new Date(entry.createdAt).toLocaleString(language==='ar'?'ar-PS':'en-GB',{timeZone:'Asia/Hebron',year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
 return <Card><Text accessibilityRole="header" style={ui.heading}>{entry.outgoing?t('emergency.outgoing'):names.label(entry.source)}</Text><Text selectable style={ui.text}>{entry.text}</Text><Text style={ui.muted}>{t('emMap.reported',{time:reported})}</Text>
 {fix?<><LocationDetails location={fix} now={now}/>{onView&&<Action label={t('emMap.view')} onPress={()=>onView(entry.id)}/>}</>:<Text style={ui.muted}>{t('emMap.unavailable')}</Text>}
 <Text style={ui.muted}>{t('emMap.notLive')}</Text></Card>;
}
