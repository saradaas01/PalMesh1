import assert from 'node:assert/strict';
import {test} from 'node:test';
import {OnboardingPreferences} from '../src/features/onboarding/OnboardingPreferences';
test('onboarding completion survives restart and never touches identity or contact records',async()=>{
 const records=new Map([['identity-v1','original'],['peer-directory-v1','pinned']]);const vault={read:async(k:string)=>records.get(k)??null,write:async(k:string,v:string)=>{records.set(k,v);}};
 const initial=new OnboardingPreferences('owner',vault);await initial.initialize();assert.equal(initial.getSnapshot().complete,false);await initial.finish();
 const next=new OnboardingPreferences('owner',vault);await next.initialize();assert.equal(next.getSnapshot().complete,true);assert.equal(records.get('identity-v1'),'original');assert.equal(records.get('peer-directory-v1'),'pinned');
});
test('failed onboarding saves remain retryable, corrupt or foreign preferences are never overwritten',async()=>{
 let value:string|null=null;let fail=true;const vault={read:async()=>value,write:async(_k:string,v:string)=>{if(fail)throw new Error('locked');value=v;}};
 const service=new OnboardingPreferences('owner',vault);await service.initialize();await assert.rejects(()=>service.finish());assert.equal(service.getSnapshot().complete,false);fail=false;await service.finish();assert.equal(service.getSnapshot().complete,true);
 for(const bad of ['broken',JSON.stringify({owner:'different',version:1,complete:true})]){value=bad;const recovery=new OnboardingPreferences('owner',vault);await recovery.initialize();assert.equal(recovery.getSnapshot().loaded,false);await assert.rejects(()=>recovery.finish());assert.equal(value,bad);}
});
