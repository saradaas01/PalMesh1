import type { MessagePriority } from '../../dtn/domain/types';
import { normalizeText } from './features';

export interface RiskEntry {
  readonly id: string;
  readonly priority: Exclude<MessagePriority, 'normal'>;
  readonly language: 'ar' | 'en';
  readonly phrase: string;
}
export interface RiskContext {
  readonly arabicPrefixes: readonly string[];
  readonly negators: readonly string[];
  readonly needNegations: readonly string[];
  readonly resolved: readonly string[];
  readonly reference: readonly string[];
  readonly figurative: readonly string[];
  readonly criticalNegationExceptions: readonly string[];
  readonly resourceNeeds: readonly string[];
  readonly negationFillers: readonly string[];
  readonly resolutionFillers: readonly string[];
  readonly postNegations: readonly string[];
  readonly postNeedNegations: readonly string[];
  readonly safeResolution: readonly string[];
  readonly pastMarkers: readonly string[];
  readonly persistenceMarkers: readonly string[];
}
export interface RiskLexicon {
  readonly schemaVersion: 1;
  readonly source: { readonly kind: string; readonly description: string };
  readonly entries: readonly RiskEntry[];
  readonly context: RiskContext;
}
const CONTEXT_KEYS = ['arabicPrefixes', 'negators', 'needNegations', 'resolved', 'reference', 'figurative', 'criticalNegationExceptions', 'resourceNeeds', 'negationFillers', 'resolutionFillers', 'postNegations', 'postNeedNegations', 'safeResolution', 'pastMarkers', 'persistenceMarkers'] as const;
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Invalid risk lexicon object');
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (Object.keys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) throw new TypeError('Unexpected risk lexicon fields');
}
function string(value: unknown, limit: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new TypeError('Invalid risk lexicon string');
  return value;
}
/** Data only: matching words/context exceptions share one versioned resource. */
export function validateRiskLexicon(raw: unknown): RiskLexicon {
  const root = object(raw); keys(root, ['schemaVersion', 'source', 'entries', 'context']);
  if (root.schemaVersion !== 1) throw new TypeError('Unsupported risk lexicon version');
  const source = object(root.source); keys(source, ['kind', 'description']);
  const provenance = Object.freeze({ kind: string(source.kind, 80), description: string(source.description, 600) });
  if (!Array.isArray(root.entries) || root.entries.length === 0 || root.entries.length > 2_000) throw new TypeError('Invalid risk lexicon entries');
  const ids = new Set<string>(); const phrases = new Set<string>();
  const entries = root.entries.map((input): RiskEntry => {
    const entry = object(input); keys(entry, ['id', 'priority', 'language', 'phrase']);
    const id = string(entry.id, 100); const phrase = normalizeText(string(entry.phrase, 160));
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id) || ids.has(id) || phrases.has(phrase) || !phrase) throw new TypeError('Duplicate or invalid risk lexicon entry');
    if (entry.priority !== 'critical' && entry.priority !== 'high' && entry.priority !== 'low') throw new TypeError('Invalid risk priority');
    if (entry.language !== 'ar' && entry.language !== 'en') throw new TypeError('Invalid risk language');
    ids.add(id); phrases.add(phrase);
    return Object.freeze({ id, priority: entry.priority, language: entry.language, phrase });
  });
  const context = object(root.context); keys(context, CONTEXT_KEYS);
  const normalized: Partial<Record<keyof RiskContext, readonly string[]>> = {};
  for (const key of CONTEXT_KEYS) {
    const values = context[key];
    if (!Array.isArray(values) || values.length === 0 || values.length > 300) throw new TypeError('Invalid risk context list');
    normalized[key] = Object.freeze([...new Set(values.map(value => normalizeText(string(value, 160))))]);
    if (normalized[key]!.some(value => !value)) throw new TypeError('Empty normalized risk context');
  }
  return Object.freeze({ schemaVersion: 1, source: provenance, entries: Object.freeze(entries), context: Object.freeze(normalized as unknown as RiskContext) });
}
let bundled: RiskLexicon | undefined;
export function bundledRiskLexicon(): RiskLexicon {
  // Static require includes the JSON in Metro's offline bundle. Validation is
  // lazy so a malformed classifier resource cannot block chat startup.
  return bundled ??= validateRiskLexicon(require('../data/curated-risk-lexicon.v1.json'));
}
