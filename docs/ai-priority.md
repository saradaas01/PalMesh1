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

A curated cue lexicon (`domain/signals.ts`) adds log-odds for Arabic and English
phrases. Cues favor recall for life-threatening wording, where a missed emergency
costs more than a false alarm. Each estimate returns per-priority probabilities,
a confidence and up to four short signals that explain it, for example
`تحت الركام` or `not breathing`. Classification takes well under a millisecond.

The training corpus, `scripts/ai/priority-corpus.json`, is a small hand-written
seed set of Palestinian dialect, Modern Standard Arabic and English messages.
Retrain after changing the corpus, the cues' normalization or the features:

```sh
npm run ai:train                                  # 5-fold evaluation, then write the model
npx tsx scripts/ai/train-priority-model.ts --check  # fail if the bundled model is stale
```

Training is deterministic. A core test asserts that the committed
`src/features/ai/model/priorityModel.ts` equals a fresh training run. The
current corpus scores about 86% stratified 5-fold accuracy, with about 96%
recall for `critical`. Those numbers describe the seed corpus, not real traffic.
Collect consented, de-identified field examples before relying on them.

## Messaging behavior

- The composer shows the live estimate, its confidence and its signals. Tapping
  it cycles a manual choice (critical, urgent, normal, low) and back to the AI.
- A `critical` estimate with at least 70% confidence offers **Send as SOS**.
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
