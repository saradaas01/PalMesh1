export { PriorityClassifier } from './application/PriorityClassifier';
export type { PriorityClassifierOptions } from './application/PriorityClassifier';
export { normalizeText, tokenize, extractFeatures } from './domain/features';
export { matchCues } from './domain/signals';
export type { CueMatch } from './domain/signals';
export { validateRiskLexicon } from './domain/lexicon';
export type { MessageClassifier, MessagePriority, PriorityAssessment, PriorityModel } from './domain/types';
import { PriorityClassifier } from './application/PriorityClassifier';
import { PRIORITY_MODEL } from './model/priorityModel';

/** The bundled offline model. No network, account or native module is used. */
export function createPriorityClassifier(model: import('./domain/types').PriorityModel = PRIORITY_MODEL): import('./domain/types').MessageClassifier {
  let classifier: PriorityClassifier | undefined;
  return Object.freeze({ classify(text: string) {
    // ChatService catches assessment errors and sends at normal priority. Lazy
    // construction preserves that behavior for corrupt model/lexicon resources.
    classifier ??= new PriorityClassifier(model);
    return classifier.classify(text);
  } });
}
