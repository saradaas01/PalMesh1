export { PriorityClassifier } from './application/PriorityClassifier';
export type { PriorityClassifierOptions } from './application/PriorityClassifier';
export { normalizeText, tokenize, extractFeatures } from './domain/features';
export { matchCues } from './domain/signals';
export type { CueMatch } from './domain/signals';
export type { MessageClassifier, MessagePriority, PriorityAssessment, PriorityModel } from './domain/types';
import { PriorityClassifier } from './application/PriorityClassifier';
import { PRIORITY_MODEL } from './model/priorityModel';

/** The bundled offline model. No network, account or native module is used. */
export function createPriorityClassifier(): PriorityClassifier {
  return new PriorityClassifier(PRIORITY_MODEL);
}
