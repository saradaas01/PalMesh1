import type { MessagePriority } from '../../dtn/domain/types';
import { extractFeatures } from './features';
import { analyzeCues } from './signals';
import type { PriorityModel } from './types';

export interface LabeledMessage {
  readonly text: string;
  readonly priority: MessagePriority;
}

export const MODEL_CLASSES: readonly MessagePriority[] = Object.freeze(['critical', 'high', 'normal', 'low']);

/** Heuristic class priors, not measured real-world prevalence or danger risk. */
export const BASE_RATES: Readonly<Record<MessagePriority, number>> = Object.freeze({
  critical: 0.1, high: 0.2, normal: 0.45, low: 0.25,
});

export interface TrainingOptions {
  /** A feature must occur in at least this many messages to enter the model. */
  readonly minDocuments?: number;
  /** Additive (Laplace) smoothing. */
  readonly smoothing?: number;
}

/** Deterministic multinomial naive Bayes. Each feature's log-likelihoods are
 * centered across classes, which preserves every decision and keeps weights small. */
export function trainPriorityModel(examples: readonly LabeledMessage[], options: TrainingOptions = {}): PriorityModel {
  const minDocuments = options.minDocuments ?? 2;
  const smoothing = options.smoothing ?? 1;
  const documents = new Map<string, number>();
  const extracted = examples.map(example => {
    const features = extractFeatures(analyzeCues(example.text).evidenceText);
    for (const feature of new Set(features)) documents.set(feature, (documents.get(feature) ?? 0) + 1);
    return { priority: example.priority, features };
  });
  const vocabulary = [...documents].filter(([, count]) => count >= minDocuments).map(([feature]) => feature).sort();
  const indexOf = new Map(vocabulary.map((feature, index) => [feature, index]));
  const counts = MODEL_CLASSES.map(() => new Float64Array(vocabulary.length));
  const totals = MODEL_CLASSES.map(() => 0);
  for (const { priority, features } of extracted) {
    const classIndex = MODEL_CLASSES.indexOf(priority);
    if (classIndex < 0) throw new TypeError(`Unknown training priority: ${String(priority)}`);
    for (const feature of features) {
      const index = indexOf.get(feature);
      if (index === undefined) continue;
      counts[classIndex]![index]! += 1;
      totals[classIndex]! += 1;
    }
  }
  const features: Record<string, readonly number[]> = {};
  vocabulary.forEach((feature, index) => {
    const logs = MODEL_CLASSES.map((_priority, classIndex) =>
      Math.log((counts[classIndex]![index]! + smoothing) / (totals[classIndex]! + smoothing * vocabulary.length)));
    const mean = logs.reduce((sum, value) => sum + value, 0) / logs.length;
    features[feature] = logs.map(value => Math.round((value - mean) * 1_000) / 1_000);
  });
  return {
    version: 1,
    classes: MODEL_CLASSES,
    priors: MODEL_CLASSES.map(priority => Math.round(Math.log(BASE_RATES[priority]) * 1_000) / 1_000),
    features,
  };
}
