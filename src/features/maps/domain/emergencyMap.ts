import type {FeatureCollection,Point} from 'geojson';
import type {LocationFix} from '../../dtn/domain/types';
import type {EmergencyEntry} from '../../emergency/domain/types';
import {validLocationFix} from './locations';
import type {OfflineMapDescriptor,PeerLocation} from './types';
export interface MapFocus {readonly id:string;readonly location:LocationFix;readonly revision:number}
/** The original SOS owns its location. Never look up a replacement by contact ID. */
export function sosLocation(entry:EmergencyEntry,now:number):LocationFix|null {
 const fix=entry.location;
 return validLocationFix(fix)&&fix.timestamp<=now+300000&&fix.timestamp<=entry.receivedAt+300000 ? fix:null;
}
export function insideCoverage(location:LocationFix,map:OfflineMapDescriptor):boolean {const [w,s,e,n]=map.bounds;return location.longitude>=w&&location.longitude<=e&&location.latitude>=s&&location.latitude<=n;}
export function emergencyMapPoints(local:LocationFix|null,peers:readonly PeerLocation[],entries:readonly EmergencyEntry[],now:number):FeatureCollection<Point>{
 const point=(id:string,location:LocationFix,origin:string)=>({type:'Feature' as const,id,geometry:{type:'Point' as const,coordinates:[location.longitude,location.latitude]},properties:{origin,reportId:id}});
 return {type:'FeatureCollection',features:[
  ...peers.filter(p=>p.origin==='location'&&validLocationFix(p.location)&&p.location.timestamp<=now+300000).map(p=>point('peer:'+p.messageId,p.location,'location')),
  ...entries.flatMap(e=>{const fix=sosLocation(e,now);return fix?[point('sos:'+e.id,fix,'sos')]:[];}),
  ...(local&&validLocationFix(local)?[point('local',local,'local')]:[]),
 ]};
}
