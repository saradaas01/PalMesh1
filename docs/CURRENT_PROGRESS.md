# Current progress checkpoint

This checkpoint preserves completed features and the latest work in progress.
It is a backup, not a claim that every newly added feature is integrated or ready
for field deployment. Do not reset or replace these files to recover context.

## Verified before the current hardening work

- DTN store-and-forward engine, SQLite persistence, priority/TTL/dedup/retry.
- Android Wi-Fi Direct and BLE transports, chat, SOS, location and map hosting.
- Shared Android application with a global SOS action and permission handling.
- 284 core tests and 42 UI tests passed, strict types and module build passed.
- ARM64 Android debug APK built with embedded JavaScript; signing, required
  runtime libraries, ZIP integrity, and 16 KiB ZIP/ELF alignment checks passed.

Those results apply to the earlier development build. The changes below need a
fresh integrated verification run and rebuilt artifacts.

## Current hardening work included in this backup

- Security feature using pinned Noble primitives: cryptographic identities,
  signed packets and handshakes, authenticated link frames, encrypted direct
  chats, and ciphertext-only transit routing storage. Focused security tests
  passed during implementation. Static encryption has no forward secrecy, and
  the application protocol has not had an independent security audit.
- Android runtime module: opt-in foreground service, battery monitoring,
  private SOS notifications, and Keystore-backed encrypted key storage.
- Durable SOS inbox, responder statements, Arabic/English UI and tests.
- Arabic localization, RTL and accessibility work, release scripts and CI work.
- iOS host and native BLE, tile/glyph, Keychain, notification and battery source.
  No macOS/Xcode build or iOS device test has been performed.
- Offline map glyphs, licensing/attribution and map preparation work. A real
  Palestine MBTiles dataset has not been downloaded or bundled. The official
  Geofabrik download host was denied by the cloud network policy; its domain
  addition was saved in the environment draft, not verified as applied.
- SQLCipher backend configuration and encrypted storage integration.

## Resume from here

1. Inspect the actual current files and complete root application integration:
   `src/app/application/AppRuntime.ts`, `src/app/domain/types.ts`,
   `src/app/infrastructure/createNativeResources.ts`, `src/app/Entry.tsx`, and
   `src/app/ui/PalMeshApp.tsx`. Background, emergency, security and localization
   changes were still being connected when this checkpoint was requested.
2. Review `EncryptedStorage.ts` and `LazyBleManager.ts`, then update bootstrap
   tests for the native vault, SQLCipher and lazy Bluetooth initialization.
   Do not fall back to plaintext or delete old databases if key/data recovery
   is required. Legacy plaintext database migration is not implemented.
3. Run strict types and the full existing tests, fix integration failures, then
   build a fresh Android APK. The prior APK does not contain this entire batch.
4. Validate the real map pack and iOS build on their required platforms, then
   perform the documented physical multi-phone tests. No physical phones were
   available in the cloud session. Foreground service operation is best effort
   while the JavaScript process survives; native DTN takeover is not implemented.
5. Use an operator-supplied release signing key for production. No release key
   or credentials are stored in this repository.

The user explicitly requested regular verified GitHub backups after each major
feature. Commit and push progress before long work or usage limits. Never force
push or overwrite remote work; verify the remote commit and committed files.

Local SDKs, Gradle/npm caches and earlier verification logs exist under
`/workspace/.palmesh-tools` in the prepared cloud environment. They are not
application source and are excluded from the repository backup. Prefer the
repository's `scripts/` and documented setup for reproducible environments.
