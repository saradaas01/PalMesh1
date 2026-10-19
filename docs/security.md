# PalMesh security model

PalMesh now requires a native secure vault and SQLCipher in the application host. It refuses to start when key storage, operating-system randomness or encrypted database support is unavailable. The reusable domain and DTN modules still allow test transports without security; the native app supplies `SecurityService` to both DTN admission and mesh sessions.

This protocol has not received an independent cryptographic audit. Automated tests and a successful build do not establish safety for a crisis deployment. Obtain an external review and complete the physical-device acceptance procedure before distributing a production release.

## Identity and contact verification

Each installation generates separate Ed25519 signing and X25519 encryption secrets using the operating-system CSPRNG. Its address is `pm1:` followed by a SHA-256 fingerprint of both public keys with a protocol domain separator. A signed handshake proves possession of the signing secret for this address. It does not establish a person's name, humanitarian role or trustworthiness.

Compare the complete fingerprint through a trusted channel, preferably in person. Import the complete public identity record, containing only `signingKey` and `encryptionKey`, to address a person who has not yet connected directly. Importing a record pins it against automatic directory eviction; it does not claim that a human verified it. Public identities learned from authenticated encounters and signed packets can be used for offline queued messaging. The directory holds at most 256 identities; imported contacts remain pinned and saving another contact fails when every slot is pinned.

Identity and database secrets must never enter source control, logs, clipboard exports or peer packets. Corrupt, unreadable or missing wrapping keys for existing native records cause an error. They never trigger an automatic replacement identity. Losing the vault or uninstalling without an approved recovery plan can permanently remove access to prior messages. Identity rotation, revocation, authenticated recovery and multi-device identity transfer are not implemented.

## Direct-message confidentiality

Direct chat uses X25519 key agreement, HKDF-SHA-256 and XChaCha20-Poly1305 with a fresh 24-byte random nonce. The key derivation and authenticated additional data bind the protocol version, UUID, sender, destination, timestamp and packet kind. The sender signs the ciphertext, both public keys, encryption parameters and immutable envelope fields with Ed25519.

The DTN routing database and radio frames retain the sealed ciphertext. Application-layer endpoint projections decrypt for the sender or destination. Relays cannot produce chat history or plaintext accepted events for transit messages. A recipient authenticates its ciphertext before its DTN receiver returns a durable acceptance result. Sender history can decrypt its own retained ciphertext after a restart using its original vault keys.

The current design uses static X25519 identities to support queued messages without an interactive recipient. It provides **no forward secrecy or post-compromise recovery**: theft of an endpoint's encryption secret can expose previously recorded conversations involving that endpoint. No double-ratchet or asynchronous prekey protocol is implemented. JavaScript and native bridge strings are not reliably erasable; working keys and plaintext exist in process memory while the app runs.

Broadcast SOS text, SOS response statements, shared locations and routing metadata remain readable by mesh participants. Encryption of direct chat does not conceal device fingerprints, destinations, timing, proximity or radio activity. Location sharing is optional; consider the consequence of disclosing coordinates before enabling it. A signed SOS response proves that a key holder sent a statement of intent, not that assistance has arrived.

## Mesh admission and forwarding

Handshake signatures bind each peer's identity to a UUID nonce and the acknowledgment to the remote nonce. Both challenges and both authenticated identities enter a per-session HKDF context derived from X25519. Every subsequent packet frame, ready confirmation, ACK and NACK carries an HMAC-SHA-256 authentication tag. The receiver also checks its session nonce and correlates ACKs with both the pending transfer UUID and message UUID. Replayed ACKs from another session and modified ACKs cannot establish local custody.

Packet signatures bind their source fingerprint and immutable content. A signed hash-chain commitment binds the originating hop budget to a mutable proof; honest forwarding hashes that proof once and decrements TTL once per edge. A holder of a current lower-TTL proof cannot compute an earlier proof to increase it. A malicious participant that saved an earlier higher-TTL packet can replay that earlier packet; cryptography cannot force a compromised relay to execute the routing algorithm. Durable UUID deduplication prevents a stored duplicate from upgrading its TTL or creating a new delivery event.

Normal packets start with 10 hops; SOS and SOS responses start with 15. New network admissions reject unsigned packets, packets older than 24 hours and timestamps more than five minutes in the future. Devices need reasonably aligned clocks. Authenticated retained history is rechecked after restart without applying the new-admission age window. History authenticity checks do not consume the network signature budget.

