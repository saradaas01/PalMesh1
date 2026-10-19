# Current progress checkpoint

All application source and configuration are backed up on the GitHub `work`
branch. The initial verified backup commit is
`877de4644680858cc87aaf30cf86ad3dfa5295e2`. Later commits preserve completed
integration and verification. Never force-push, reset, or replace remote work.

## Implemented and integrated

- DTN routing, persistent queues, deduplication, emergency priority and retries.
- Android Wi-Fi Direct/BLE, chat, locations and offline vector tile/glyph hosts.
- Cryptographic self-certifying identities, signed packets and handshakes,
  authenticated session frames, encrypted direct chats, and ciphertext relay
  storage. Signed SOS/location/responder statements are public.
- SQLCipher databases, Android Keystore and iOS Keychain vaults. Missing/corrupt
  keys and legacy plaintext files fail closed; no automatic plaintext migration
  or destructive reset is performed.
- Opt-in Android foreground service, notification permissions, private bounded
  emergency alerts, battery monitoring and automatic/manual conservation.
- Durable SOS inbox and responder statements. A response records human intent,
  never a guarantee of assistance.
- English/Arabic interface and preferences, RTL, four routes, public contact
  identity import, fingerprint comparison and a global SOS action.
- iOS host/native sources, portable tile-parser tests, and manual macOS compile
  workflow. Apple compilation and actual iOS radio behavior remain unverified.
- Map generation/validation/packaging tools and licensed offline glyphs.
- CI, production signing configuration, artifact checks and device test guides.

## Verified current code

- `npm run check`: strict TypeScript, **357 core tests**, **58 UI tests**,
  and module build passed.
- Map tools: **30 Python tests**, real Lua profile checks and all 256 glyph
  pages passed. Release tools: **13 Python tests** and Boost cache verification.
- Real SQLCipher source probe: encrypted file, correct-key reopen, wrong-key
  rejection and plain-SQLite rejection passed.
- Updated ARM64 bundled Android debug build passed. APK signature, ZIP CRC,
  launcher metadata, bundled Hermes bytecode, 256 glyph pages, SQLCipher native
  marker and all 14 native libraries' 16 KiB LOAD alignment checks passed.
  The development APK is available locally at
  `dist/android/PalMesh-0.1.0-arm64-debug.apk` (81,987,979 bytes), SHA256
  `f8aee0da623f1a94ea2347873f2d505bb52fe2b8954ffc68bf2ccc24ea344625`.
  It is debug-signed, has no real map dataset, and has not run on a phone.
- Regression checks cover delayed battery readings and notification stop during
  background startup. Android service stop now awaits native teardown before
  another session starts. CI uses the official `platforms;android-37.0` SDK ID.

## Remaining external requirements

1. Official Geofabrik Palestine source download still returns CONNECT HTTP 403.
   The `download.geofabrik.de` addition was saved to the environment draft;
   actual access has not been restored. No real MBTiles asset or fabricated
   checksum is included. See `mapdata/README.md` and `docs/maps.md`.
2. No Android phones or Mac/Xcode environment are attached. Run the physical
   three-phone matrix in `docs/device-acceptance.md` and the macOS workflow.
3. No operator release key or certificate is supplied. The production release
   script intentionally refuses missing maps/credentials; see `docs/releasing.md`.
4. The cryptographic application protocol needs independent review. Static
   X25519 has no forward secrecy; identities identify keys, not people. Radio
   jamming/Sybil attacks and OS process death remain limitations.
5. Legacy plaintext prototype databases need a separate migration/recovery
   decision. Existing data/keys are never silently deleted.

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
