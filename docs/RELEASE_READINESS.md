# Development and release readiness

This is a development candidate, not a production/field readiness declaration.
The detailed A/B/C/D audit is [COMPLETION_CHECKLIST.md](COMPLETION_CHECKLIST.md).

## Application software

- [x] Offline public messaging, signed broadcasts and durable restart history.
- [x] Encrypted private messages, known recipient identity requirement, safe
  import/retry, saved-contact selection and actionable failed-send guidance.
- [x] Persistent DTN queue/custody/retry/dedup, emergency capacity and routing.
- [x] Android BLE central/peripheral and Wi-Fi Direct wiring; simulated peers,
  fallback/reconnect and bounded inactive-radio recovery without prompts.
- [x] SOS queue/inbox/responder intent, cached or missing GPS, offline/restart
  behavior and warnings distinguishing custody/intent from rescue.
- [x] English/Arabic setup and trust guidance, RTL support, wrapping navigation
  and composer, accessible labels and prominent emergency action.
- [x] Device-bound identity, SQLCipher composition, safe startup recovery and
  preserved existing databases/keys. No automatic destructive migration.
- [x] Genuine OSM candidate generation, source date/provenance, ODbL attribution,
  nine-city coverage checks, fonts and Android/iOS asset packaging.
- [x] Candidate-only Actions map/artifact pipeline, mandatory native ELF/ZIP
  verification, separate production signing and reviewed-map release gates.
- [x] Combined local TypeScript/build, 379 core, 75 UI, 37 Android-tool and
  53 map-tool tests; fresh map-bundled ARM64 debug APK verification.
- [x] Final combined-source candidate-map/Android workflow passed:
  [run 40352843627](https://github.com/saradaas01/PalMesh1/actions/runs/40352843627).
  [APK artifact 12663933473](https://github.com/saradaas01/PalMesh1/actions/runs/40352843627/artifacts/12663933473)
  exists and is unexpired; generation, signature/ELF verification and upload
  succeeded. [Hosted report](verification/hosted-development-apk.json) was read
  back from job logs. All implementation PRs #2–#7 were reviewed and merged only
  after their exact-head checks passed; iOS simulator and offline native startup
  passed on the combined application source in #5.

## Physical evidence and acceptance

- [x] User reports public Hello offline queueing and close/reopen persistence
  on one Android phone. Device model/OS/exact installed APK hash are unspecified.
- [ ] Physical phone-to-phone Wi-Fi Direct and BLE, private/public/SOS exchange,
  relay chain, interrupted ACK, reconnect and storage-pressure matrix.
- [ ] Real map rendering/GPS, source-age/coverage/operator review, RTL/TalkBack,
  large fonts, keyboard, narrow displays and a 16 KiB-page device.
- [ ] OEM battery/Doze/screen-off, revoked permissions, process kill and reboot.
- [ ] Physical iPhone/BLE interoperability and distribution provisioning.

Device absence defers these checks; it did not stop software development.
Simulated/hosted emulator behavior must never be relabeled as physical results.

## External release gates

- [ ] Operator approval of the genuine map artifact and its independent pins.
  Candidate artifacts are not automatically approved release resources. OSM data
  does not establish current access, hazards, damage or safe routes.
- [ ] Operator Android signing identity/certificate and Apple team/provisioning.
  A different debug signer cannot update the currently installed application;
  preserve the old app/data if Android rejects an in-place update.
- [ ] Resolve or explicitly assess the documented build-tool dependency advisory
  in `docs/security.md`; a dependency audit is not a runtime protocol audit.
- [ ] Independent cryptographic/security review. Static X25519 has no forward
  secrecy; key identities do not authenticate human qualifications.
- [ ] Complete physical acceptance above, then review PR #1 (`work` to `main`).
  PR #1 stays open until those readiness decisions are made.

Native DTN takeover after OS process death, legacy plaintext/UUID migration,
secure account recovery, automatic updating and external emergency dispatch are
not implemented features. They require separate product/security designs and
must not be implied by the existing foreground service or responder statements.
Current first-install/offline release scope and limitations are preserved.

## Candidate reproduction and safe installation

Use the existing [Android process](android-app.md), with a fully validated genuine
map via `scripts/maps/package.py` for the map candidate. The normal verify
workflow deliberately also tests operation with maps absent. The candidate-map
workflow uploads **android-candidate-map-debug-apk**, its verification JSON and
map manifest, alongside **palmesh-candidate-palestine-map**. Retain the exact
artifact hashes and source date; do not confuse local and separately built CI
binary hashes. Actions artifacts expire after 14 days.

Install the extracted APK over the old app only when Android accepts the signing
identity, using the system installer or `adb install -r`. Do not uninstall,
clear storage or replace identity/database keys to work around a mismatch.
A test APK is not a production signing identity or field-tested release.
