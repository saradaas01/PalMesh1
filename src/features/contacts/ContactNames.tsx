import React, { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from 'react';
import { ContactDirectory, shortIdentity, type ContactEntry, type ContactSnapshot } from './ContactDirectory';
const EMPTY: ContactSnapshot = Object.freeze({profileName:'',contacts:Object.freeze([]),loaded:false,saving:false,error:false});
const fallback = {state:EMPTY, entries:new Map<string,ContactEntry>(), service:undefined as ContactDirectory | undefined};
const Context = createContext(fallback);
export function ContactNamesProvider({service,children}:{readonly service:ContactDirectory | undefined; readonly children:React.ReactNode}): React.JSX.Element {
  const subscribe = useCallback((listener:()=>void) => service?.subscribe(listener) ?? (()=>{}),[service]);
  const getSnapshot = useCallback(()=>service?.getSnapshot() ?? EMPTY,[service]);
  const state = useSyncExternalStore(subscribe,getSnapshot,getSnapshot);
  const value = useMemo(()=>{
    const entries = new Map(state.contacts.map(entry=>[entry.id,entry]));
    const shared = new Map((state.nameSharing?.peers ?? []).filter(peer=>peer.name).map(peer=>[peer.id,peer.name]));
    for (const [id] of shared) if (!entries.has(id)) entries.set(id,{id,name:'',compared:false,duplicateName:false});
    const counts = new Map<string,number>();
    const canonical=(name:string)=>name.normalize('NFKC').toLocaleLowerCase('en-US');
    for(const [id,entry] of entries){const name=entry.name||shared.get(id);if(name)counts.set(canonical(name),(counts.get(canonical(name))??0)+1);}
    for(const [id,entry] of entries){const name=entry.name||shared.get(id);entries.set(id,{...entry,duplicateName:!!name&&(counts.get(canonical(name))??0)>1});}
    return {state,service,entries};
  },[state,service]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useContactNames() {
  const context = useContext(Context);
  const shared=(id:string)=>context.state.nameSharing?.peers.find(peer=>peer.id===id)?.name || '';
  const saved=(id:string)=>context.state.contacts.find(entry=>entry.id===id);
  return {...context, label:(id:string) => saved(id)?.name || shared(id) || shortIdentity(id),
    origin:(id:string):'local'|'shared'|'fingerprint'=>saved(id)?.name?'local':shared(id)?'shared':'fingerprint',
    short:shortIdentity, status:(id:string): 'unknown'|'saved'|'compared'|'shared' => {
      const entry=saved(id); return !entry ? shared(id)?'shared':'unknown' : entry.compared ? 'compared' : 'saved';
    }};
}
