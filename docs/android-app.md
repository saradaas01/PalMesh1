# Android application

The Android host uses React Native 0.88, Hermes and the New Architecture, with
application ID `org.palmesh` and JavaScript registry name `PalMesh`. The official
MIT template notice remains in `android/TEMPLATE_LICENSE.txt`.

## Prerequisites and normal build

Install Node 24+, Python 3.11+, Java 17, Android SDK platform 37, build-tools
37.0.0, platform-tools, NDK 27.1.12297006 and CMake 3.30.5. The app targets API 36
and supports API 24+. Configure `JAVA_HOME` and `ANDROID_HOME` or use ignored
`android/local.properties` for `sdk.dir`.

```sh
npm ci
npm run check
python3 scripts/maps/package.py --fonts-only
python3 scripts/android/gradle.py --bundle-debug :app:assembleDebug
python3 scripts/android/verify-apk.py android/app/build/outputs/apk/debug/app-debug.apk --require-bundle
```

The helper limits Gradle/compiler parallelism and defaults to ARM64 phones.
Use `--architectures arm64-v8a,armeabi-v7a` for a multiple-ABI APK, or `x86_64` for
an emulator. Each additional ABI increases native build time and APK size.
`--bundle-debug` embeds the JavaScript bundle; the resulting development APK can
cold-launch without Metro. Normal debug builds omit the bundle for fast reloads.
Debug builds retain development facilities and a development signing identity.
They are not production distribution artifacts.

For Metro development on an attached Android phone:

```sh
npm start
adb reverse tcp:8081 tcp:8081
npm run android
```

Metro listens on `127.0.0.1:8081`. Emulators also need `adb reverse` and a
`127.0.0.1:8081` development-server setting. The usual emulator alias `10.0.2.2`
is outside the cleartext allowlist. The release bundle does not require Metro.
`npm run bundle:android` verifies the Metro dependency graph without producing
an APK.

## Supported source-build fallback

Official React Native AAR downloads redirect to `repo.reactnative.dev`. When
that host is unavailable, React Native supports a source composite containing
ReactAndroid and Hermes. The checked-in init scripts substitute both projects
and use the source-built Hermes compiler paired with its VM; mixing it with a
different npm compiler version can produce incompatible bytecode.

On a Linux host, install a C/C++ compiler, make and ICU development headers with
the host package manager (for example `build-essential libicu-dev` on Debian or
Ubuntu). Install Android CMake 3.30.5 through `sdkmanager`. Use Python 3.12+ for
this source bootstrap; its safe tar extraction uses the data filter.

```sh
python3 scripts/android/prepare-boost.py --cache /path/to/external/palmesh-source-deps
python3 scripts/android/gradle.py --source-build --bundle-debug \
  --dependency-cache /path/to/external/palmesh-source-deps :app:assembleDebug
```

`prepare-boost.py` obtains Boost 1.83.0 directly from its official GitHub release,
checks its recorded SHA-256/size pin, checks extracted files against that archive,
generates its header union and materializes a regular header tree. The recorded
pin is not a publisher-issued checksum or signature. `--verify-only` checks an
existing cache without downloading or changing it. Other source dependencies
are fetched by React Native's upstream build through their official URLs.
No TLS, checksum or routing-policy bypass is used.

Set `REACT_NATIVE_BOOST_PATH` to an existing parent of `boost_1_83_0` to use your
own reviewed header cache. ICU is normally found in the system development
installation; set `ICU_ROOT` only for a private host prefix. `PALMESH_SOURCE_CACHE`
provides a reusable cache default. The retained cloud cache at
`/workspace/.palmesh-tools/source-deps` is detected when present; it is optional
and is not required on a normal workstation or GitHub runner.

Unset `JDK_JAVA_OPTIONS` for this build: the Java launcher writes a note to stderr
that AGP's Prefab launcher treats as failure. The wrapper sets processor limits
through `org.gradle.jvmargs`. It uses existing proxy settings when needed and
keeps certificate verification enabled. Authenticated proxy credentials are not
copied into JVM arguments. A source build needs substantially more disk/time
than using prebuilt AARs; allow approximately 20 GiB of free disk.

## Runtime, permissions and security

The app owns chat, maps, emergency inbox and the mesh node through one runtime.
Tab changes do not recreate storage or radios. Startup queues local messages
without waiting for discovery. A storage/key failure shows an explicit retry
state and cannot report an unsaved SOS as sent.

The native composition uses device-protected keys and SQLCipher for the DTN,
peer, chat, location and emergency databases. SQLCipher availability, key records
and ciphertext are checked before use; no plaintext fallback or automatic
identity replacement is provided. Older development plaintext databases are not
silently imported. See [security](security.md) for identity/trust limitations.

Startup/resume only inspect radio permissions. **Enable nearby connections**
requests the relevant Bluetooth and Wi-Fi grants. Android 13+ uses Nearby Wi-Fi
Devices; Android 12 also requires fine location for Wi-Fi discovery, with coarse
and fine requested together. Approximate-only location does not authorize Wi-Fi
Direct. GPS requests are separate explicit actions and location sharing starts
off. The manifest disables application backup and restricts cleartext networking
to loopback for the tile host and development Metro.

The global red SOS button attaches the timestamped cached GPS fix when available,
then queues a 15-hop emergency packet. It does not wait for fresh GPS or map data.
The emergency inbox records incoming SOS and **responding** statements. Local
queuing, peer custody and a person's stated intention remain distinct; none
promises that assistance will arrive. Native SOS notifications use generic text
without sender, coordinates or message content.

## Background and battery behavior

Background connections are an explicit opt-in while the app is foregrounded.
The app requests notification authorization and starts a connected-device
foreground service with an ongoing notification and a Stop action. Stopping the
notification removes the opt-in and shuts down owned native radio activity;
JavaScript cleans the central BLE adapter when runnable. The service is
`START_NOT_STICKY`, does not resurrect the engine after process death and cannot
override Doze or vendor battery policies. A notification is not proof of live
forwarding. Keep PalMesh open until the relevant phone models pass screen-off
testing.

Without the opt-in, backgrounding cancels GPS and stops discovery/connections.
With it, radios may continue while the React Native process remains runnable;
GPS remains foreground/when-in-use. Native battery and power-saver events select
conserve mode at low charge. Conserve mode pauses ordinary forwarding and
periodic location sharing, while SOS remains eligible. A manual mode override
is available.

## Local resources and validation limits

The repository includes a complete licensed local glyph atlas. A real licensed
Palestine MBTiles pack is still required. Missing tiles show a map-unavailable
panel while chat, GPS coordinates and SOS remain usable. Package a reviewed map
with the [map pipeline](maps.md); production release automation refuses a missing
map or provenance manifest.

An earlier ARM64 development APK compiled using the source fallback and passed
APK signature, embedded-bundle and ZIP alignment checks. That verifies the
then-current sources only. See [recorded progress](CURRENT_PROGRESS.md) for the
latest commit/build evidence. Changes to native/security composition require a
fresh native build and physical-device testing. ZIP page alignment does not by
itself validate every ELF library's runtime behavior on a 16 KiB page device.

Follow [device acceptance](device-acceptance.md) before deployment, and the
[release procedure](releasing.md) for operator signing. Physical-phone results,
iOS compilation and an independent security audit cannot be established by
Linux JavaScript tests.
