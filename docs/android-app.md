# Android application

The repository includes a React Native 0.88 Android application with Messages
and Map tabs, durable installation identity, explicit nearby-radio permissions
and one shared SOS action. `android/` comes from the official 0.88 template;
the package is `org.palmesh` and the app registry name is `PalMesh`.

## Run and build

Install Node 24+, Java 17, the Android SDK platform 37, build-tools 37.0.0,
platform-tools and NDK 27.1.12297006. The template targets Android API 36 with
minimum API 24, Gradle 9.4.1, Hermes and the New Architecture. Configure
`JAVA_HOME`/`ANDROID_HOME` for those installations, or set `sdk.dir` in the
ignored `android/local.properties` file.

```sh
npm ci
npm run check
npm run bundle:android
```

`bundle:android` creates `dist/android/index.android.bundle` and referenced
assets. This checks the native entry's Metro dependency graph without compiling
an APK. `check` covers strict types, core/SQLite/application tests, RN interaction
tests and the reusable module build. Main TypeScript uses bundler resolution for
native ESM packages; the Node-compatible module build excludes the native entry
and OP-SQLite composition file, both checked by the full type check and Metro.

For a physical Android phone with USB debugging:

```sh
npm start
# In another terminal:
adb reverse tcp:8081 tcp:8081
npm run android
```

Metro listens on `127.0.0.1:8081`. For an emulator, also use `adb reverse` and set
its development server address to `127.0.0.1:8081`; the usual emulator alias
`10.0.2.2` is deliberately outside this app's cleartext allowlist. Development
requires Metro; a properly bundled release does not.

```sh
cd android
./gradlew :app:assembleDebug --no-daemon --max-workers=2
```

No keystore or signing secrets are committed. Android tooling supplies a local
debug key; release builds are unsigned until an operator configures signing.
The official template's MIT notice is retained in `android/TEMPLATE_LICENSE.txt`.

## Shared runtime

`index.js` loads secure random values before the native entry. The composition
root opens five dedicated, exclusive synchronous SQLite handles: installation
identity, DTN queue, peer registry, chat archive and location registry. The first
secure UUID is atomically committed and reused on later starts. Corrupt stored
identity and unavailable entropy fail startup instead of silently creating a
different identity or falling back to weak randomness.

`AppRuntime` starts the DTN engine and both feature services before exposing
the tabs. Radio discovery starts separately so slow discovery does not delay
local SOS readiness. Missing radio permissions leave the app able to queue
messages and SOS locally. Storage startup failure shows an error/retry screen;
an SOS press in that state reports that it could not queue.

The app owns feature lifecycles once. Switching tabs changes read/GPS visibility
without closing databases or restarting either service. Incoming chat/location
events can still be archived on the other tab. Unsent drafts live in the chat
service and survive tab changes. The hidden map renderer and back handler
unmount, while the underlying services stay active.

One global **I Need Help · SOS** button uses the location service's timestamped
stored fix when available, then publishes a priority 15-hop SOS. It never waits
for new GPS or map tiles. It is one tap from either route, or Close then SOS
from the new-recipient modal. Both app and use-case guards suppress overlapping
requests. The UI reports local queuing; peer receipt or assistance is not promised.
The app owns the SOS notice so the embedded feature screens do not duplicate it.

On background/inactive/unknown app state, the runtime hides both feature routes,
cancels active GPS and stops mesh discovery/connections. Foreground resume
checks existing permission grants, starts discovery and reconciles retained
history. Native transitions use intent guards so rapid foreground changes cannot
restart radios before a pending stop completes. No foreground service or
reliable background-delivery guarantee is implemented. Keep the app open for
discovery; OS suspension can stop JavaScript entirely.

Low battery mode applies to both routing and automatic location sharing. It
pauses ordinary forwarding and periodic GPS while SOS remains eligible.
Native battery-level monitoring is not installed; the switch is manual.

On final shutdown, the runtime cancels discovery, waits for both feature services
and the node to stop, then releases the BLE manager and closes handles in
reverse order. Partial startup also cleans up every acquired resource, without
closing a database while a sibling feature is still starting.

## Permissions and local assets

Startup and resume only inspect radio permissions. **Enable nearby connections**
performs the OS request. Android 13+ asks for Nearby Wi-Fi Devices and the
Bluetooth scan/connect/advertise grants; it does not request GPS for discovery.
Android 12 additionally needs fine location, requested together with coarse
location as required by its precision dialog. Approximate location alone does
not authorize Wi-Fi Direct. Older Android discovery uses fine location. Bluetooth
and Wi-Fi grants are evaluated independently. Permanently denied grants show a
device-settings instruction; `PermissionsAndroid.check` cannot distinguish
permanent denial after a process restart until a request result is observed.

GPS acquisition is a separate explicit action. Sharing starts off; see
[maps integration](maps.md) for periodic sharing, cancellation and freshness.
Android's manifest removes the radio library's fine-location SDK cap, declares
coarse location, disables app backup and limits cleartext networking to
`127.0.0.1`. This supports the local tile host and development Metro without a
public cleartext endpoint.

No Palestine map file is bundled. Supply a reviewed/licensed vector MBTiles pack
at `android/app/src/main/assets/palmesh/palestine.mbtiles`, following the
[MBTiles guide](../native/palmesh-offline-maps/README.md). Missing tiles produce
an explicit map-unavailable panel; chat, coordinates and SOS remain available.
To pin a trusted map checksum, pass `mapOptions.expectedSha256` to
`createNativeResources` in `src/app/Entry.tsx`. No online fallback is used.

## Verification status

The production Android JavaScript bundle builds successfully. React Native CLI
configuration detects the Android application and all eight native dependencies,
including both local PalMesh packages. Tests cover actual SQLite persistence,
bootstrap cleanup, permission tiers, foreground races, tab/draft behavior and
the shared SOS path. Native boundaries/MapLibre rendering are mocked in RN tests.

An actual `:app:assembleDebug` was attempted. The Gradle distribution downloaded,
but compiling the React Native settings plugin required a Java 17 toolchain;
the environment has only Java 21, and automatic provisioning was rejected by
the proxy with HTTP 403. No Android SDK is installed either. Earlier standalone
React Native AAR retrieval also returned HTTP 403. The Android app therefore has
not compiled or run on a device in this workspace.

A real map pack, native compilation, multi-phone Wi-Fi/BLE/GPS tests, physical
keyboard/accessibility layouts, an iOS application/peripheral/tile host and
reviewed authentication/encryption remain outstanding. The current protocol and
local databases carry plaintext and unauthenticated source IDs; this app has not
been validated for deployment in the intended emergency setting.
