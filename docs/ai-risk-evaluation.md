# Risk assessment evaluation

The fixed `scripts/ai/risk-holdout.v1.json` contains64 manually authored synthetic
messages:32 Arabic/32 English, eight examples per priority per language. None
is a normalized duplicate of the440 training examples. The set was frozen before
its first evaluation; it is not used to train the weights. Labels are author
judgments, not independent adjudication or medical/field validation. Balanced
classes do not represent deployment prevalence.

Reproduce with `npx tsx scripts/ai/evaluate-risk.ts --check`; retraining is checked
separately with `npx tsx scripts/ai/train-priority-model.ts --check`.
[JSON results](ai-risk-evaluation.json) record input hashes, full confusion matrices,
all errors and limitations. Scores cover the rules plus model together.

| Scope | Critical TP | FP | FN | Precision | Recall | F1 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Overall64 |16|6|0|72.73%|100%|84.21%|
| Arabic32 |8|3|0|72.73%|100%|84.21%|
| English32 |8|3|0|72.73%|100%|84.21%|

False-positive critical predictions include two high-urgency ambulance requests,
two resolved-fire variants and two historical-report variants. Four low messages
were classified normal, and one Arabic high request normal. These errors remain
visible in the report; no failed example was removed to improve the numbers.
Zero missed critical cases in this small set does not establish real-world safety
or accuracy. The hard-negative regression suite additionally covers no-fire,
not-breathing, figurative jokes, references, mixed clauses and resource scarcity.
Manual priority and explicit user-controlled SOS remain necessary.

The provided-file requirement remains open: `palmesh_risk_lexicon_ar_en.json` was
mentioned but not attached. The committed JSON is explicitly a project-derived
baseline. Import/review that actual file and rerun evaluation when it is available.
