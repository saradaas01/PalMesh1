import { utf8Encode } from '../mesh/domain/wire';
import { normalizeName } from './ContactDirectory';

export interface ProfileAnnouncement {
  readonly type: 'palmesh-profile';
  readonly version: 1;
  readonly revision: number;
  /** Empty means a withdrawal, not a new identity or a nickname deletion. */
  readonly name: string;
}

/** Read a flat JSON object without allowing duplicate (including escaped) keys.
 * The JSON parser still validates all syntax; this scan preserves key count
 * information that JSON.parse would otherwise discard. */
function uniqueFlatKeys(text: string): boolean {
  const keys = new Set<string>();
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '{' || character === '[') { depth += 1; continue; }
    if (character === '}' || character === ']') { depth -= 1; continue; }
    if (character !== '"') continue;
    const start = index++;
    while (index < text.length && text[index] !== '"') {
      if (text[index] === '\\') index += 1;
      index += 1;
    }
    let next = index + 1;
    while (/\s/u.test(text[next] ?? '') && next < text.length) next += 1;
    if (text[next] !== ':') continue;
    if (depth !== 1) return false;
    const key: unknown = JSON.parse(text.slice(start, index + 1));
    if (typeof key !== 'string' || keys.has(key)) return false;
    keys.add(key);
  }
  return keys.size === 4;
}

/** Only signed public chat packets may supply this payload to a name service. */
export function parseProfileAnnouncement(text: unknown): ProfileAnnouncement | null {
  if (typeof text !== 'string' || text.length > 1024 || utf8Encode(text).length > 1024) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value) || !uniqueFlatKeys(text)) return null;
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length !== 4 || keys.some(key => !['type', 'version', 'revision', 'name'].includes(key))
      || record.type !== 'palmesh-profile' || record.version !== 1
      || typeof record.revision !== 'number' || !Number.isSafeInteger(record.revision) || record.revision <= 0
      || typeof record.name !== 'string' || normalizeName(record.name) !== record.name) return null;
    return Object.freeze({ type: 'palmesh-profile', version: 1, revision: record.revision, name: record.name });
  } catch { return null; }
}

export function encodeProfileAnnouncement(revision: number, name: string): string {
  const text = JSON.stringify({ type: 'palmesh-profile', version: 1, revision, name: normalizeName(name) });
  if (!parseProfileAnnouncement(text)) throw new TypeError('Invalid shared profile announcement');
  return text;
}
