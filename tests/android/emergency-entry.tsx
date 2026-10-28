/** Emulator-only alternate entry point. Never imported by index.js or an ARM64 build. */
import 'react-native-get-random-values';
import React from 'react';
import {AppRegistry,NativeModules,Text,View} from 'react-native';
import {AppRuntime} from '../../src/app/application/AppRuntime';
import {createNativeResources} from '../../src/app/infrastructure/createNativeResources';
import {createReactNativeRadioPermissions} from '../../src/app/infrastructure/reactNativePermissions';
import {createReactNativeMeshRuntime} from '../../src/app/infrastructure/reactNativeRuntime';
import {PalMeshApp} from '../../src/app/ui/PalMeshApp';
import {I18nProvider} from '../../src/shared/i18n';
import {NativeSecurityVault,SecurityService} from '../../src/features/security';
import {createMessage} from '../../src/features/dtn/domain/validation';
import type {DtnEngine} from '../../src/features/dtn/application/DtnEngine';
const FIXTURE='PALMESH_SYNTHETIC_EMERGENCY_ONLY';
const IDS=['80111111-1111-4111-8111-111111111111','80222222-2222-4222-8222-222222222222','80333333-3333-4333-8333-333333333333'];
const permissions=createReactNativeRadioPermissions();const platformRuntime=createReactNativeMeshRuntime();
const runtime=new AppRuntime({permissions,platformRuntime,initiallyForeground:false,createResources:async()=>{
 const resources=await createNativeResources({permissions,alerts:platformRuntime});const engine=resources.node.engine as DtnEngine;await engine.start();
 if(!(await engine.history()).some(r=>IDS.includes(r.message.id))){
  const entropy=new NativeSecurityVault(NativeModules.PalMeshSecurity);const records=new Map<string,string>();
  const peer=new SecurityService({read:async k=>records.get(k)??null,write:async(k,v)=>{records.set(k,v);},randomBytes:n=>entropy.randomBytes(n)});await peer.initialize();
  await resources.contacts!.add(peer.publicIdentity,'SIMULATED Rescue Contact');const now=Date.now();
  const payloads=[{text:'SIMULATED SOS old location',location:{latitude:31.500,longitude:34.470,timestamp:now-3600000}},{text:'SIMULATED SOS new location',location:{latitude:31.520,longitude:34.490,timestamp:now-10000}},{text:'SIMULATED SOS no location'}];
  for(let i=0;i<payloads.length;i++){const packet=await peer.seal(createMessage({kind:'sos',payload:payloads[i]!},IDS[i]!,peer.deviceId,now));const accepted=await engine.receive(peer.deviceId,peer.forNextHop(packet)!);if(accepted.status!=='accepted')throw new Error('Synthetic signed acceptance failed');}
 }
 return resources;
}});
function Acceptance(){return <View style={{flex:1}}><Text accessibilityLabel={FIXTURE} style={{paddingTop:30,paddingBottom:4,textAlign:'center',backgroundColor:'#FFF5DA',color:'#18343D'}}>SIMULATED EMERGENCY ACCEPTANCE</Text><I18nProvider><PalMeshApp runtime={runtime}/></I18nProvider></View>;}
AppRegistry.registerComponent('PalMesh',()=>Acceptance);
