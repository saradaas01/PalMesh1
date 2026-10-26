# PalMesh completion audit — October 26, 2026

Scope: original `saradaas01/PalMesh1`, consolidated `work` merge `7cf854e`.
PR #2's six head checks passed (application twice, Android twice, KVM offline
startup, macOS iOS simulator). PR #1 remains open; no main promotion is authorized
by readiness evidence. Features below were checked against README, current
progress, device acceptance, mesh/chat/maps/security/releasing docs and their
application, native adapter, UI and test implementations. A check means the
specified evidence exists, not field acceptance or an independent audit.

## A. Implemented with automated verification

| Area | Existing implementation/evidence | Status |
| --- | --- | --- |
| DTN | DtnEngine, SqliteDtnStore; engine/sqlite-store/domain tests | Durable local queue, retention, UUID dedup, reserved emergency capacity, retries, 10/15-hop budgets implemented. |
| Chat | ChatService, SqliteChatRepository; chat-service/archive/custody tests | Offline sends, independent durable history, draft preservation, pagination, unread state, monotonic peer custody and restart reconciliation implemented. |
| Public chat | SecurityService, public-chat tests, native smoke runner | Signed public packets, explicit public warning, no-peer queueing and reopen implemented. |
| Private chat | SecurityService/security tests | X25519/HKDF/XChaCha20-Poly1305, Ed25519 signatures, ciphertext relay storage, endpoint projection and pinned contact key import implemented. No plaintext fallback. |
| Transport | MeshCoordinator, FrameWriter, bounded wire codec; mesh-* tests | Signed challenge handshakes, session MACs, fragmentation, ACK/NACK custody, Wi-Fi preference/BLE fallback, reconnect backoff, bounds and cancellation implemented. |
| Native Android | Wi-Fi Direct Java TCP/DNS-SD, BLE PLX central and native GATT peripheral; native build | Adapters and host wired; permissions and unavailable states do not block local queuing. Physical radio behavior remains deferred. |
| Emergency | EmergencyService/repository/UI; emergency-flow tests | Durable inbox, public signed SOS, cached GPS, responder intent, alert bounds, no assistance guarantees; SOS does not wait behind GPS/archive work. |
| Storage/identity | EncryptedStorage, NativeSecurityVault; encrypted-storage/security/native-runtime tests | SQLCipher composition and Keystore/Keychain keys, restart identity, interrupted setup recovery, no destructive reset or silent key replacement. |
| Location | LocationService, SqliteLocationRepository, native GPS; maps-* tests | Foreground opt-in capture/sharing, timestamps/staleness, bounded peer registry, cached-fix SOS, cancellation and conservation implemented. |
| Offline rendering | Native read-only MBTiles/glyph hosts, MapLibre style; offline-native/maps-style tests | Tokenized loopback, TMS conversion, adaptive vector style, 256 licensed glyph pages, Android/iOS wiring implemented. Real map absent. |
| Map pipeline | scripts/maps, mapdata README; Python map tests | PBF date/provenance, tilemaker generation, whole-pack validation, nine-city coverage, licensing and safe packaging/import implemented. |
| UI/localization | App shell, chat/maps/emergency/security screens; UI tests | Four routes, English/Arabic/RTL, selectable public identity, contact import, generic error recovery, global emergency action and persisted language implemented. |
| Power/lifecycle | AppRuntime, NativeMeshRuntime; app-runtime/native-runtime tests | Explicit foreground-service opt-in, stop action, battery/conservation, visibility/GPS pause and teardown ordering implemented. Native DTN process-death takeover is not implemented or promised. |
| Android artifacts | Gradle helper, verifier, Actions; release/smoke Python tests | Bundled debug builds, signatures, ABI/ZIP checks, debug/release separation and Actions upload implemented. |
| iOS host | Objective-C++ bridges, Podfile, macOS workflow | Real Release simulator build passed at PR #2 head. This Linux executor cannot locally run Xcode. |

## B. Implemented but needing improvements

- [x] Private send errors must distinguish unknown recipient keys from temporary
  key-directory persistence failure, retain drafts and guide identity import.
- [x] Verify radio off/on and permission-return recovery while app stays open;
  unavailable-to-available events must not require an application restart or
  duplicate sessions. Existing reconnect/fallback logic should be retained.
- [x] Expose saved contact identities for reuse without retyping long addresses;
  imported keys must never be described as a verified person automatically.
- [x] Add inline setup guidance explaining public versus private messaging,
  offline queueing, key exchange, optional permissions and unconfirmed delivery.
