import { describe, test, expect, jest } from '@jest/globals';
import React from 'react';
import { NativeModules } from 'react-native';
import { render, screen, fireEvent, act } from '@testing-library/react-native';
import { ContactsExperience } from '../../src/features/contacts/ContactsExperience';
import { ContactNamesProvider } from '../../src/features/contacts/ContactNames';
import { ContactDirectory, publicIdentityShare } from '../../src/features/contacts/ContactDirectory';
import { SecurityService } from '../../src/features/security/application/SecurityService';
import { randomBytes } from 'node:crypto';
import { I18nProvider } from '../../src/shared/i18n';
import type { SecurityVault } from '../../src/features/security/domain/types';
class Vault implements SecurityVault {
 records=new Map<string,string>();fail=false;
 async read(key:string){return this.records.get(key)??null;}
 async write(key:string,value:string){if(this.fail)throw new Error('locked');this.records.set(key,value);}
 async randomBytes(n:number){return randomBytes(n);}
}
async function setup(language:'en'|'ar'='en'){
 const vault=new Vault();const security=new SecurityService(vault);await security.initialize();const peer=new SecurityService(new Vault());await peer.initialize();const service=new ContactDirectory(security,vault);await service.initialize();const open=jest.fn(async(_id:string)=>{});
 await render(<I18nProvider initialLanguage={language}><ContactNamesProvider service={service}><ContactsExperience security={security} service={service} onOpen={open}/></ContactNamesProvider></I18nProvider>);
 return {vault,security,peer,service,open};
}
describe('offline contact experience',()=>{
 test('explicit scan and save names a contact without verifying it and opens by fingerprint',async()=>{
 const {peer,service,open}=await setup();NativeModules.PalMeshPublicQr={scanImage:jest.fn(async()=>publicIdentityShare(peer.publicIdentity,peer.deviceId))};
 await fireEvent.press(screen.getByRole('button',{name:'Scan QR from a local image'}));
 expect(service.getSnapshot().contacts).toHaveLength(0);
 await fireEvent.changeText(screen.getByLabelText('Local contact nickname'),'ليلى');
 await fireEvent.press(screen.getByRole('button',{name:'Save contact identity'}));
 expect(service.getSnapshot().contacts[0]).toMatchObject({name:'ليلى',compared:false});
 expect(screen.getByText('Public keys saved — fingerprint not compared')).toBeOnTheScreen();
 expect(screen.queryByRole('button',{name:'I compared this full fingerprint through a trusted channel'})).toBeNull();
 await fireEvent.press(screen.getByRole('button',{name:'Show or hide full fingerprint'}));
 await fireEvent.press(screen.getByRole('button',{name:'I compared this full fingerprint through a trusted channel'}));
 expect(service.getSnapshot().contacts[0]?.compared).toBe(true);
 await fireEvent.press(screen.getByRole('button',{name:'Start private conversation'}));expect(open).toHaveBeenCalledWith(peer.deviceId);
 });
 test('profile persists; failed edits retain draft and existing name',async()=>{
 const {service,vault}=await setup();await fireEvent.changeText(screen.getByLabelText('Optional display name (on this device)'),'Owner');
 await fireEvent.press(screen.getByRole('button',{name:'Save display name'}));expect(service.getSnapshot().profileName).toBe('Owner');
 vault.fail=true;await fireEvent.changeText(screen.getByLabelText('Optional display name (on this device)'),'New');await fireEvent.press(screen.getByRole('button',{name:'Save display name'}));
 expect(screen.getByLabelText('Optional display name (on this device)')).toHaveDisplayValue('New');expect(service.getSnapshot().profileName).toBe('Owner');expect(screen.getByRole('alert')).toBeOnTheScreen();
 });
 test('invalid QR cannot create a contact, expose its payload, or change pinned keys',async()=>{
 const {service}=await setup();NativeModules.PalMeshPublicQr={scanImage:jest.fn(async()=>'{"privateKey":"never display this"}')};await fireEvent.press(screen.getByRole('button',{name:'Scan QR from a local image'}));
 expect(service.getSnapshot().contacts).toHaveLength(0);expect(screen.queryByText(/never display this/)).toBeNull();expect(screen.getByRole('alert')).toBeOnTheScreen();
 });
 test('public QR renders on demand and Arabic contact controls remain accessible',async()=>{
 await setup('ar');
 expect(screen.getByLabelText('اسم العرض الاختياري (على هذا الجهاز)')).toBeOnTheScreen();
 await fireEvent.press(screen.getByRole('button',{name:'عرض رمز الهوية العامة'}));
 expect(screen.getByRole('button',{name:'إخفاء رمز الهوية العامة'})).toBeOnTheScreen();
 expect(screen.getByRole('button',{name:'قراءة رمز QR من صورة محلية'})).toBeOnTheScreen();
 });

});
