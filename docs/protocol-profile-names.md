# Optional authenticated public display names

Entering a local profile name does not publish it. Name sharing isOFF bydefault.
The profile screen offers an explicit public-mesh consent control, warns that
relays/recipients see the name, and explains withdrawal cannot erase already
received copies. Notifications retain their existing generic privacy-preserving
text; no existing setting permits new name previews.

An opted-in announcement is a normal-priority signed public `chat` packet whose
text is a strict versioned JSON object:

```json
{"type":"palmesh-profile","version":1,"revision":1,"name":"Sara"}
```

There is no new wire kind, envelope field, priority, emergency budget, encryption
shortcut, directory server or key record. The existing signature authenticates
this text to its existing source fingerprint. The app verifies the signature
again before accepting a retained name. The payload cannot specify another
source, contains no private keys, and is never interpreted from encrypted private
chat or elevated-priority traffic. Existing private messages remain encrypted.
Older clients continue authenticating/relaying normal packets and may show this
explicit announcement as JSON text. New clients show a readable name-update card.
Ordinary messages are never wrapped or rewritten.

The original `contact-profile-v1` local names/comparison records are unchanged.
A separate owner-bound encrypted vault record, `profile-sharing-v1`, persists
consent, monotonic sender revisions, publication reservations and receiver floors.
A revision is reserved durably before normal DTN publication; failed queueing
never reuses it and never reports success. At most12 announcements perhour are
reserved, including failures. Restart never automatically broadcasts a name.
An enabled profile-name edit queues a new update after the local edit is durable;
a sharing failure leaves that local name intact and shows separate retry guidance.
Disabling sharing persistsOFF before an explicitly requested empty-name withdrawal.

For each of at most256 fingerprints, only a strictly newer signed revision can
replace a name. Equal revisions are first-payload-wins; empty-name withdrawal
records remain as replay floors. Capacity cannot evict an old floor. This applies
across out-of-order delivery, relays, restarts and sender-clock changes. It is
bounded local retention, not global revocation; peers that never receive a newer
revision can retain an older name, and deleting local app data destroys local
state. A compromised sender key can change its own name; signatures are not proof
of a person's name, role or qualifications. Existing Sybil-identity limitations
remain, and normal DTN quotas still apply.

Display precedence is receiver-chosen nickname, then authenticated self-declared
name, then short fingerprint. Local nicknames and manual fingerprint comparison
are never replaced by announcements. Shared names get a visible distinction;
duplicates include short IDs. Received names in chat, SOS and map details open
optional full-fingerprint details, including verification limits. Name updates
change current labels without rewriting historical message ownership, timestamps
or signatures. QR import stays public-keys-only and does not auto-compare a person.

Core tests use real Ed25519 signatures, DTN/SQLite delivery and failure cases;
UI tests cover precedence, duplicate names, explicit opt-in, failed queueing,
withdrawal, restart and optional fingerprint details. The emulator-only signed
SOS fixture also includes a normal signed profile from an unfamiliar identity.
Physical two-phone name exchange and withdrawal remain manual acceptance steps.

The chat summary formats announcements/withdrawals only for normal public chat.
Private chat, SOS and elevated traffic retain their literal text in both bubbles
and previews; profile-shaped text in those contexts never becomes a name update.
