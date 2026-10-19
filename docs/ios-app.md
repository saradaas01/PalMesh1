# iOS host

The native host is based on the official `@react-native-community/template@0.88.0` npm package, matching the pinned React Native version. The app uses its SceneDelegate factory entry point and `PalMesh` JavaScript registry name. Template license: [`ios/TEMPLATE-LICENSE`](../ios/TEMPLATE-LICENSE).

## Build on macOS

Use Xcode 16.1 or newer, its command line tools, Ruby/Bundler and the repository's supported Node version. iOS 15.1 is the minimum deployment target. The Linux environment can validate project metadata and autolinking, but cannot compile Apple frameworks, run CocoaPods/Xcode or exercise CoreBluetooth.

```sh
npm ci
bundle install --gemfile ios/Gemfile
cd ios
bundle exec pod install
open PalMesh.xcworkspace
```

Select the PalMesh scheme. Build an iPhone simulator with signing disabled for a compile check, then configure your own team/signing identity to install on physical phones. BLE phone-to-phone validation requires real iPhones; the simulator is insufficient. Release configurations bundle JavaScript, allowing startup without Metro. Development configurations use Metro. MapLibre's `post_install` hook pins and links its native Swift package dependency.

## Bluetooth authorization and transport

`PalMeshBluetoothAuthorization.check()` reads the `CBManager.authorization` class property and does not construct a Bluetooth manager. `request()` is the explicit permission action. It constructs CoreBluetooth only when authorization remains undetermined; denied/restricted permissions require Settings rather than repeated prompts. English and Arabic privacy strings are bundled.

`PalMeshBlePeripheral` exposes the same inbound `NativeStreamRadio` API/events as Android's GATT server, with these fixed PalMesh UUIDs:

- Service: `c62d6a00-7e41-4cc2-9d31-c7a81ef11310`
- Write with response: `c62d6a01-7e41-4cc2-9d31-c7a81ef11310`
- Notify: `c62d6a02-7e41-4cc2-9d31-c7a81ef11310`

BLE PLX supplies the central role. Advertising starts after the native service registration callback; the start promise resolves only after advertising is confirmed. A central subscribing to notifications creates a bounded logical link, using at most 512 bytes per chunk and the central's negotiated notification limit. Incoming write batches validate atomically before delivery. Outgoing notification backpressure uses CoreBluetooth's readiness callback with a bounded queue. Stop/cancel/unsubscribe settle pending operations and remove logical links.

CoreBluetooth does not let a peripheral forcibly disconnect a central. `disconnect` revokes that central's logical session and drops subsequent writes until it unsubscribes. Android-style Wi-Fi Direct has no public iOS equivalent; the app reports it unavailable rather than substituting internet networking.

## Security and runtime

`PalMeshSecurity` stores versioned application key records as nonsynchronizing Keychain generic passwords with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`. Records cannot migrate to another device through backups/iCloud Keychain. They remain locked until the first device unlock after reboot. Keychain errors and invalid records fail closed; they never trigger plaintext storage or automatic replacement of existing records. Secure entropy comes from `SecRandomCopyBytes`. Removing the app does not necessarily erase its Keychain items; plan device decommissioning separately.

`PalMeshRuntime` reports battery level, charging and Low Power Mode through the shared runtime event contract. Local SOS notifications contain generic alert text only, without coordinates, sender identity or message contents. Permission checks do not prompt; `requestNotifications` is an explicit foreground action. Notification visibility and sound still depend on user settings and Focus modes.

There is **no iOS foreground service**. `startMeshService` rejects with `BACKGROUND_UNAVAILABLE`; it never claims a persistent daemon. The Info.plist declares only implemented CoreBluetooth central/peripheral background modes. Those modes permit limited Bluetooth callbacks and alter advertising/scanning behavior; they do not guarantee the JavaScript DTN engine will execute while suspended, after force quit or after reboot. Keep PalMesh open for reliable forwarding. GPS is when-in-use only; no always-location permission or background location mode is requested.

## Offline maps

The Xcode project copies `ios/PalMesh/palmesh` as a folder resource, preserving the shared asset paths. The default map is `palmesh/palestine.mbtiles`. Use the map packaging script to place an independently licensed vector dataset and fonts into both mobile targets. No placeholder file is presented as map coverage.

`PalMeshOfflineMaps` opens the immutable bundle file with SQLite read-only, checks vector/TMS metadata and sample tile framing, and optionally checks a supplied SHA-256 digest. Its socket binds to `127.0.0.1` on an ephemeral port and requires a fresh 128-bit session token plus an exact loopback Host header. It accepts bounded GET requests, converts XYZ rows to TMS, bounds tile sizes and gzip inflation, limits concurrent requests, applies socket/query deadlines and interrupts active work on close. It does not fetch remote tiles.

When fonts are bundled, the descriptor also exposes token-protected glyph requests for `Klokantech Noto Sans Regular`. Only aligned BMP glyph ranges from the immutable bundle are accepted. Global arbitrary-load exceptions remain disabled; ATS allows local networking only.

## Validation still required

The iOS source and autolinking can be reviewed on Linux. The app privacy manifest is copied into the app resources. `tests/ios-tile-parser.test.ts` compiles the production C parser with a host C compiler and zlib, then exercises valid and malformed protobuf frames, complete/truncated/corrupt gzip streams, trailing members and the decompression budget. These tests validate that parser only; they do not compile the Objective-C host or Apple frameworks.

The [`verify-ios.yml`](../.github/workflows/verify-ios.yml) workflow runs automatically for relevant changes pushed to `main` or `work`, and for pull requests. It can also be triggered manually. It installs CocoaPods on macOS and builds the Release configuration for the iPhone simulator with signing disabled, retaining build diagnostics for seven days. A workflow definition is not evidence that the Apple build passed: inspect its actual run before claiming a compiled iOS host.

Before distribution, run that macOS compile gate and physical iPhone checks: explicit permission denial/recovery, bidirectional Android/iPhone BLE, MTU negotiation/backpressure, stop/cancel/reconnect, Keychain locked-device behavior, SQLCipher opening, actual MapLibre tile/glyph rendering, Arabic layouts, GPS, alert settings and suspension/foreground restoration. No iOS binary or phone validation is claimed by the Linux setup.
