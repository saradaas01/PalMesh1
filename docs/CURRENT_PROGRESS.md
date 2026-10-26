# Current progress checkpoint

All application source and configuration are backed up on the GitHub `work`
branch. The initial verified backup commit is
`877de4644680858cc87aaf30cf86ad3dfa5295e2`. Later commits preserve completed
integration and verification. Never force-push, reset, or replace remote work.

## Public Nearby chat fix — October 26, 2026

- Base: backed-up remote `work` checkpoint `ae68612c11b7eaa6d9ecfe2bede10208267a3068`.
  Local checkout initially fetched only `main`; explicit fetch of remote `work`
  recovered the completed application. Local `work` fast-forwarded without reset.
- Feature branch: `fix/secure-nearby-broadcasts`, original `saradaas01/PalMesh1`.
- Root cause: ChatService/UI allowed chat destination `*`, but SecurityService
  rejected it before DTN persistence. Nearby public chat now signs its plaintext,
  destination and envelope, enforces authenticated hop budgets and projects at all
  recipients. Unknown keys/connections are not required for public local queuing.
  Direct chat remains end-to-end encrypted and fails closed without known keys.
  Encrypted broadcast packets are rejected; signatures prevent destination/kind
  substitution. Existing SOS/location/responder security and routing are unchanged.
- English/Arabic public labels, visible composer privacy warning and accessible
  hint explain that messages are readable and relayable beyond nearby devices.
- Strict TypeScript, 373 core tests, 71 UI tests and module build passed locally.
  One first-pass UI test timed out during concurrent native compilation; all 71
  passed on unchanged-timeout retry. New integrated regressions use real security,
  DTN, ChatService and SQLite: no-peer Hello queuing, key/database reopen, remote
  admission/dedup/archive, tamper/downgrade rejection, draft retention/retry after
  storage failure, and SOS queuing with its original 15-hop budget.
- Fresh ARM64 bundled Android build is in progress; no new APK success or
  physical-device result is claimed at this checkpoint. See the public chat
  procedure in `docs/device-acceptance.md`. Older peers reject public chat and
  need an updated build for interoperability.

## Next Android stability increment — October 26, 2026

- Messaging fix is backed up at `b7a20c5adbd8868f92c1ecaefd431f85be8e37fc`;
  remote branch SHA and the GitHub committed tree/regression blob were read back.
  PR https://github.com/saradaas01/PalMesh1/pull/2 targets `work`.
- The isolated native offline smoke runner now requires the public warning,
  queues a fixed synthetic public message without internet/radios, checks its
  local queue notice/history, and checks retained history after force-stop.
  SOS persistence and stable identity remain required for overall success.
  Its report marks public chat persistence true only after all checks complete.
- All 30 Android tooling tests pass, including failure checks for missing public
  warning, rejected send, missing retained history and false custody text.
  This is runner verification, not a completed emulator or physical-phone run.
- Next priorities: execute the extended KVM job, then physical Android public/
  private/SOS exchange and restart tests, Wi-Fi Direct/BLE reconnect/relay tests,
  and OEM screen-off/power testing. Existing contact import and private offline
  queueing remain implemented. Real map data, operator signing, iOS device
  acceptance and independent protocol review remain external release gates.

## Implemented and integrated

- DTN routing, persistent queues, deduplication, emergency priority and retries.
- Android Wi-Fi Direct/BLE, chat, locations and offline vector tile/glyph hosts.
- Cryptographic self-certifying identities, signed packets and handshakes,
  authenticated session frames, encrypted direct chats, and ciphertext relay
  storage. Signed SOS/location/responder statements are public.
- SQLCipher databases, Android Keystore and iOS Keychain vaults. Missing/corrupt
  keys and legacy plaintext files fail closed; no automatic plaintext migration
  or destructive reset is performed.
- Retryable first-install provisioning makes the identity durable before the
  database key. Sanitized English/Arabic startup recovery guidance preserves
  existing files and keys; SOS is enabled only after startup succeeds.
- Opt-in Android foreground service, notification permissions, private bounded
  emergency alerts, battery monitoring and automatic/manual conservation.
- Durable SOS inbox and responder statements. A response records human intent,
  never a guarantee of assistance.
- English/Arabic interface and preferences, RTL, four routes, public contact
  identity import, fingerprint comparison and a global SOS action.
- iOS host/native sources, portable tile-parser tests, and a passing real macOS
  Release simulator compile. Physical iOS radio behavior has a separate
  acceptance procedure.
- Map generation/validation/packaging tools and licensed offline glyphs.
- CI, production signing configuration, artifact checks and device test guides.
- Manual Android release provisioning accepts a reviewed map artifact from a
  specified run in this repository, with operator-pinned map and manifest
  SHA-256 values. Full provenance/coverage validation precedes signing-key
  materialization; existing differing map files are preserved.

## Verified current code

- `npm run check`: strict TypeScript, **370 core tests**, **71 UI tests**,
  and module build passed.
- Map tools: **47 Python tests**, real Lua profile checks and all 256 glyph
  pages passed. Android tooling: **26 Python tests**, including release and
  cold-launch runner checks, plus Boost cache verification.
