import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { ContactDirectory, normalizeName, parsePublicIdentity, publicIdentityShare, shortIdentity } from '../src/features/contacts/ContactDirectory';
import { SecurityService } from '../src/features/security/application/SecurityService';
import type { SecurityVault } from '../src/features/security/domain/types';
class Vault implements SecurityVault {
 readonly records=new Map<string,string>(); failure=false;
 async read(key:string){return this.records.get(key)??null;}
 async write(key:string,value:string){if(this.failure)throw new Error('locked');this.records.set(key,value);}
 async randomBytes(length:number){return randomBytes(length);}
}
async function fixture(vault=new Vault()){const security=new SecurityService(vault);await security.initialize();const contacts=new ContactDirectory(security,vault);await contacts.initialize();return {vault,security,contacts};}
test('public QR contains only validated public keys; legacy JSON remains compatible',async()=>{
 const {security}=await fixture();const payload=publicIdentityShare(security.publicIdentity,security.deviceId);
 assert.deepEqual(Object.keys(JSON.parse(payload)).sort(),['id','publicIdentity','type','version']);
 assert.deepEqual(parsePublicIdentity(payload).identity,security.publicIdentity);
 assert.equal(parsePublicIdentity(JSON.stringify(security.publicIdentity)).id,security.deviceId);
 const envelope=JSON.parse(payload);envelope.id='pm1:'+'0'.repeat(64);assert.throws(()=>parsePublicIdentity(envelope));
 assert.throws(()=>parsePublicIdentity({...security.publicIdentity,privateKey:'secret'}));
 assert.throws(()=>parsePublicIdentity('x'.repeat(2049)));
 const getter=Object.defineProperty({},'signingKey',{get(){throw new Error('getter executed');}});assert.throws(()=>parsePublicIdentity(getter));
});
test('profile and nickname persist across a real security-service restart without changing keys',async()=>{
 const a=await fixture(),b=await fixture();const before=new Map(a.vault.records);
 await a.contacts.setProfileName('ليلى');await a.contacts.add(publicIdentityShare(b.security.publicIdentity,b.security.deviceId),'أحمد 👋');
 await a.contacts.setCompared(b.security.deviceId,true);await a.contacts.rename(b.security.deviceId,'أبو أحمد');
 const restarted=await fixture(a.vault);assert.equal(restarted.security.deviceId,a.security.deviceId);
 assert.equal(a.vault.records.get('identity-v1'),before.get('identity-v1'));
 assert.equal(restarted.contacts.getSnapshot().profileName,'ليلى');
 assert.deepEqual(restarted.contacts.getSnapshot().contacts,[{id:b.security.deviceId,name:'أبو أحمد',compared:true,duplicateName:false}]);
 assert.ok(restarted.security.savedPeerIds().includes(b.security.deviceId));
});
test('legacy imported contacts survive with no metadata and never become automatically compared',async()=>{
 const a=await fixture(),b=await fixture();await a.security.importPeer(b.security.publicIdentity);
 const restarted=await fixture(a.vault);assert.equal(restarted.contacts.getSnapshot().contacts[0]?.name,'');assert.equal(restarted.contacts.getSnapshot().contacts[0]?.compared,false);
 await assert.rejects(()=>a.contacts.rename('pm1:'+'0'.repeat(64),'Unknown'));
});
test('duplicate names are separate bindings; changed keys never inherit nickname or comparison',async()=>{
 const a=await fixture(),b=await fixture(),c=await fixture();
 await a.contacts.add(b.security.publicIdentity,'Sam');await a.contacts.setCompared(b.security.deviceId,true);
 await a.contacts.add(c.security.publicIdentity,'sam');const entries=a.contacts.getSnapshot().contacts;
 assert.equal(entries.length,2);assert.ok(entries.every(x=>x.duplicateName));assert.equal(entries.find(x=>x.id===c.security.deviceId)?.compared,false);
 const result=await a.contacts.add(b.security.publicIdentity,'Replacement');assert.equal(result.alreadySaved,true);
 assert.equal(a.contacts.getSnapshot().contacts.find(x=>x.id===b.security.deviceId)?.name,'Sam');
 await a.contacts.rename(c.security.deviceId,'Other');assert.ok(a.contacts.getSnapshot().contacts.every(x=>!x.duplicateName));
});
test('failed metadata writes retain existing names and drafts can retry; imported keys remain honest',async()=>{
 const a=await fixture(),b=await fixture();await a.contacts.add(b.security.publicIdentity,'Old');a.vault.failure=true;
 await assert.rejects(()=>a.contacts.rename(b.security.deviceId,'Lost'));await new Promise(resolve=>setImmediate(resolve));
 assert.equal(a.contacts.getSnapshot().contacts[0]?.name,'Old');assert.equal(a.contacts.getSnapshot().error,true);
 a.vault.failure=false;await a.contacts.rename(b.security.deviceId,'Recovered');assert.equal(a.contacts.getSnapshot().contacts[0]?.name,'Recovered');
});
test('corrupt or foreign metadata is never overwritten or allowed to block identity startup',async()=>{
 const a=await fixture();for(const value of ['broken',JSON.stringify({version:1,owner:'other',profileName:'',entries:[]})]){
 a.vault.records.set('contact-profile-v1',value);const restarted=await fixture(a.vault);
 assert.equal(restarted.contacts.getSnapshot().loaded,false);assert.equal(restarted.security.deviceId,a.security.deviceId);
 await assert.rejects(()=>restarted.contacts.setProfileName('Overwrite'));assert.equal(a.vault.records.get('contact-profile-v1'),value);
 }
});
test('concurrent writes serialize without losing names, comparison or profile metadata',async()=>{
 const a=await fixture(),b=await fixture();await a.contacts.add(b.security.publicIdentity);
 await Promise.all([a.contacts.setProfileName('Owner'),a.contacts.rename(b.security.deviceId,'Friend'),a.contacts.setCompared(b.security.deviceId,true)]);
 const restarted=await fixture(a.vault);assert.equal(restarted.contacts.getSnapshot().profileName,'Owner');assert.equal(restarted.contacts.getSnapshot().contacts[0]?.name,'Friend');assert.equal(restarted.contacts.getSnapshot().contacts[0]?.compared,true);
});
test('names accept Arabic and emoji but reject spoofing controls and oversized input',()=>{
 assert.equal(normalizeName('  لَيْلَى 👋  '),'لَيْلَى 👋');assert.equal(normalizeName('e\u0301'),'é');
 for(const name of ['Name\u202e','A\nB','x'.repeat(81),'\ud800'])assert.throws(()=>normalizeName(name));
 assert.equal(shortIdentity('pm1:'+'a'.repeat(64)),'pm1:aaaaaaaa…aaaaaaaa');
});
test('the hosted QR image fixture fingerprint matches the application and exposes only public records',async()=>{
 const {execFileSync}=await import('node:child_process');const {mkdtempSync,readFileSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const directory=mkdtempSync(join(tmpdir(),'palmesh-public-qr-'));
 execFileSync(process.execPath,['scripts/android/contact-qr-fixture.cjs',directory]);
 const parsed=parsePublicIdentity(readFileSync(join(directory,'public-identity.json'),'utf8'));
 assert.match(parsed.id,/^pm1:[0-9a-f]{64}$/);
 assert.equal(readFileSync(join(directory,'PalMeshPublicContact.gif')).subarray(0,6).toString(),'GIF87a');
});
test('a name-write failure after successful public-key import is reported as partial and preserves pins',async()=>{
 const a=await fixture(),b=await fixture();const originalWrite=a.vault.write.bind(a.vault);
 a.vault.write=async(key,value)=>{if(key==='contact-profile-v1')throw new Error('metadata unavailable');await originalWrite(key,value);};
 const result=await a.contacts.add(b.security.publicIdentity,'Draft');assert.equal(result.nameSaved,false);
 assert.ok(a.security.savedPeerIds().includes(b.security.deviceId));assert.equal(a.contacts.getSnapshot().contacts[0]?.name,'');assert.equal(a.contacts.getSnapshot().contacts[0]?.compared,false);
});
