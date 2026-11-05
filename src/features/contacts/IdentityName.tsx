import React,{useState} from 'react';
import {Modal,Pressable,View,type TextProps} from 'react-native';
import {LocalizedText as Text,useI18n} from '../../shared/i18n';
import {Action,Card,ui,palette} from '../../shared/ui/design';
import {useContactNames} from './ContactNames';

/** Names never replace addresses; every received name can reveal its full key fingerprint. */
export function IdentityName({id,label,style}:{readonly id:string;readonly label?:string;readonly style?:TextProps['style']}):React.JSX.Element {
 const names=useContactNames();const{t}=useI18n();const[open,setOpen]=useState(false);
 const shared=names.origin(id)==='shared';const name=names.label(id);
 return <>
 <Pressable accessibilityRole="button" accessibilityLabel={t('names.openIdentity',{name})} onPress={()=>setOpen(true)} style={{minHeight:44,justifyContent:'center'}}>
  <Text style={style}>{label??name}{shared?` · ${t('names.shared')}`:''}{names.entries.get(id)?.duplicateName?` · ${names.short(id)}`:''}</Text>
 </Pressable>
 <Modal visible={open} transparent animationType="slide" onRequestClose={()=>setOpen(false)}>
  <View style={{flex:1,justifyContent:'center',padding:20,backgroundColor:'#00000099'}} accessibilityViewIsModal>
   <Card><Text accessibilityRole="header" style={ui.heading}>{t('names.identityDetails')}</Text><Text style={ui.text}>{name}</Text>
    <Text selectable style={[ui.fingerprint,{color:palette.ink}]}>{id}</Text>
    <Text style={ui.muted}>{t(`contacts.${names.status(id)}`)}</Text>
    {shared&&<Text style={ui.muted}>{t('names.selfDeclared')}</Text>}{names.origin(id)==='local'&&<Text style={ui.muted}>{t('names.localAnnotation')}</Text>}<Text style={ui.muted}>{t('names.fingerprintHelp')}</Text>
    <Action label={t('names.closeIdentity')} onPress={()=>setOpen(false)}/>
   </Card>
  </View>
 </Modal></>;
}