Signature verification admits a burst of 64 uncached network verifications and refills at 64 per second. A bounded 256-entry positive cache binds each signature to the signed-content digest. Packets, frames, concurrent receives, peer discovery, stored UUIDs and routing queues have separate size/capacity limits. These limits reduce resource exhaustion; they do not defeat radio jamming, traffic analysis, malicious dropping, Sybil identities or a determined nearby flood. Low-battery routing retains emergency priority, subject to operating-system radio and background execution restrictions.

## Persistence

Android stores authenticated-encrypted vault records in its no-backup directory. AES-256-GCM uses a nonexportable Android Keystore wrapping key, preferring StrongBox where supported and otherwise using Android Keystore. Hardware backing depends on the device. Writes use `AtomicFile`, and an unreadable existing record cannot be silently overwritten. iOS uses non-synchronizing, device-only Keychain records available after the first unlock following a reboot.

Application databases require SQLCipher with random secrets held in the vault. The host verifies encrypted database support and uses the existing database paths. Existing unencrypted or corrupt files fail closed; the app does not delete them, create an alternate empty history, or silently fall back to plaintext. Migrating a previous plaintext installation requires a separately reviewed migration/recovery procedure.

First-install provisioning saves the device identity before creating the database key. If either native write is interrupted, retry reconstructs the app resources and reads the durable records again. A completed write whose bridge response failed is reused, and an existing database key always requires the established identity before any database opens. Retry never rotates existing identity or database secrets.

Startup reports fixed error categories rather than native exception text, paths or key material. For temporarily unavailable secure storage, unlock the device and retry. For a build without encryption support, obtain a correctly built app. If the app reports identity or data recovery, preserve the installed app, vault records and databases; do not uninstall, clear app storage, replace keys or attempt an automatic reset. Recovery requires a separately reviewed procedure. Secure setup interrupted before completion can be retried without deleting existing records.

Encrypted storage protects closed files, subject to the operating system and key protection. It does not protect an unlocked compromised endpoint, screenshots, a malicious keyboard, authorized recipients copying plaintext or keys accessible to an attached debugger in a development build. Debug APKs are for controlled testing only. Signed production distribution requires an owner-controlled release key that remains outside this repository.

## Verification and remaining review

### Dependency advisories

The dependency review on October 20, 2026 updated `uuid` from 11.1.0 to 11.1.1 for [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq), which adds supplied-buffer bounds checks to UUID v3, v5 and v6. PalMesh generates UUIDs through `v4()` without caller-supplied buffers, but includes the compatible patched release rather than retaining the affected package.

`npm audit --omit=dev` still reports high-severity [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) for `braces` 3.0.3 and its dependent packages. The registry has no patched `braces` release as of this review. React Native's package dependency graph includes its CLI and Metro tooling, so the audit also labels React Native and native-library peer dependencies affected. These entries trace to the same nested-glob stack-exhaustion advisory; they are not separate radio vulnerabilities. `braces` is used by build-time file-glob tooling, not by PalMesh packet handling or application screens. A deeply nested malicious glob pattern can terminate a build process. Build only reviewed repository configuration; do not feed untrusted glob patterns into CLI, Metro or test commands. Keep the advisory visible and update to a compatible patched release when one becomes available. This scope assessment does not replace independent review or imply that an audit has passed without findings.

`tests/security.test.ts` covers identity restart/corruption and entropy failure, ciphertext-only relay persistence, sender/recipient decryption, immutable-field tampering, hop-proof tampering, malformed/unsigned/expired packet rejection, handshake nonce replay, session ACK authentication, real fragmented simulated radio delivery, forged radio ACK custody rejection, retained public-history authentication, signature-flood bounds and key-directory persistence failure. `tests/encrypted-storage.test.ts` additionally exercises interrupted identity/key writes, native writes that commit before rejecting, locked-vault retry with unchanged keys, existing-key/missing-identity refusal, sanitized native failures and cleanup exceptions. The tests simulate radios; they do not replace tests on actual Android and iOS hardware.

Before field release, review this protocol independently, validate vault/SQLCipher behavior and key invalidation on devices, test clock skew and process death with pending messages, conduct multi-phone Wi-Fi/BLE fallback and multi-hop tests, and verify release signing and offline installation using the published acceptance checklist. iOS host files and native bridges require a macOS/Xcode build and hardware validation.
