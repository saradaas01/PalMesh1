import { identityFingerprint } from '../security/application/SecurityService';
import type { PublicIdentity, SecurityVault } from '../security/domain/types';

const RECORD = 'contact-profile-v1';
const MAX_CONTACTS = 256;
const FINGERPRINT = /^pm1:[0-9a-f]{64}$/u;
export interface IdentityDirectory {
  readonly deviceId: string;
  readonly publicIdentity: PublicIdentity;
  savedPeerIds(): readonly string[];
  importPeer(identity: unknown): Promise<string>;
}
export interface ContactEntry { readonly id: string; readonly name: string; readonly compared: boolean; readonly duplicateName: boolean }
export interface ContactSnapshot {
  readonly profileName: string; readonly contacts: readonly ContactEntry[];
  readonly loaded: boolean; readonly saving: boolean; readonly error: boolean;
}
interface Label { readonly id: string; readonly name: string; readonly compared: boolean }
interface Metadata { readonly profileName: string; readonly entries: readonly Label[] }

/** Names are local annotations, never routing addresses or cryptographic proof. */
export function normalizeName(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('Invalid name');
  const name = value.normalize('NFC').trim();
  if ([...name].length > 80 || /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff\ud800-\udfff]/u.test(name)) throw new TypeError('Invalid name');
  return name;
}
export function shortIdentity(id: string): string {
  return FINGERPRINT.test(id) ? `${id.slice(0,12)}…${id.slice(-8)}` : id;
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) throw new TypeError('Invalid record');
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) throw new TypeError('Unexpected record fields');
  const result: Record<string,unknown> = Object.create(null) as Record<string,unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value,key);
    if (!descriptor || !('value' in descriptor)) throw new TypeError('Invalid record property');
    result[key] = descriptor.value;
  }
  return result;
}

/** Legacy two-public-key JSON stays valid. The QR envelope cannot rebind an ID. */
export function parsePublicIdentity(input: unknown): { readonly id: string; readonly identity: PublicIdentity } {
  if (typeof input === 'string') {
    if (input.length > 2048) throw new TypeError('Identity payload too large');
    input = JSON.parse(input) as unknown;
  }
  let keys: unknown = input;
  if (input && typeof input === 'object' && Object.getOwnPropertyDescriptor(input,'type')) {
    const envelope = record(input,['type','version','id','publicIdentity']);
    if (envelope.type !== 'palmesh-public-identity' || envelope.version !== 1) throw new TypeError('Unsupported public identity');
    keys = envelope.publicIdentity;
    const id = identityFingerprint(keys as PublicIdentity);
    if (id !== envelope.id) throw new TypeError('Public identity fingerprint mismatch');
  }
  const id = identityFingerprint(keys as PublicIdentity);
  const fields = record(keys,['signingKey','encryptionKey']);
  return Object.freeze({id, identity:Object.freeze({signingKey:fields.signingKey as string,encryptionKey:fields.encryptionKey as string})});
}
export function publicIdentityShare(identity: PublicIdentity, expectedId: string): string {
  // Explicit allowlist: no seed, private key, vault record or profile name.
  const keys = {signingKey:identity.signingKey,encryptionKey:identity.encryptionKey};
  if (identityFingerprint(keys) !== expectedId) throw new TypeError('Local identity mismatch');
  return JSON.stringify({type:'palmesh-public-identity',version:1,id:expectedId,publicIdentity:keys});
}

