# PalMesh

PalMesh is an offline-first React Native emergency communication application.
It carries messages between nearby phones through Wi-Fi Direct and Bluetooth,
retaining packets for later contacts when no end-to-end route exists.

The repository includes an Android application, an iOS host and BLE peripheral
bridge, a durable DTN engine, chat, an SOS inbox with responder statements,
offline map/location adapters, application cryptography, encrypted database
composition, Arabic/English UI and Android foreground-service integration.
The domain layer has no external dependencies; application use cases depend on
ports and are separate from native adapters and React Native components.

Android builds and the iOS Release simulator compile passed native GitHub CI.
The bundled Android development APK also passed packaging/signature checks.
The KVM emulator baseline passed offline startup, queued SOS persistence and
stable identity across a cold restart.
Physical-phone interoperability, independent security review and operator
approval of the genuine Palestine candidate map remain release requirements. See the
[recorded progress](docs/CURRENT_PROGRESS.md) for exact source commits and checks.

The current [completion audit](docs/COMPLETION_CHECKLIST.md) and
[release readiness checklist](docs/RELEASE_READINESS.md) separate completed
software, simulated/hosted checks, user-reported one-phone evidence and physical
or operator gates. A candidate workflow builds an APK with genuine validated map
data; its artifacts remain development candidates until approved.

## Develop and verify

Use Node.js 24+, Python 3.11+ and the committed npm lockfile:

```sh
npm ci
npm run check
python3 -m unittest discover -s scripts/android/tests -v
python3 -m unittest discover -s scripts/maps/tests -v
python3 scripts/maps/package.py --fonts-only --check
npm run bundle:android
```

`check` runs strict TypeScript, core/real-SQLite tests, React Native interaction
tests and a declaration build. The JavaScript bundle alone is not an APK. Native
boundaries use test doubles in JavaScript tests and still require real devices.
Generated dependencies, builds, databases, credentials and signing files are
ignored by Git. Do not commit local environment files or release keys.

## Build and test on phones

See [Android setup](docs/android-app.md) for SDK versions, Metro development and
the supported React Native source-build fallback. A development APK can embed
JavaScript for startup without an internet connection or Metro:

```sh
python3 scripts/maps/package.py --fonts-only
python3 scripts/android/gradle.py --bundle-debug :app:assembleDebug
python3 scripts/android/verify-apk.py android/app/build/outputs/apk/debug/app-debug.apk --require-bundle
```

See [iOS setup](docs/ios-app.md) for the macOS compile gate and Bluetooth limits.
The [device acceptance procedure](docs/device-acceptance.md) covers at least
three phones, disconnected transport, power changes, SOS, restart and Arabic
accessibility. Record results against the exact commit and APK certificate.

## Integration guides

- [DTN routing contract](docs/dtn.md): hop limits, durable deduplication, emergency priority and bounded retries.
- [Mesh transport](docs/mesh.md) and [native stream contract](docs/mesh-native-contract.md): discovery, handshakes, fragmentation and fallback.
- [Chat](docs/chat.md): offline queues, durable history and peer-custody labels.
- [Emergency inbox](src/features/emergency/README.md): urgent alerts and responder statements; a response never guarantees assistance.
- [Maps and location](docs/maps.md): local vector tiles, bundled glyphs, timestamped GPS and opt-in sharing.
- [Security](docs/security.md): signed identities/packets, encrypted direct chat, device key storage, SQLCipher and trust limits.
- [Release procedure](docs/releasing.md): operator-owned signing identity, checked map data and build artifacts.
- [Recorded progress](docs/CURRENT_PROGRESS.md): latest verification and outstanding external requirements.

Ordinary packets start with a 10-hop budget; SOS and SOS responses use 15 hops.
Durable per-peer custody prevents repeated forwarding to acknowledged peers.
Broadcast SOS and location reports are visible to mesh participants. Direct chat
requires recipient public keys and uses application-layer authenticated encryption.
A cryptographic address identifies a key, not a person's name or qualifications.
Static identity encryption keys do not provide forward secrecy.

SOS remains available through a large red control within two taps. Queued means
stored on this phone; peer custody means another device retained a packet.
Neither means a person read it or help will arrive. Android background connections
are an explicit opt-in and can stop after OS process termination. iOS Bluetooth
background modes cannot guarantee JavaScript forwarding while suspended.