- The 17 new reviewed-artifact importer tests cover independent hash pins,
  invalid maps, symlinks, bounds, existing-file preservation and publication
  races. Workflow YAML and embedded Python parse checks passed. No real map
  artifact or signed production build was produced by these tests.
- Official pinned tilemaker 3.2.0 was compiled with verified source and signed
  Debian dependencies. Preserving installer replay passed. The actual app Lua
  generated 16 valid upstream Monaco fixture tiles across all nine layers;
  temporary fixture output was deleted and never packaged as Palestine data.
- Real SQLCipher source probe: encrypted file, correct-key reopen, wrong-key
  rejection and plain-SQLite rejection passed.
- Updated ARM64 bundled Android debug build passed. APK signature, ZIP CRC,
  launcher metadata, bundled Hermes bytecode, 256 glyph pages, SQLCipher native
  marker and all 14 native libraries' 16 KiB LOAD alignment checks passed.
  The development APK is available locally at
  `dist/android/PalMesh-0.1.0-arm64-debug.apk` (81,987,979 bytes), SHA256
  `5f5bb047e0da109034477721b946b893ba275cf8aec2e91a60f8b28c13a7ed54`.
  It is debug-signed, has no real map dataset, and has not run on a phone.
- The nondebuggable, unsigned ARM64 Release variant also compiled and passed
  explicit unsigned packaging inspection. It is **not installable or eligible
  for distribution**. Its SHA256 is
  `65d8ab472cfb3b3a715662aab65902a67f112a2fcc21d3f4fcd1c7f8bd5b7cdc`.
  Both variants contain the new recovery UI and matching Hermes bytecode.
- Regression checks cover delayed battery readings and notification stop during
  background startup. Android service stop now awaits native teardown before
  another session starts. CI uses the official `platforms;android-37.0` SDK ID.
  A confirmed hosted-runner failure from the absent `sdkmanager` executable was
  fixed with a verified official Android CLI bootstrap.
- Actual hosted GitHub application and Android native jobs passed for source
  commit `7c3f603621757986359fa42e95f4ad619e5c901e`, including APK verification
  and artifact upload:
  https://github.com/saradaas01/PalMesh1/actions/runs/39330234115.
- The same source commit passed CocoaPods and the real iOS Release simulator
  build: https://github.com/saradaas01/PalMesh1/actions/runs/39330240202.
  `PalMeshApp` is the internal executable name, avoiding its case-insensitive
  filesystem collision with the bundled `palmesh` resource directory.
- UUID 11.1.1 includes the compatible bounds-checking security patch. The
  remaining npm audit findings trace to one unpatched `braces` build-tooling
  advisory; see `docs/security.md`. The Android bundle's source map contains
  neither `braces` nor `micromatch`.
- Actual KVM-backed Android execution passed for source checkpoint
  `2040e8358b20bd6c38a87deeb430de7ceeaeb555`:
  https://github.com/saradaas01/PalMesh1/actions/runs/39386162427/job/118506946714.
  The official API 35 AOSP x86_64 guest cold-launched the bundled app without
  Metro or internet, queued a synthetic local SOS, retained its history after a
  force-stop/relaunch and reused the same public identity. Normal ADB
  authentication was retained; private app files were never read.

## Remaining external requirements

1. Official Geofabrik Palestine source download still returns HTTP 403 for both
   HEAD and bounded GET checks on October 20, 2026.
   The `download.geofabrik.de` addition was saved to the environment draft;
   a recheck after environment publication still returned proxy CONNECT 403.
   No real MBTiles asset or fabricated checksum is included. See
   `mapdata/README.md` and `docs/maps.md`.
2. No physical Android phones or iPhones are attached. The macOS compile gate
   passed; the physical three-phone matrix in `docs/device-acceptance.md` remains
   required. The passing KVM baseline verifies native UI and persistence; it
   does not establish physical Wi-Fi Direct/BLE, GPS or OS battery behavior.
3. No operator release key or certificate is supplied. The production release
   script intentionally refuses missing maps/credentials; see `docs/releasing.md`.
   iOS distribution additionally requires the operator's Apple team,
   certificates and provisioning on macOS; simulator compilation does not
   establish distribution signing.
4. The cryptographic application protocol needs independent review. Static
   X25519 has no forward secrecy; identities identify keys, not people. Radio
   jamming/Sybil attacks and OS process death remain limitations.
5. This first release targets new installations. Existing plaintext prototype
   data is preserved, but in-place migration is unsupported. A prototype UUID
   cannot become a self-certifying cryptographic address without a new identity;
   unsigned historical records must not be re-signed or requeued as trusted data.

Foreground service operation is best effort while JavaScript survives; there is
no native DTN takeover after process death. GPS sharing remains explicit and
foreground-only.

## Backup policy

The user requires a verified GitHub commit/push after each major completed
feature, before long work or usage limits. Preserve existing remote changes.
Verify remote SHA and read back the committed tree/files before reporting backup
success. Secrets, environment files, signing keys, caches and build artifacts
must stay excluded.

Prepared SDKs and caches under `/workspace/.palmesh-tools` are local environment
dependencies, not repository source. Use the committed `scripts/` and docs for
reproduction. APK build outputs are intentionally ignored by Git.