export class ContactDirectory {
  private metadata: Metadata = {profileName:'',entries:[]};
  private loaded = false;
  private failed = false;
  private pending = 0;
  private importsPending = 0;
  private importWork: Promise<unknown> = Promise.resolve();
  private work: Promise<unknown> = Promise.resolve();
  private listeners = new Set<() => void>();
  private state: ContactSnapshot = Object.freeze({profileName:'',contacts:Object.freeze([]),loaded:false,saving:false,error:false});
  constructor(private readonly security: IdentityDirectory, private readonly vault: Pick<SecurityVault,'read'|'write'>) {}
  getSnapshot = (): ContactSnapshot => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  initialize = (): Promise<void> => {
    const task = this.work.catch(() => undefined).then(async () => {
    try {
      const text = await this.vault.read(RECORD);
      let metadata: Metadata = {profileName:'',entries:[]};
      if (text !== null) {
        if (text.length > 128*1024) throw new TypeError('Oversized contact metadata');
        const value = record(JSON.parse(text) as unknown,['version','owner','profileName','entries']);
        if (value.version !== 1 || value.owner !== this.security.deviceId || !Array.isArray(value.entries) || value.entries.length > MAX_CONTACTS) throw new TypeError('Invalid contact metadata');
        const seen = new Set<string>();
        const entries = value.entries.map((input: unknown): Label => {
          const entry = record(input,['id','name','compared']);
          if (typeof entry.id !== 'string' || !FINGERPRINT.test(entry.id) || seen.has(entry.id) || typeof entry.compared !== 'boolean') throw new TypeError('Invalid contact binding');
          seen.add(entry.id);
          return Object.freeze({id:entry.id,name:normalizeName(entry.name),compared:entry.compared});
        });
        metadata = {profileName:normalizeName(value.profileName),entries};
      }
      this.metadata = metadata; this.loaded = true; this.failed = false;
    } catch { this.loaded = false; this.failed = true; }
    this.publish();
    });
    this.work = task; return task;
  };
  refreshKnownPeers(): void { this.publish(); }
  add(input: unknown, name = ''): Promise<{id:string; alreadySaved:boolean; nameSaved:boolean}> {
    const candidate = parsePublicIdentity(input);
    const label = normalizeName(name);
    if (this.importsPending >= 16) return Promise.reject(new Error('Contact import busy'));
    this.importsPending += 1; this.publish();
    const task = this.importWork.catch(() => undefined).then(async () => {
      const existed = this.security.savedPeerIds().includes(candidate.id);
      const id = await this.security.importPeer(candidate.identity);
      if (id !== candidate.id) throw new TypeError('Unexpected imported identity');
      this.publish();
      if (existed) return {id,alreadySaved:true,nameSaved:label.length === 0};
      if (label.length) {
        try { await this.rename(id,label); }
        catch { return {id,alreadySaved:false,nameSaved:false}; }
      }
      return {id,alreadySaved:false,nameSaved:true};
    });
    this.importWork = task.finally(() => { this.importsPending -= 1; this.publish(); });
    // The serial chain must not retain an unhandled rejected promise.
    this.importWork.catch(() => undefined);
    return task;
  }
  setProfileName(name: string): Promise<void> {
    const normalized = normalizeName(name);
    return this.mutate(metadata => ({...metadata,profileName:normalized}));
  }
  rename(id: string, name: string): Promise<void> {
    const normalized = normalizeName(name);
    return this.edit(id, entry => ({...entry,name:normalized}));
  }
  setCompared(id: string, compared: boolean): Promise<void> {
    if (typeof compared !== 'boolean') return Promise.reject(new TypeError('Invalid comparison'));
    return this.edit(id, entry => ({...entry,compared}));
  }
  private edit(id: string, update: (entry: Label) => Label): Promise<void> {
    return this.mutate(metadata => {
      if (!this.security.savedPeerIds().includes(id)) throw new TypeError('Only saved public identities may be annotated');
      const entries = [...metadata.entries];
      const index = entries.findIndex(entry => entry.id === id);
      if (index < 0) {
        if (entries.length >= MAX_CONTACTS) throw new TypeError('Contact metadata capacity reached');
        entries.push(update({id,name:'',compared:false}));
      } else entries[index] = update(entries[index]!);
      return {...metadata,entries};
    });
  }
  private mutate(update: (metadata: Metadata) => Metadata): Promise<void> {
    if (!this.loaded || this.pending >= 16) return Promise.reject(new Error('Contact metadata unavailable or busy'));
    this.pending += 1; this.publish();
    const result = this.work.catch(() => undefined).then(async () => {
      if (!this.loaded) throw new Error('Contact metadata requires recovery');
      const next = update(this.metadata);
      await this.vault.write(RECORD,JSON.stringify({version:1,owner:this.security.deviceId,...next}));
      this.metadata = next; this.failed = false;
    });
    const completed = result.catch(error => { this.failed = true; throw error; }).finally(() => { this.pending -= 1; this.publish(); });
    this.work = completed.catch(() => undefined);
    return completed;
  }
  private publish(): void {
    const labels = new Map(this.metadata.entries.map(entry => [entry.id,entry]));
    const contacts = this.security.savedPeerIds().map(id => ({id,name:labels.get(id)?.name ?? '',compared:labels.get(id)?.compared ?? false}));
    const names = new Map<string,number>();
    const canonical = (name: string): string => name.normalize('NFKC').toLocaleLowerCase('en-US');
    for (const contact of contacts) if (contact.name) names.set(canonical(contact.name),(names.get(canonical(contact.name)) ?? 0)+1);
    this.state = Object.freeze({profileName:this.metadata.profileName,loaded:this.loaded,saving:this.pending>0 || this.importsPending>0,error:this.failed,
      contacts:Object.freeze(contacts.map(entry => Object.freeze({...entry,duplicateName:!!entry.name && (names.get(canonical(entry.name)) ?? 0)>1}))) });
    for (const listener of this.listeners) { try { listener(); } catch { /* UI cannot invalidate a durable write. */ } }
  }
}
