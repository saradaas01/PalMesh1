import type { MessagePriority } from '../../dtn/domain/types';
import { normalizeText } from './features';
import { bundledRiskLexicon, type RiskLexicon } from './lexicon';

export interface CueMatch { readonly priority: Exclude<MessagePriority, 'normal'>; readonly cue: string; }
export interface CueAnalysis {
  readonly matches: readonly CueMatch[];
  readonly evidenceText: string;
  readonly inactiveDangerCues: number;
}
function variants(token: string, lexicon: RiskLexicon): readonly string[] {
  const forms = [token];
  for (const prefix of lexicon.context.arabicPrefixes) {
    if (token.startsWith(prefix) && token.length - prefix.length >= 2) forms.push(token.slice(prefix.length));
  }
  return forms;
}
function includesPhrase(text: string, phrase: string): boolean { return (` ${text} `).includes(` ${phrase} `); }
function contains(text: string, phrases: readonly string[], lexicon: RiskLexicon): boolean {
  const words = text.split(' ').filter(Boolean).map(word => variants(word, lexicon));
  return phrases.some(phrase => {
    const parts = phrase.split(' ');
    return words.some((_word, start) => start + parts.length <= words.length && parts.every((part, offset) => words[start+offset]!.includes(part)));
  });
}
function spans(forms: readonly (readonly string[])[], phrase: string): readonly { start: number; end: number }[] {
  const parts = phrase.split(' '); const found: { start: number; end: number }[] = [];
  for (let start = 0; start + parts.length <= forms.length; start += 1) {
    if (parts.every((part, offset) => forms[start+offset]!.includes(part))) found.push({ start, end: start+parts.length });
  }
  return found;
}
function negationBefore(text: string, phrases: readonly string[], lexicon: RiskLexicon): boolean {
  const words = text.split(' ').filter(Boolean); const forms = words.map(word => variants(word,lexicon));
  return phrases.some(phrase => spans(forms,phrase).some(span =>
    forms.slice(span.end).every(word => word.some(form => lexicon.context.negationFillers.includes(form)))));
}
function startsAfterLinking(text: string, phrases: readonly string[], lexicon: RiskLexicon): boolean {
  const forms = text.split(' ').filter(Boolean).map(word => variants(word,lexicon));
  return phrases.some(phrase => spans(forms,phrase).some(span => span.start <= 2
    && forms.slice(0,span.start).every(word => word.some(form => lexicon.context.resolutionFillers.includes(form)))));
}

/** Scope each occurrence: a denied fire must not erase a real breathing crisis.
 * This bounded rule layer is not a general language understanding guarantee. */
export function analyzeCues(text: string, lexicon: RiskLexicon = bundledRiskLexicon()): CueAnalysis {
  const matches: CueMatch[] = []; const evidence: string[] = []; let inactiveDangerCues = 0;
  const full = normalizeText(text); const fullWords = full.split(' '); const fullForms = fullWords.map(word => variants(word,lexicon));
  const safelyResolved = lexicon.context.safeResolution.some(phrase => spans(fullForms,phrase).some(span =>
    !negationBefore(fullWords.slice(Math.max(0,span.start-4),span.start).join(' '),lexicon.context.negators,lexicon)));
  const clauses = text.slice(0, 4_096).split(/[.!?؟؛;,،\n]+|\b(?:and|but|however|yet)\b|(?:\s+(?:لكن(?:ه|ها|هم)?|بس)\s+)/iu);
  for (const raw of clauses) {
    const normalized = normalizeText(raw); if (!normalized) continue;
    const words = normalized.split(' '); const forms = words.map(word => variants(word, lexicon));
    const inactive = new Set<number>();
    const reference = lexicon.context.reference.some(phrase => spans(forms,phrase).some(span =>
      !contains(words.slice(Math.max(0,span.start-4),span.start).join(' '),lexicon.context.negators,lexicon)));
    const figurative = lexicon.context.figurative.flatMap(phrase => spans(forms,phrase));
    if (reference || figurative.length) inactiveDangerCues += 1;
    for (const span of figurative) for (let i=span.start;i<span.end;i+=1) inactive.add(i);
    const occurrences: { priority: CueMatch['priority']; cue: string; start: number; end: number; active: boolean }[] = [];
    for (const entry of lexicon.entries) {
      const cueWords = entry.phrase.split(' ');
      for (let start = 0; start + cueWords.length <= words.length; start += 1) {
        if (!cueWords.every((word, offset) => forms[start + offset]!.includes(word))) continue;
        const end = start + cueWords.length;
        const before = words.slice(Math.max(0, start - 4), start).join(' ');
        const after = words.slice(end, Math.min(words.length, end + 5)).join(' ');
        const exception = lexicon.context.criticalNegationExceptions.includes(entry.phrase);
        const resource = lexicon.context.resourceNeeds.includes(entry.phrase);
        const negated = negationBefore(before, lexicon.context.needNegations, lexicon)
          || (!resource && !exception && negationBefore(before, lexicon.context.negators, lexicon))
          || (!exception && (startsAfterLinking(after,lexicon.context.postNeedNegations,lexicon)
            || (!resource && startsAfterLinking(after,lexicon.context.postNegations,lexicon))));
        const nearby = words.slice(Math.max(0,start-3),Math.min(words.length,end+5)).join(' ');
        const ended = startsAfterLinking(after, lexicon.context.resolved, lexicon)
          || lexicon.context.resolved.some(phrase => includesPhrase(phrase,entry.phrase) && contains(nearby,[phrase],lexicon))
          || includesPhrase(before,'no longer')
          || (safelyResolved && contains(before,lexicon.context.pastMarkers,lexicon) && !contains(normalized,lexicon.context.persistenceMarkers,lexicon));
        const figurativeUse = figurative.some(span => start<span.end && end>span.start);
        const active = entry.priority === 'low' || !(reference || figurativeUse || negated || ended);
        occurrences.push({ priority: entry.priority, cue: entry.phrase, start, end, active });
        if (!active) { for (let i = start; i < end; i += 1) inactive.add(i); inactiveDangerCues += 1; }
      }
    }
    const active = occurrences.filter(item => item.active).sort((a, b) => (b.end-b.start)-(a.end-a.start));
    const covered = new Set<number>();
    for (const match of active) {
      for (let i = match.start; i < match.end; i += 1) inactive.delete(i);
      if (Array.from({ length: match.end-match.start }, (_, i) => match.start+i).every(i => covered.has(i))) continue;
      for (let i = match.start; i < match.end; i += 1) covered.add(i);
      matches.push({ priority: match.priority, cue: match.cue });
    }
    evidence.push(words.filter((_word, index) => !inactive.has(index)).join(' '));
  }
  const unique = matches.filter((match, index) => matches.findIndex(other => other.priority === match.priority && other.cue === match.cue) === index);
  return Object.freeze({ matches: Object.freeze(unique), evidenceText: evidence.join(' '), inactiveDangerCues });
}
export function matchCues(text: string): CueMatch[] { return [...analyzeCues(text).matches]; }