- [x] Reduce small-screen header/navigation/composer pressure and make setup,
  identity import and large text practical without hiding SOS.
- [x] Maintain a committed automated native ELF alignment check instead of only
  the additional local inspection previously recorded in a JSON report.
- [x] Refresh stale progress statements with complete passing PR #2 checks and
  the user's explicitly reported single-phone result.

## C. Missing code/integration or test coverage

- [x] Add security-to-chat-to-UI regressions for actionable private send failures
  and a disconnected encrypted send after importing a recipient identity.
- [x] Add specific multi-peer/radio recovery regressions for audit findings;
  do not replace existing broad mesh simulations with mock-only assertions.
- [x] Saved-contact selection and safe setup guidance are integrated into
  New message; imported addresses can be chosen without retyping fingerprints.
- [x] Integrate ELF LOAD alignment verification into the committed APK verifier
  used by CI; existing ZIP alignment alone cannot establish ELF suitability.
- [x] Produce a final candidate from the combined reviewed milestones, with
  current full tests, bundled APK verification and a confirmed Actions artifact.

## D. External acceptance/release gates

| Gate | Evidence/next action |
| --- | --- |
| One-phone public Hello | User reports installing the new APK and successfully queuing public Hello offline with persistence after close/reopen. This is user-reported physical evidence; device model, OS, exact APK hash and certificate were not supplied. Do not infer them. |
| Multi-device radios | Deferred: user owns one Android phone. Later test Wi-Fi Direct/BLE exchange, relay A–B–C, ACK loss, reconnect, private confidentiality and SOS responses. Continue software work meanwhile. |
| Physical lifecycle/accessibility | Phone/OEM screen-off, Doze, revoked permissions, font/keyboard/RTL, battery measurements and 16 KiB-device acceptance remain required. |
| Authentic map data | Source-access blocker resolved: genuine provider-checksummed Geofabrik PBF generated a candidate at source date 2026-10-25T21:21:21Z. 4,958 tiles passed full coverage/provenance checks and candidate packaging. Operator map approval and physical rendering remain open. |
| Map review/rendering | Even if a genuine pack is generated, operator provenance/license/coverage approval and real offline rendering acceptance remain gates. |
| Production signing | Operator Android keystore/certificate and Apple team/provisioning are absent. Preserve identities/data; debug APKs are controlled test artifacts. |
| Independent security review | No independent cryptographic audit. Static identity encryption has no forward secrecy; signatures identify keys, not people; public metadata/SOS/location remain visible. |
| Migration/recovery | Legacy plaintext/old UUID installs require separate reviewed migration design. Existing data is preserved; no automatic destructive conversion or key replacement. |
| Background limits | JS forwarding ends on OS process death; native foreground service is best effort. Reliable native DTN takeover would be a separate substantial architecture/security project, not an implied completed feature. |

## Milestone and backup policy

Each implementation milestone gets focused regressions, TypeScript/module checks,
a normal commit/push with remote readback and a PR into `work`. Further PRs are
reviewed against exact-head checks before merge. Do not force-push, reset, delete
branches, overwrite remote work or close/merge PR #1 as part of this audit.
Record simulated, hosted emulator, user-reported physical and unexecuted checks
separately. External release gates must not be relabeled as missing application
code, and missing devices must not block feasible software milestones.

## Milestone 1 — private-message recovery

Implemented classified unknown/unavailable recipient-key errors, English/Arabic
recovery guidance and an integrated identity-screen action. No exception-string
matching or encryption fallback. Real security/DTN/chat/SQLite regressions verify
draft retention, safe re-import, offline encrypted retry and public/SOS independence.
Strict TypeScript, 375 core tests, 72 UI tests and module build passed.

## Combined development verification

Five implementation milestones are committed on dedicated branches/PRs:
private-key recovery (#3), inactive radio recovery (#4), saved contacts/setup/
layout (#5), real map generation and candidate publication (#6), and ELF APK
verification (#7). The software combination passed strict TypeScript, 379 core
and 75 UI tests, module build, 37 Android and 53 map Python tests, all 256 glyphs,
and real checked-manifest validation. A fresh map-bundled ARM64 APK built and
passed signature, ZIP/ELF, Hermes, SQLCipher, glyph and exact packaged-map digest
checks. See [readiness](RELEASE_READINESS.md) and
[exact local evidence](verification/development-candidate.json).
The final integration Actions run 40352843627 passed; APK artifact 12663933473
was verified present/unexpired and its verification report was read from job logs.
It is distinct from the earlier map-workflow APK. Physical acceptance, operator map approval, release signing
and independent review are not marked complete.
