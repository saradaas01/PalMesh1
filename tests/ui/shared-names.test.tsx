import React from 'react';
import {Text} from 'react-native';
import {test,expect,jest} from '@jest/globals';
import {render,screen,fireEvent,act} from '@testing-library/react-native';
import {ContactDirectory} from '../../src/features/contacts/ContactDirectory';
import {ContactNamesProvider,useContactNames} from '../../src/features/contacts/ContactNames';
import {IdentityName} from '../../src/features/contacts/IdentityName';
import {NameSharingControls} from '../../src/features/contacts/NameSharingControls';
import type {SharedProfileService,SharedProfileSnapshot} from '../../src/features/contacts/SharedProfileService';
const ALICE='pm1:'+'a'.repeat(64),BOB='pm1:'+'b'.repeat(64),OWNER='pm1:'+'c'.repeat(64);
class Profiles {
 state:SharedProfileSnapshot={loaded:true,sharingEnabled:false,busy:false,error:false,peers:[]};listeners=new Set<()=>void>();
 getSnapshot=()=>this.state;subscribe=(f:()=>void)=>{this.listeners.add(f);return()=>{this.listeners.delete(f);};};
 patch(p:Partial<SharedProfileSnapshot>){this.state={...this.state,...p};for(const f of this.listeners)f();}
 setSharing=jest.fn(async(value:boolean)=>{this.patch({sharingEnabled:value});});
 shareCurrent=jest.fn(async()=>{});
 peer(id:string,name:string,revision=1){this.patch({peers:[...this.state.peers.filter(p=>p.id!==id),{id,name,revision,messageId:'test-'+revision,createdAt:1000}]});}
}
async function setup(){const records=new Map<string,string>();const vault={read:async(k:string)=>records.get(k)??null,write:async(k:string,v:string)=>{records.set(k,v);}};const identities={deviceId:OWNER,publicIdentity:{signingKey:'0'.repeat(64),encryptionKey:'1'.repeat(64)},savedPeerIds:()=>[ALICE],importPeer:async()=>ALICE};const contacts=new ContactDirectory(identities,vault);await contacts.initialize();const profiles=new Profiles();contacts.connectSharedProfiles(profiles as unknown as SharedProfileService);return{contacts,profiles,vault,identities};}
function Labels(){const names=useContactNames();return <><Text testID="alice">{names.label(ALICE)}</Text><Text testID="bob">{names.label(BOB)}</Text><Text testID="status">{names.origin(BOB)+'/'+names.status(BOB)}</Text><Text testID="duplicate">{String(names.entries.get(ALICE)?.duplicateName)}</Text></>;}

test('nickname overrides authenticated self-name, virtual shared identities stay unverified, and withdrawal never erases nickname',async()=>{
 const{contacts,profiles}=await setup();profiles.peer(ALICE,'Sara');profiles.peer(BOB,'Sara');
 await render(<ContactNamesProvider service={contacts}><Labels/></ContactNamesProvider>);
 expect(screen.getByTestId('alice')).toHaveTextContent('Sara');expect(screen.getByTestId('status')).toHaveTextContent('shared/shared');expect(screen.getByTestId('duplicate')).toHaveTextContent('true');
 await act(async()=>{await contacts.rename(ALICE,'My sister');});expect(screen.getByTestId('alice')).toHaveTextContent('My sister');
 await act(async()=>{profiles.peer(ALICE,'Replacement',2);profiles.peer(BOB,'',2);});expect(screen.getByTestId('alice')).toHaveTextContent('My sister');expect(screen.getByTestId('bob')).toHaveTextContent('pm1:bbbbbbbb…bbbbbbbb');expect(contacts.getSnapshot().contacts[0]?.compared).toBe(false);
});
test('sharing is off until explicit user opt-in and entering a local name never publishes',async()=>{
 const{contacts,profiles}=await setup();await contacts.setProfileName('Sara');await render(<ContactNamesProvider service={contacts}><NameSharingControls/></ContactNamesProvider>);
 expect(profiles.setSharing).not.toHaveBeenCalled();expect(profiles.shareCurrent).not.toHaveBeenCalled();
 await fireEvent.press(screen.getByRole('button',{name:'Name sharing · Public to the mesh'}));
 expect(screen.getByText(/Off by default/)).toBeOnTheScreen();
 await fireEvent(screen.getByLabelText('Share my name with the mesh'),'valueChange',true);
 expect(profiles.setSharing).toHaveBeenCalledWith(true);expect(screen.getByText('Name update queued locally. Delivery is not confirmed.')).toBeOnTheScreen();
 await act(async()=>{await contacts.setProfileName('سارة');});expect(profiles.shareCurrent).toHaveBeenCalledTimes(1);
});
test('announcement failure preserves saved nickname/profile and shows sharing error without false queue notice',async()=>{
 const{contacts,profiles}=await setup();await contacts.setProfileName('Sara');profiles.setSharing.mockImplementation(async()=>{profiles.patch({error:true});throw new Error('capacity');});
 await render(<ContactNamesProvider service={contacts}><NameSharingControls/></ContactNamesProvider>);await fireEvent.press(screen.getByRole('button',{name:'Name sharing · Public to the mesh'}));await fireEvent(screen.getByLabelText('Share my name with the mesh'),'valueChange',true);
 expect(screen.getByRole('alert')).toHaveTextContent('Name sharing needs attention. Your local name and messages are kept.');expect(screen.queryByText('Name update queued locally. Delivery is not confirmed.')).toBeNull();expect(contacts.getSnapshot().profileName).toBe('Sara');
});
test('receiver nickname survives directory restart while a newer shared name cannot change identity or comparison',async()=>{
 const{contacts,profiles,vault,identities}=await setup();await contacts.rename(ALICE,'Local nickname');await contacts.setCompared(ALICE,true);
 const restarted=new ContactDirectory(identities,vault);await restarted.initialize();profiles.peer(ALICE,'New self-name',9);restarted.connectSharedProfiles(profiles as unknown as SharedProfileService);
 await render(<ContactNamesProvider service={restarted}><Labels/></ContactNamesProvider>);expect(screen.getByTestId('alice')).toHaveTextContent('Local nickname');expect(restarted.getSnapshot().contacts[0]?.compared).toBe(true);expect(restarted.getSnapshot().contacts[0]?.id).toBe(ALICE);
});

test('a shared name opens full fingerprint details without creating a contact or comparison',async()=>{
 const{contacts,profiles}=await setup();profiles.peer(BOB,'Samer');
 await render(<ContactNamesProvider service={contacts}><IdentityName id={BOB}/></ContactNamesProvider>);
 await fireEvent.press(screen.getByRole('button',{name:'Sender identity: Samer'}));
 expect(screen.getByText(BOB)).toBeOnTheScreen();expect(screen.getByText('Self-declared name authenticated to this fingerprint; verify the person separately.')).toBeOnTheScreen();
 expect(contacts.getSnapshot().contacts.some(c=>c.id===BOB)).toBe(false);
 await fireEvent.press(screen.getByRole('button',{name:'Close identity details'}));expect(screen.queryByText(BOB)).toBeNull();
});
