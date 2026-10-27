import React, { useMemo, useRef, useState } from 'react';
import { NativeModules, Pressable, Share, StyleSheet, TextInput, View } from 'react-native';
import { LocalizedText as Text, useI18n } from '../../shared/i18n';
import { ContactDirectory, parsePublicIdentity, publicIdentityShare, shortIdentity, type ContactEntry, type IdentityDirectory } from './ContactDirectory';
import { useContactNames } from './ContactNames';
import { PublicIdentityQr } from './PublicIdentityQr';
function Action({label,onPress,disabled=false}:{readonly label:string;readonly onPress:()=>void;readonly disabled?:boolean}) {
 return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{disabled}} disabled={disabled} onPress={onPress} style={[styles.button,disabled && {opacity:0.5}]}><Text style={styles.text}>{label}</Text></Pressable>;
}
function ContactRow({entry,service,onOpen}:{readonly entry:ContactEntry;readonly service:ContactDirectory;readonly onOpen:(id:string)=>Promise<void>}) {
 const {t}=useI18n(); const [name,setName]=useState(entry.name); const [full,setFull]=useState(false); const [busy,setBusy]=useState(false);const [failed,setFailed]=useState(false);
 const lock=useRef(false);
 const run=async(operation:()=>Promise<unknown>)=>{if(lock.current)return;lock.current=true;setBusy(true);setFailed(false);try{await operation();}catch{setFailed(true);}finally{lock.current=false;setBusy(false);}};
 return <View style={styles.card}>
  <Text accessibilityRole="header" style={styles.title}>{entry.name || shortIdentity(entry.id)}</Text>
  <Text style={styles.id}>{shortIdentity(entry.id)}</Text>
  <Text style={styles.text}>{t(entry.compared?'contacts.compared':'contacts.saved')}</Text>
  {entry.duplicateName && <Text style={styles.warning}>{t('contacts.duplicate')}</Text>}
  <TextInput accessibilityLabel={`${t('contacts.name')}: ${shortIdentity(entry.id)}`} value={name} onChangeText={setName} maxLength={160} editable={!busy} style={styles.input}/>
  <Action label={t('contacts.saveName')} disabled={busy} onPress={()=>{void run(()=>service.rename(entry.id,name));}}/>
  <Action label={t('contacts.fingerprint')} onPress={()=>setFull(!full)}/>
  {full && <><Text selectable style={styles.id}>{entry.id}</Text><Text style={styles.warning}>{t('app.verifyFingerprint')}</Text><Action label={t(entry.compared?'contacts.uncompare':'contacts.compare')} disabled={busy} onPress={()=>{void run(()=>service.setCompared(entry.id,!entry.compared));}}/></>}
  <Action label={t('contacts.chat')} disabled={busy} onPress={()=>{void run(()=>onOpen(entry.id));}}/>
  {failed && <Text accessibilityRole="alert" style={styles.warning}>{t('contacts.error')}</Text>}
 </View>;
}
export function ContactsExperience({service,security,onOpen}:{readonly service:ContactDirectory;readonly security:IdentityDirectory;readonly onOpen:(id:string)=>Promise<void>}) {
 const {t}=useI18n();const {state}=useContactNames();
 const [profile,setProfile]=useState(state.profileName);const [name,setName]=useState('');const [input,setInput]=useState('');const [advanced,setAdvanced]=useState(false);const [qr,setQr]=useState(false);const [search,setSearch]=useState('');const [limit,setLimit]=useState(25);
 const [busy,setBusy]=useState(false);const lock=useRef(false);const [notice,setNotice]=useState<'error'|'partial'|'existing'|'savedNotice'|null>(null);
 const payload=useMemo(()=>publicIdentityShare(security.publicIdentity,security.deviceId),[security]);
 const preview=useMemo(()=>{try{return parsePublicIdentity(input).id;}catch{return null;}},[input]);
 const run=async(operation:()=>Promise<void>)=>{if(lock.current)return;lock.current=true;setBusy(true);setNotice(null);try{await operation();}catch{setNotice('error');}finally{lock.current=false;setBusy(false);}};
 const scan=async()=>{const native=NativeModules.PalMeshPublicQr as {scanImage?:()=>Promise<string|null>}|undefined;if(!native?.scanImage)throw new Error('Unavailable');const text=await native.scanImage();if(text===null)return;const candidate=parsePublicIdentity(text);setInput(publicIdentityShare(candidate.identity,candidate.id));};
 const contacts=state.contacts.filter(entry=>`${entry.name} ${entry.id}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
 return <View style={styles.container}>
  <Text accessibilityRole="header" style={styles.title}>{t('app.myFingerprint')}</Text><Text selectable accessibilityLabel={t('app.myFingerprint')} style={styles.id}>{security.deviceId}</Text>
  <Text style={styles.warning}>{t('contacts.guide')}</Text>
  <TextInput accessibilityLabel={t('contacts.profile')} value={profile} onChangeText={setProfile} maxLength={160} editable={!busy && state.loaded} style={styles.input}/>
  <Action label={t('contacts.saveProfile')} disabled={busy || !state.loaded} onPress={()=>{void run(async()=>{await service.setProfileName(profile);setNotice('savedNotice');});}}/>
  <Action label={t(qr?'contacts.hideQr':'contacts.qr')} onPress={()=>setQr(!qr)}/>
  {qr && <PublicIdentityQr payload={payload} label={t('contacts.qr')}/>}
  <Action label={t('contacts.share')} disabled={busy} onPress={()=>{void run(async()=>{await Share.share({message:JSON.stringify(security.publicIdentity)});});}}/>
  <Text selectable accessibilityLabel={t('app.publicIdentity')} style={styles.id}>{JSON.stringify(security.publicIdentity)}</Text>
  <Text accessibilityRole="header" style={styles.title}>{t('app.contactImport')}</Text>
  <Text style={styles.text}>{t('contacts.scanHelp')}</Text>
  <Action label={t('contacts.scan')} disabled={busy} onPress={()=>{void run(scan);}}/>
  <Action label={t('contacts.paste')} onPress={()=>setAdvanced(!advanced)}/>
  {advanced && <TextInput accessibilityLabel={t('app.contactJson')} value={input} onChangeText={setInput} multiline maxLength={2048} autoCapitalize="none" autoCorrect={false} editable={!busy} style={[styles.input,styles.id]}/>}
  {preview && <><Text style={styles.text}>{t('contacts.preview')}</Text><Text selectable style={styles.id}>{preview}</Text></>}
  <TextInput accessibilityLabel={t('contacts.name')} value={name} onChangeText={setName} maxLength={160} editable={!busy} style={styles.input}/>
  <Action label={t('app.importContact')} disabled={busy || !preview} onPress={()=>{void run(async()=>{const result=await service.add(input,name);setNotice(result.alreadySaved?'existing':result.nameSaved?'savedNotice':'partial');if(result.nameSaved){setInput('');setName('');}});}}/>
  {notice && <Text accessibilityRole={notice==='error'||notice==='partial'?'alert':undefined} accessibilityLiveRegion="polite" style={styles.warning}>{t(`contacts.${notice}`)}</Text>}
  {!state.loaded && <><Text accessibilityRole="alert" style={styles.warning}>{t('contacts.unavailable')}</Text><Action label={t('contacts.retry')} disabled={busy} onPress={()=>{void run(async()=>{await service.initialize();setProfile(service.getSnapshot().profileName);});}}/></>}
  <Text accessibilityRole="header" style={styles.title}>{t('contacts.list')}</Text>
  <TextInput accessibilityLabel={t('contacts.search')} value={search} onChangeText={value=>{setSearch(value);setLimit(25);}} maxLength={128} style={styles.input}/>
  {contacts.length===0 && <Text style={styles.text}>{t('contacts.empty')}</Text>}
  {contacts.slice(0,limit).map(entry=><ContactRow key={entry.id} entry={entry} service={service} onOpen={onOpen}/>)}
  {contacts.length>limit && <Action label={t('contacts.more')} onPress={()=>setLimit(limit+25)}/>}
 </View>;
}
const styles=StyleSheet.create({container:{gap:12},card:{gap:10,borderTopWidth:1,borderColor:'#405264',paddingVertical:16},title:{color:'#fff',fontSize:18,fontWeight:'700'},text:{color:'#e4edf5',fontSize:16,lineHeight:23},warning:{color:'#ffe1a6',fontSize:16,lineHeight:23},id:{color:'#cceaff',fontSize:14,lineHeight:21,writingDirection:'ltr',textAlign:'left'},input:{color:'#fff',backgroundColor:'#182b3d',minHeight:48,padding:12,borderWidth:1,borderColor:'#80b6d6',borderRadius:6,fontSize:16},button:{backgroundColor:'#164c74',minHeight:48,justifyContent:'center',padding:12,borderRadius:6}});
