# Android offline-map cold start

## Failure and correction

MapLibre Android 13.6.1 obtains `ConnectivityReceiver.isConnected()` from
Android's active network when no SDK override is set. Without an active
network, its HTTP scheduler can suspend **loopback** requests too. An inline
style can therefore load while streets and labels remain blank. Attribution is
ordinary app text and never proves tiles were fetched or rendered.

`OfflineMapView` now validates the local-only descriptor and calls MapLibre's
`NetworkManager.setConnected(true)` on Android **before mounting the renderer**.
This overrides the SDK scheduler's reachability hint. It does not enable Wi-Fi,
mobile data, change Android connectivity, download maps, or add online fallback.
The inline style uses only tokenized `127.0.0.1` tiles and glyphs, with no
external styles, TileJSON, sprites or font services. iOS retains its behavior.

The complete loading path is: verify/copy the pinned bundled MBTiles into
internal no-backup storage; open SQLite read-only; bind the native host to
`127.0.0.1`; return a session-token descriptor; construct the inline style;
enable Android SDK local HTTP scheduling; fetch XYZ tiles (converted to TMS)
and bundled Noto glyph ranges; render geometry and Arabic-preferred labels.
The host preserves loopback peer checks, exact Host validation, random tokens,
bounded requests and gzip handling. Android cleartext remains denied except
for `127.0.0.1`. Identity, encryption and DTN storage are unchanged.

The screen only reports ready after native rendered-feature queries find map
geometry. A blank renderer times out into the localized error and retry path.
Explicit retry now reopens the native map source, including stale sources
previously marked ready. Ordinary refresh preserves healthy sessions. SOS
remains independent of map initialization/retry.

## Reproduction and acceptance evidence

`.github/workflows/offline-map-render.yml` builds original system-reachability
behavior on x86_64, the corrected x86_64 variant, and the corrected ARM64 test
APK. Only the corrected ARM64 APK is published for installation. The baseline
removes just the scheduler hint; it never artificially forces the SDK offline.

`scripts/android/map_smoke.py` creates a fresh official API 35 AOSP emulator
with no snapshots or previous map cache. Before installation/first launch it
disables Wi-Fi, mobile data and Bluetooth, verifies no active default network,
disables non-loopback guest interfaces (including virtual Ethernet, which
airplane mode does not disable), and rejects non-loopback IPv4/IPv6 egress.
Absent-radio settings are accepted only when Android advertises no such
hardware. Failed isolation retains connectivity/interface/radio diagnostics
and never counts as an application test. Root is used only in this
disposable emulator to install firewall rules, never in the app or on a phone.
Normal ADB authentication is preserved.

Acceptance requires local tile/glyph hits, actual rendered geometry, roads,
labels and Arabic-labelled features, plus map-only screenshot pixel detail and
changed detail after pan/zoom. Android must still report no active internet.
The app is then force-stopped and cold-launched again; the existing smoke flow
also checks durable public chat/SOS and stable identity. Debug-only native
diagnostics log aggregate counts, not URLs, tokens, coordinates or identities.
Screenshots and bounded runtime errors are retained as Actions artifacts.

The workflow reuses genuine-map artifact `12664512510` from successful run
`40352843627`, producer commit `84464a5b19387b3f0d0e8bbf1bf425329236ecfd`.
It independently pins map SHA-256
`16a88c49eb002bfc4729327bef4629e513f33069532b815c532316738aef06b8`, source
SHA-256 `bb28f83176b77d1b58701b8e2ebe4b241d37c7871e51f2739a9a684b47c5d44f`
and source date `2026-10-25T21:21:21Z`, then runs the full map/manifest
validator. The genuine map bytes, provenance and licenses are preserved.

Local checks on October 26, 2026 passed: TypeScript/build, 380 core tests,
81 React Native tests, 43 Android-tool tests and 53 map-tool tests. The ARM64
bundled debug build passed signature, JavaScript, genuine map/glyph packaging,
native ABI, ZIP and ELF 16-KiB alignment verification. Local builds use the
same genuine PBF but an independently generated local MBTiles hash; hosted
acceptance uses the immutable artifact above.

Hosted runtime results must be read from the PR's exact-commit Actions run;
this procedure is not itself a passing emulator result. Neither emulator
rendering nor a successful build establishes physical-phone success. Retest
the new APK with Wi-Fi and mobile data off **before** launching, then pan,
zoom, inspect Arabic labels and force-stop/relaunch. Preserve app data and do
not uninstall merely to test cold startup. Independent security review, real
radio/GPS acceptance and release signing remain separate requirements.
