import React, { useState, useSyncExternalStore } from 'react';
import { View } from 'react-native';
import { LocalizedText as Text, useI18n } from '../../shared/i18n';
import { Action, Avatar, Card, Field, Icon, Screen, ui } from '../../shared/ui/design';
import { useContactNames } from '../contacts/ContactNames';
import type { OnboardingPreferences } from './OnboardingPreferences';
export function OnboardingScreen({preferences,onDone}:{readonly preferences:OnboardingPreferences;readonly onDone:()=>void}) {
 const {t}=useI18n();const {service,state}=useContactNames();const [step,setStep]=useState(0);const [name,setName]=useState(state.profileName);const [error,setError]=useState(false);const [busy,setBusy]=useState(false);
 const finish=async()=>{if(busy)return;setBusy(true);setError(false);try{await preferences.finish();onDone();}catch{setError(true);}finally{setBusy(false);}};
 const next=async()=>{if(busy)return;if(step===2){await finish();return;}setBusy(true);setError(false);try{if(step===1&&name.trim()&&service)await service.setProfileName(name);setStep(step+1);}catch{setError(true);}finally{setBusy(false);}};
 return <Screen title={t(step===0?'ui.welcome':step===1?'ui.makeYours':'ui.staySafe')}><View style={{paddingVertical:16}}><Icon name={step===0?'message':step===1?'profile':'people'} size={56}/></View>{step===0?<><Text style={ui.text}>{t('ui.welcomeBody')}</Text><Card><Text style={ui.muted}>{t('ui.queueIntro')}</Text></Card></>:step===1?<><Avatar name={name} size={72}/><Field label={t('ui.name')} placeholder={t('ui.nameHint')} value={name} onChangeText={setName} maxLength={160}/><Text style={ui.muted}>{t('ui.nameOptional')}</Text></>:<><Card><Icon name="qr"/><Text style={ui.text}>{t('ui.qrIntro')}</Text></Card><Card><Icon name="help"/><Text style={ui.heading}>{t('ui.sosInfo')}</Text><Text style={ui.text}>{t('ui.sosHint')}</Text></Card></>}{error&&<Text accessibilityRole="alert" style={ui.error}>{t('ui.preferencesError')}</Text>}<Action label={t(step===2?'ui.getStarted':'ui.next')} variant="primary" disabled={busy} onPress={()=>{void next();}}/><Action label={t('ui.skip')} variant="ghost" disabled={busy} onPress={()=>{void finish();}}/><Text style={ui.muted}>{step+1} / 3</Text></Screen>;
}
export function FirstRun({preferences,children}:{readonly preferences:OnboardingPreferences|undefined;readonly children:React.ReactNode}) {
 const state=useSyncExternalStore(preferences?.subscribe??(()=>()=>{}),preferences?.getSnapshot??(()=>EMPTY),preferences?.getSnapshot??(()=>EMPTY));const [dismissed,setDismissed]=useState(false);
 return preferences&&state.loaded&&!state.complete&&!dismissed?<OnboardingScreen preferences={preferences} onDone={()=>setDismissed(true)}/>:<>{children}</>;
}
const EMPTY=Object.freeze({loaded:true,complete:true,error:false});
