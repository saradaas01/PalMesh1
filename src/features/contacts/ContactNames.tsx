import React, { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from 'react';
import { ContactDirectory, shortIdentity, type ContactEntry, type ContactSnapshot } from './ContactDirectory';
const EMPTY: ContactSnapshot = Object.freeze({profileName:'',contacts:Object.freeze([]),loaded:false,saving:false,error:false});
const fallback = {state:EMPTY, entries:new Map<string,ContactEntry>(), service:undefined as ContactDirectory | undefined};
const Context = createContext(fallback);
export function ContactNamesProvider({service,children}:{readonly service:ContactDirectory | undefined; readonly children:React.ReactNode}): React.JSX.Element {
  const subscribe = useCallback((listener:()=>void) => service?.subscribe(listener) ?? (()=>{}),[service]);
  const getSnapshot = useCallback(()=>service?.getSnapshot() ?? EMPTY,[service]);
  const state = useSyncExternalStore(subscribe,getSnapshot,getSnapshot);
  const value = useMemo(()=>({state,service,entries:new Map(state.contacts.map(entry=>[entry.id,entry]))}),[state,service]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useContactNames() {
  const context = useContext(Context);
  return {...context, label:(id:string) => context.entries.get(id)?.name || shortIdentity(id),
    short:shortIdentity, status:(id:string): 'unknown'|'saved'|'compared' => {
      const entry=context.entries.get(id); return !entry ? 'unknown' : entry.compared ? 'compared' : 'saved';
    }};
}
