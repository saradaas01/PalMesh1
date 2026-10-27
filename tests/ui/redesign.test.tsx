import React from 'react';
import {test,expect,jest,beforeEach} from '@jest/globals';
import {NativeModules,Text} from 'react-native';
import {render,screen,fireEvent} from '@testing-library/react-native';
import {randomBytes} from 'node:crypto';
import {I18nProvider,ar} from '../../src/shared/i18n';
import {ContactDirectory,publicIdentityShare} from '../../src/features/contacts/ContactDirectory';
import {ContactNamesProvider} from '../../src/features/contacts/ContactNames';
import {ContactsExperienceV2,ProfileExperience} from '../../src/features/contacts/IdentityExperience';
import {SecurityService} from '../../src/features/security/application/SecurityService';
import {OnboardingPreferences} from '../../src/features/onboarding/OnboardingPreferences';
import {FirstRun} from '../../src/features/onboarding/OnboardingScreen';
class Vault {records=new Map<string,string>();async read(k:string){return this.records.get(k)??null;}async write(k:string,v:string){this.records.set(k,v);}async randomBytes(n:number){return randomBytes(n);}}
async function setup(){const vault=new Vault();const security=new SecurityService(vault);await security.initialize();const peer=new SecurityService(new Vault());await peer.initialize();const contacts=new ContactDirectory(security,vault);await contacts.initialize();return{vault,security,peer,contacts};}
beforeEach(()=>{NativeModules.PalMeshPublicQr={scanCamera:jest.fn(),scanImage:jest.fn(),copyFingerprint:jest.fn(async()=>{})};});
test('profile hides full identity until requested and copies only the public fingerprint',async()=>{
 const {contacts,security}=await setup();await render(<ContactNamesProvider service={contacts}><ProfileExperience security={security}/></ContactNamesProvider>);
 expect(screen.queryByText(security.deviceId)).toBeNull();await fireEvent.press(screen.getByRole('button',{name:'Advanced identity details'}));expect(screen.getByText(security.deviceId)).toBeOnTheScreen();await fireEvent.press(screen.getByRole('button',{name:'Copy fingerprint'}));expect(NativeModules.PalMeshPublicQr.copyFingerprint).toHaveBeenCalledWith(security.deviceId);
 await fireEvent.press(screen.getByRole('button',{name:'Edit name'}));await fireEvent.changeText(screen.getByLabelText('Display name (optional)'),'سارة');await fireEvent.press(screen.getByRole('button',{name:'Save'}));expect(contacts.getSnapshot().profileName).toBe('سارة');
});
test('camera scan previews before explicit save, preserves verification and opens a named private conversation by full ID',async()=>{
 const {contacts,peer}=await setup();const open=jest.fn(async(_id:string)=>{});NativeModules.PalMeshPublicQr.scanCamera=jest.fn(async()=>publicIdentityShare(peer.publicIdentity,peer.deviceId));
 await render(<ContactNamesProvider service={contacts}><ContactsExperienceV2 onOpen={open} onProfile={()=>{}}/></ContactNamesProvider>);
 await fireEvent.press(screen.getByRole('button',{name:'Add contact'}));await fireEvent.press(screen.getByRole('button',{name:'Scan QR code'}));expect(NativeModules.PalMeshPublicQr.scanCamera).toHaveBeenCalledWith('en');expect(contacts.getSnapshot().contacts).toHaveLength(0);
 await fireEvent.changeText(screen.getByLabelText('Contact name'),'Layla');await fireEvent.press(screen.getByRole('button',{name:'Save'}));expect(contacts.getSnapshot().contacts[0]).toMatchObject({id:peer.deviceId,name:'Layla',compared:false});expect(screen.queryByText(peer.deviceId)).toBeNull();await fireEvent.press(screen.getByRole('button',{name:'Message Layla'}));expect(open).toHaveBeenCalledWith(peer.deviceId);
 await fireEvent.press(screen.getByRole('button',{name:'Contact details: Layla'}));await fireEvent.press(screen.getByRole('button',{name:'Rename'}));await fireEvent.changeText(screen.getByLabelText('Contact name'),'ليلى');await fireEvent.press(screen.getByRole('button',{name:'Save'}));expect(contacts.getSnapshot().contacts[0]?.name).toBe('ليلى');
});
test('denied camera retains gallery option, invalid codes never expose private fields, cancellation never imports',async()=>{
 const {contacts}=await setup();NativeModules.PalMeshPublicQr.scanCamera=jest.fn(async()=>{throw Object.assign(new Error('denied'),{code:'QR_CAMERA_DENIED'});});
 await render(<ContactNamesProvider service={contacts}><ContactsExperienceV2 onOpen={async()=>{}} onProfile={()=>{}}/></ContactNamesProvider>);await fireEvent.press(screen.getByRole('button',{name:'Add contact'}));await fireEvent.press(screen.getByRole('button',{name:'Scan QR code'}));expect(screen.getByRole('alert')).toHaveTextContent(/Camera access is off/);expect(screen.getByRole('button',{name:'Import QR from gallery'})).toBeEnabled();
 NativeModules.PalMeshPublicQr.scanCamera=jest.fn(async()=>'{"privateKey":"never-display-secret"}');await fireEvent.press(screen.getByRole('button',{name:'Scan QR code'}));expect(screen.getByRole('alert')).toHaveTextContent(/This isn’t a PalMesh identity QR/);expect(screen.queryByText(/never-display-secret/)).toBeNull();
 NativeModules.PalMeshPublicQr.scanCamera=jest.fn(async()=>null);await fireEvent.press(screen.getByRole('button',{name:'Scan QR code'}));expect(contacts.getSnapshot().contacts).toHaveLength(0);expect(screen.queryByRole('alert')).toBeNull();
});
test('Arabic camera invocation passes locale and optional profile never becomes an identity',async()=>{
 const {contacts}=await setup();NativeModules.PalMeshPublicQr.scanCamera=jest.fn(async()=>null);await render(<I18nProvider initialLanguage="ar"><ContactNamesProvider service={contacts}><ContactsExperienceV2 onOpen={async()=>{}} onProfile={()=>{}}/></ContactNamesProvider></I18nProvider>);await fireEvent.press(screen.getByRole('button',{name:ar['ui.addContact']}));await fireEvent.press(screen.getByRole('button',{name:ar['ui.scan']}));expect(NativeModules.PalMeshPublicQr.scanCamera).toHaveBeenCalledWith('ar');
});
test('first-run onboarding is skippable, persists offline and never opens the camera',async()=>{
 const {vault,contacts,security}=await setup();const preferences=new OnboardingPreferences(security.deviceId,vault);await preferences.initialize();await render(<ContactNamesProvider service={contacts}><FirstRun preferences={preferences}><Text>Inbox</Text></FirstRun></ContactNamesProvider>);await fireEvent.press(screen.getByRole('button',{name:'Skip for now'}));expect(preferences.getSnapshot().complete).toBe(true);expect(NativeModules.PalMeshPublicQr.scanCamera).not.toHaveBeenCalled();const restart=new OnboardingPreferences(security.deviceId,vault);await restart.initialize();expect(restart.getSnapshot().complete).toBe(true);
});
