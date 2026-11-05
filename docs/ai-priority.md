# On-device message priority

PalMesh estimates the urgency of each chat on the sending phone and uses it to
order store-and-forward queues across the mesh. It needs no internet, account,
cloud model or native module. The estimate helps the most urgent words travel
first when radio contact is brief. It is not a diagnosis and it never confirms
that anyone needs, receives or will provide help.

## Priorities

| Priority | Typical content | Queue rank |
| --- | --- | --- |
| SOS (separate kind) | The red SOS control or an escalated draft | 0, always first |
| `critical` | Life-threatening: bleeding, trapped, not breathing, fire | 1 |
| `high` | Urgent needs: water, medicine, evacuation, missing person | 2 |
| `normal` | Routine coordination | 3 |
| `low` | Greetings, thanks, acknowledgments | 4 |

Chat priority never borrows the SOS 15-hop budget, SOS reserved storage, or the
SOS-only forwarding allowed in power-conservation mode.

## How the estimate works

`src/features/ai/` contains a dependency-free multinomial naive Bayes model.
`normalizeText` folds Arabic diacritics, tatweel, alef/ya/ta-marbuta variants,
Arabic-Indic digits, letter elongation and case. Features are words, adjacent
word pairs and padded character trigrams, so Arabic clitics such as و، ب and ال
share evidence with the bare word. Long messages are capped to a fixed amount of
evidence so many repeated trigrams cannot become arbitrarily certain.

The authoritative curated signals and context data are in
`src/features/ai/data/curated-risk-lexicon.v1.json`, validated lazily at runtime.
This version migrates the existing project cues and adds contextual regressions.
The user-mentioned `palmesh_risk_lexicon_ar_en.json` was **not received** and has
not been integrated. Its provenance is not inferred or invented.

The rule layer scopes negation, resolved/reference/figurative use, attached Arabic
prefixes and exceptional danger phrases such as “not breathing.” It processes the
full bounded 4096-character body. Up to two cue boosts per class prevent repeated
keywords from creating unlimited evidence. These rules remain fallible; mixed
contexts and unseen dialect are not solved general language understanding.

Model shares/confidence are relative heuristic strength, not calibrated danger
probabilities. The composer omits percentages and keeps manual priority and SOS
choice. A malformed model/resource is caught by the chat assessment boundary and
ordinary text remains sendable at normal priority.

Training and the separate fixed bilingual holdout are reproducible:

```sh
npm run ai:train
npx tsx scripts/ai/train-priority-model.ts --check
npx tsx scripts/ai/evaluate-risk.ts
npx tsx scripts/ai/evaluate-risk.ts --check
```

The 440 training examples are distinct from the 64 normalized holdout messages.
See [measured evaluation and limitations](ai-risk-evaluation.md) and the complete
machine-readable report. This is synthetic author-labeled evaluation, not field,
clinical or independent human validation.

## Messaging behavior

- The composer shows the suggested priority and detected signals, with a visible estimate disclaimer. Tapping
  it cycles a manual choice (critical, urgent, normal, low) and back to the AI.
- A `critical` estimate crossing the internal heuristic-strength threshold offers **Send as SOS**. This is not a 70% danger probability.
  That publishes the draft text as a public SOS broadcast, and the prompt says so.
  **Keep as message** hides the suggestion for that draft.
- Messages show Critical/Urgent chips. Conversations with an unread SOS,
  critical or high message sort first and announce that to screen readers.
- A failing classifier never blocks a send. The chat goes out at normal priority.

## Wire format and abuse limits

Chat packets carry an optional `priority` of `critical`, `high` or `low`.
`normal` is omitted, so routine packets keep their earlier encoding and signature.
The field is accepted only on chat and is appended to the Ed25519-signed bytes
when present, so a relay cannot add, strip or raise it. Older builds reject
packets that carry the field; mixed-version meshes still relay normal chat.

Direct chat text stays end-to-end encrypted, but its priority is plaintext
metadata: relays and the recipient can see that a private message is urgent.

The sender's own app sets the priority, so a modified app could mark everything
critical. Each relay therefore ranks at most `maxElevatedPerSource` (default 20)
retained critical/high chats per source above normal. Further elevated packets
from that source are queued as normal locally, while the signed packet is
forwarded unchanged. When storage is full, a chat displaces only strictly
lower-priority chat, oldest first; SOS may displace any chat. See [DTN routing](dtn.md).

Existing sender SOS cooldown/hour/day limits, receiver notification limits and
per-source relay caps are unchanged. Classification cannot automatically send SOS
or grant extra reserved emergency slots. Optional public profile announcements
use normal signed chat with no classifier or elevated priority.
