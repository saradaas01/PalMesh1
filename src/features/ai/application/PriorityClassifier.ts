import type { MessagePriority } from '../../dtn/domain/types';
import { extractFeatures, tokenize } from '../domain/features';
import { analyzeCues } from '../domain/signals';
import { bundledRiskLexicon } from '../domain/lexicon';
import type { MessageClassifier, PriorityAssessment, PriorityModel } from '../domain/types';

export interface PriorityClassifierOptions {
  /** Long messages contribute at most this many features' worth of evidence,
   * so a paragraph cannot become arbitrarily certain from repeated trigrams. */
  readonly evidenceWindow?: number;
  /** Log-odds added to a class for each matching curated cue. */
  readonly cueBoost?: Readonly<Record<Exclude<MessagePriority, 'normal'>, number>>;
  readonly sosThreshold?: number;
}

const DEFAULT_CUE_BOOST = Object.freeze({ critical: 8, high: 3, low: 2.5 });
const MAX_SIGNALS = 4;
// Function words can carry statistical weight but explain nothing to a person.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'is', 'an', 'on', 'in', 'of', 'to', 'he', 'she', 'we', 'my', 'his', 'her',
  'our', 'you', 'there', 'with', 'from', 'need', 'please', 'any', 'anyone', 'someone', 'have', 'has', 'was', 'were', 'been', 'not', 'no', 'can', 'cannot', 'because', 'still',
  'في', 'من', 'علي', 'عن', 'مع', 'هو', 'هي', 'احنا', 'انا', 'بدنا', 'بدي', 'وين', 'اللي', 'هون', 'خلص',
  'حدا', 'عنده', 'عندها', 'كتير', 'الله', 'يخليكم', 'ما', 'مش', 'لا', 'كان', 'صار',
]);

/** Multinomial naive Bayes over bundled weights, combined with curated cues.
 * Runs synchronously on the device over the bounded message body. */
export class PriorityClassifier implements MessageClassifier {
  private readonly evidenceWindow: number;
  private readonly cueBoost: Readonly<Record<Exclude<MessagePriority, 'normal'>, number>>;
  private readonly sosThreshold: number;

  constructor(private readonly model: PriorityModel, options: PriorityClassifierOptions = {}) {
    if (model.version !== 1 || model.classes.length !== model.priors.length || model.classes.length === 0) {
      throw new TypeError('Unsupported priority model');
    }
    for (const priority of ['critical', 'high', 'normal', 'low'] as const) {
      if (!model.classes.includes(priority)) throw new TypeError(`Priority model lacks class ${priority}`);
    }
    if (new Set(model.classes).size !== 4 || model.priors.some(value => !Number.isFinite(value))
      || Object.values(model.features).some(weights => weights.length !== 4 || weights.some(value => !Number.isFinite(value)))) {
      throw new TypeError('Invalid priority model weights');
    }
    bundledRiskLexicon();
    this.evidenceWindow = options.evidenceWindow ?? 6;
    this.cueBoost = options.cueBoost ?? DEFAULT_CUE_BOOST;
    this.sosThreshold = options.sosThreshold ?? 0.7;
  }

  classify(text: string): PriorityAssessment {
    const classes = this.model.classes;
    const analysis = analyzeCues(typeof text === 'string' ? text : '');
    const features = extractFeatures(analysis.evidenceText);
    if (features.length === 0) {
      return Object.freeze({
        priority: 'normal', confidence: 0, signals: Object.freeze([]), suggestSos: false,
        scores: Object.freeze({ critical: 0, high: 0, normal: 1, low: 0 }),
      });
    }
    const evidence = classes.map(() => 0);
    let known = 0;
    for (const feature of features) {
      const weights = this.model.features[feature];
      if (!weights) continue;
      known += 1;
      weights.forEach((weight, index) => { evidence[index]! += weight; });
    }
    const scale = known > this.evidenceWindow ? this.evidenceWindow / known : 1;
    const logits = classes.map((_priority, index) => this.model.priors[index]! + evidence[index]! * scale);
    const cues = analysis.matches;
    const boosted = new Map<string, number>();
    for (const match of cues) {
      const count = boosted.get(match.priority) ?? 0;
      if (count >= 2) continue;
      boosted.set(match.priority, count + 1);
      const index = classes.indexOf(match.priority);
      logits[index]! += this.cueBoost[match.priority];
    }
    // A word explicitly denied/resolved/used as fiction is not active danger.
    // Another active danger or resource request in the same message overrides
    // this guard. Manual priority and the SOS control remain available.
    if (analysis.inactiveDangerCues > 0 && !cues.some(cue => cue.priority === 'critical' || cue.priority === 'high')) {
      logits[classes.indexOf('critical')] = Number.NEGATIVE_INFINITY;
      logits[classes.indexOf('high')] = Number.NEGATIVE_INFINITY;
    }
    const maximum = Math.max(...logits);
    const exponentials = logits.map(logit => Math.exp(logit - maximum));
    const total = exponentials.reduce((sum, value) => sum + value, 0);
    const probabilities = exponentials.map(value => value / total);
    let best = 0;
    probabilities.forEach((probability, index) => { if (probability > probabilities[best]!) best = index; });
    const priority = classes[best]!;
    const scores = { critical: 0, high: 0, normal: 0, low: 0 };
    classes.forEach((name, index) => { scores[name] = round(probabilities[index]!); });
    const confidence = round(probabilities[best]!);
    return Object.freeze({
      priority, confidence, scores: Object.freeze(scores),
      signals: Object.freeze(this.signals(analysis.evidenceText, priority, best, cues.filter(match => match.priority === priority).map(match => match.cue))),
      suggestSos: priority === 'critical' && confidence >= this.sosThreshold,
    });
  }

  /** Explain an estimate with matching cues first, then the words whose learned
   * weights most favor the chosen priority over the other priorities. */
  private signals(text: string, priority: MessagePriority, index: number, cues: readonly string[]): string[] {
    // Prefer the most specific cue: "under the rubble" already explains "rubble".
    const signals = [...new Set(cues)].filter((cue, _index, all) =>
      !all.some(other => other !== cue && other.includes(cue)));
    if (priority === 'normal') return signals.slice(0, MAX_SIGNALS);
    const words = [...new Set(tokenize(text))].map(word => {
      const weights = this.model.features[`w:${word}`];
      if (!weights || word.length < 3 || STOPWORDS.has(word)) return null;
      const others = weights.filter((_weight, other) => other !== index);
      return { word, lift: weights[index]! - Math.max(...others) };
    }).filter((entry): entry is { word: string; lift: number } => entry !== null && entry.lift > 0.5)
      .sort((a, b) => b.lift - a.lift);
    for (const { word } of words) {
      if (signals.length >= MAX_SIGNALS) break;
      if (!signals.some(signal => signal.split(' ').includes(word))) signals.push(word);
    }
    return signals.slice(0, MAX_SIGNALS);
  }
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
