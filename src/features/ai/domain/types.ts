import type { MessagePriority } from '../../dtn/domain/types';

export type { MessagePriority } from '../../dtn/domain/types';

/** Bundled, dependency-free weights. Values are natural-log probabilities. */
export interface PriorityModel {
  readonly version: 1;
  readonly classes: readonly MessagePriority[];
  readonly priors: readonly number[];
  /** Per-class log-likelihoods for each feature, centered across classes.
   * Features absent from the model contribute no evidence. */
  readonly features: Readonly<Record<string, readonly number[]>>;
}

/** A local estimate of urgency. It informs routing order and UI only; it is
 * not a diagnosis and does not prove that anyone needs or will receive help. */
export interface PriorityAssessment {
  readonly priority: MessagePriority;
  /** Relative model strength, from 0 to 1; not calibrated danger probability. */
  readonly confidence: number;
  /** Normalized model shares for comparison, not clinical risk probabilities. */
  readonly scores: Readonly<Record<MessagePriority, number>>;
  /** Short normalized words or phrases that explain the estimate. */
  readonly signals: readonly string[];
  /** True when the text reads like a life-threatening emergency. */
  readonly suggestSos: boolean;
}

export interface MessageClassifier {
  classify(text: string): PriorityAssessment;
}
