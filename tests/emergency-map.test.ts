import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {DtnEngine} from '../src/features/dtn/application/DtnEngine';
import {createMessage} from '../src/features/dtn/domain/validation';
import {SecurityService} from '../src/features/security/application/SecurityService';
import {SqliteDtnStore} from '../src/features/dtn/infrastructure/sqlite/SqliteDtnStore';
import {EmergencyService,SqliteEmergencyRepository} from '../src/features/emergency';
import {emergencyMapPoints,sosLocation,insideCoverage,pressedReportId} from '../src/features/maps/domain/emergencyMap';
import {TestSqliteDatabase} from './helpers/sqlite';
import {until} from './helpers/chat';
class Vault {records=new Map<string,string>();async read(k:string){return this.records.get(k)??null;}async write(k:string,v:string){this.records.set(k,v);}async randomBytes(n:number){return randomBytes(n);}}
const NOW=1800000000000;
test('signed SOS reports retain individual original locations and missing-location states through a durable offline restart',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'palmesh-emergency-map-'));const path=join(directory,'emergency.sqlite');
 const sender=new SecurityService(new Vault(),{now:()=>NOW});const receiver=new SecurityService(new Vault(),{now:()=>NOW});await sender.initialize();await receiver.initialize();
 let database=new TestSqliteDatabase(path);
 const createEngine=()=>new DtnEngine({deviceId:receiver.deviceId,security:receiver,store:new SqliteDtnStore(database),ids:{next:randomUUID},clock:{now:()=>NOW},transport:{send:async()=>{}}});
 let engine=createEngine();let emergency=new EmergencyService({engine,repository:new SqliteEmergencyRepository(database),clock:{now:()=>NOW}});
 t.after(async()=>{await emergency.stop();await engine.stop();database.close();rmSync(directory,{recursive:true,force:true});});
 await engine.start();await emergency.start();
 const reports=[{text:'Synthetic first SOS',location:{latitude:31.5,longitude:34.47,timestamp:NOW-3600000}},{text:'Synthetic second SOS',location:{latitude:31.55,longitude:34.5,timestamp:NOW-10000}},{text:'Synthetic SOS without coordinates'}];const ids:string[]=[];
 for(const payload of reports){const message=await sender.seal(createMessage({kind:'sos',payload},randomUUID(),sender.deviceId,NOW-1000));ids.push(message.id);assert.equal((await engine.receive(sender.deviceId,sender.forNextHop(message)!)).status,'accepted');assert.equal((await engine.receive(sender.deviceId,sender.forNextHop(message)!)).status,'duplicate');}
 await until(()=>emergency.getSnapshot().entries.length===3);
 const verify=()=>{const entries=emergency.getSnapshot().entries;assert.equal(entries.length,3);assert.equal(sosLocation(entries.find(e=>e.id===ids[2])!,NOW),null);const points=emergencyMapPoints(null,[],entries,NOW);assert.equal(points.features.length,2);assert.deepEqual(points.features.find(p=>p.id==='sos:'+ids[0])?.geometry.coordinates,[34.47,31.5]);assert.deepEqual(points.features.find(p=>p.id==='sos:'+ids[1])?.geometry.coordinates,[34.5,31.55]);assert.equal(entries.find(e=>e.id===ids[0])?.location?.timestamp,NOW-3600000);};verify();
 const wire=await sender.seal(createMessage({kind:'sos',payload:reports[0]!},randomUUID(),sender.deviceId,NOW));assert.equal((await engine.receive(sender.deviceId,{...wire,payload:{text:'tampered',location:{latitude:0,longitude:0,timestamp:NOW}}})).status,'invalid');
 await emergency.stop();await engine.stop();database.close();database=new TestSqliteDatabase(path);engine=createEngine();emergency=new EmergencyService({engine,repository:new SqliteEmergencyRepository(database),clock:{now:()=>NOW}});await engine.start();await emergency.start();verify();
});
test('invalid/future emergency coordinates never create a marker; unrelated peer SOS never substitutes for a missing fix',()=>{
 const entry={id:randomUUID(),source:'peer',text:'Synthetic',createdAt:NOW,receivedAt:NOW,expiresAt:NOW+10000,outgoing:false,dismissed:false,responseId:null,responses:[]};
 for(const location of [undefined,{latitude:91,longitude:0,timestamp:NOW},{latitude:31,longitude:34,timestamp:NOW+300001}]){const report={...entry,...(location?{location}:{})};assert.equal(sosLocation(report,NOW),null);assert.equal(emergencyMapPoints(null,[{deviceId:'peer',origin:'sos',messageId:randomUUID(),receivedAt:NOW,location:{latitude:1,longitude:2,timestamp:NOW}}],[report],NOW).features.length,0);}
 assert.equal(insideCoverage({latitude:31.5,longitude:34.47,timestamp:NOW},{bounds:[34,31,35,32],minZoom:0,maxZoom:14,sourceLayers:[],attribution:'OSM',tileUrlTemplate:''}),true);
});

test('native marker selection keeps original report association even when numeric tiling drops its ID',()=>{assert.equal(pressedReportId({id:42,properties:{reportId:'sos:original-report'}}),'sos:original-report');assert.equal(pressedReportId({id:'local',properties:null}),'local');assert.equal(pressedReportId({id:0,properties:{reportId:5}}),null);});
