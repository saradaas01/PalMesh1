import type { SecurityVault } from '../security/domain/types';
export class OnboardingPreferences {
 private state:Readonly<{loaded:boolean;complete:boolean;error:boolean}>=Object.freeze({loaded:false,complete:false,error:false});private listeners=new Set<()=>void>();private work:Promise<unknown>=Promise.resolve();
 constructor(private readonly owner:string,private readonly vault:Pick<SecurityVault,'read'|'write'>){}
 getSnapshot=()=>this.state;
 subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
 private publish(loaded:boolean,complete:boolean,error:boolean){this.state=Object.freeze({loaded,complete,error});for(const listener of this.listeners){try{listener();}catch{/* A UI subscriber cannot undo a durable preference. */}}}
 async initialize(){try{const raw=await this.vault.read('ux-onboarding-v1');if(raw===null){this.publish(true,false,false);return;}if(raw.length>512)throw new Error('Invalid preference');const value=JSON.parse(raw);if(value.version!==1||value.owner!==this.owner||value.complete!==true||Object.keys(value).length!==3)throw new Error('Invalid preference');this.publish(true,true,false);}catch{this.publish(false,false,true);}}
 finish=():Promise<void>=>{const task=this.work.catch(()=>undefined).then(async()=>{if(!this.state.loaded)throw new Error('Preference unavailable');await this.vault.write('ux-onboarding-v1',JSON.stringify({version:1,owner:this.owner,complete:true}));this.publish(true,true,false);});this.work=task.catch(()=>{this.publish(this.state.loaded,this.state.complete,true);});return task;};
}
