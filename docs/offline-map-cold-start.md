# Android offline-map cold start

## Phone report, loading risk and correction

MapLibre Android 13.6.1 obtains `ConnectivityReceiver.isConnected()` from
Android's active network when no SDK override is set. The documented SDK
connectivity override controls resource scheduling, so relying on internet
reachability is inappropriate for local HTTP resources. Attribution is ordinary
app text and never proves tiles were fetched or rendered. However, the hosted
baseline below also fetched local tiles while the SDK reported disconnected.
Therefore this SDK hint is a hardening fix, **not conclusive proof of the exact
root cause on the user's physical phone**. OEM-specific runtime evidence and a
retest are still required before claiming that the reported phone defect is fixed.

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
behavior on x86_64, corrected x86_64 variants with SwiftShader and SwANGLE, and
the corrected ARM64 test APK. The two official software backends help diagnose
symbol artifacts; neither establishes physical GPU behavior. Only the corrected
ARM64 APK is published for installation. The baseline
removes the scheduler hint and preparation mount gate to retain original
immediate mounting and system reachability. Aggregate tracing, status/error
handling and geometry probes remain, so it is an instrumented comparison,
not a byte-identical old APK. It never artificially forces the SDK offline.

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
changed detail after gestures. The latest harness additionally records native
zoom and requires an increase of at least 0.5 after a double tap, then a separate
pixel change after panning. Earlier runs only proved changed gesture pixels,
not an independently measured zoom change. Android must report no active internet.
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
81 React Native tests, 44 Android-tool tests and 53 map-tool tests. The ARM64
bundled debug build passed signature, JavaScript, genuine map/glyph packaging,
native ABI, ZIP and ELF 16-KiB alignment verification. Local builds use the
same genuine PBF but an independently generated local MBTiles hash; hosted
acceptance uses the immutable artifact above.

### Observed hosted results, source c8a3471

Run [40364852160](https://github.com/saradaas01/PalMesh1/actions/runs/40364852160),
fixed x86_64 job `121719665990`, passed two cold starts with external guest
traffic rejected. First render reported 8,337 geometry features, 7,781 roads,
six Arabic-labelled symbols, two local tile hits and three local glyph hits;
Android internet connectivity remained false. Screenshot road-pixel counts
were 14,634 before and 14,706 after gestures, with distinct pixel hashes.
The second launch also rendered and the public chat/SOS/identity checks passed.
The initial run's isolation failed before launch; it provides no map result.

The hint-only baseline job `121719666601` reported the same first-render feature counts
and local hits with `sdkConnected=false`. Its original harness wrongly required
`sdkConnected=true` even for the baseline, then failed its predicted zero-hit
condition. That run's workflow conclusion is **failure**, not a passing baseline
reproduction. The harness now accepts actual rendered evidence independently
of that hint and explicitly records `reproduced=false` when the old behavior
renders. That first comparison still retained the new preparation mount gate;
the final baseline also removes that gate to test original immediate mounting.
It never substitutes a forced-disconnected variant for the original.

### Improved comparison, source 860cdb0

[Run 40397944813](https://github.com/saradaas01/PalMesh1/actions/runs/40397944813)
passed all three map jobs. Fixed x86_64 job `121836302268` again rendered on two
cold starts and retained chat/SOS/identity. Baseline job `121836302680` restored
both original immediate mounting and system reachability; it also rendered and
explicitly recorded that the physical failure was not reproduced. The fixed
first-render counts were 8,337 geometry, 7,781 roads, six Arabic-labelled symbols,
two tile hits and three glyph hits. No SDK/render/EGL errors were captured; the
second launch logged the explicit SDK connectivity hint while Android remained
offline. Images show actual street detail and pan movement.

**Label-query counts do not prove readable text pixels.** At this checkpoint,
the SwiftShader map images contain blue/white symbol patches rather than clearly
legible Arabic. Glyph requests and Arabic feature queries passed, but visual
Arabic-label acceptance remains unverified. Do not describe that result as a
successful font/Arabic visual acceptance test or as proof of phone behavior.
The subsequent measured-zoom test retains full-resolution map-only images for
further diagnosis. The real glyph assets/provenance are preserved.

Neither emulator rendering nor a successful build establishes physical-phone
success. Retest
the new APK with Wi-Fi and mobile data off **before** launching, then pan,
zoom, inspect Arabic labels and force-stop/relaunch. Preserve app data and do
not uninstall merely to test cold startup. Independent security review, real
radio/GPS acceptance and release signing remain separate requirements.

### Installation and runtime diagnostics

CI debug signing keys are ephemeral: the old map candidate's certificate was
`df407503dcd1626bcecb4a4670409719b03085f8b401506463f69f292e248f6a`.
A newly signed CI APK may not update that installed app. Do not uninstall or
clear storage to work around a signing mismatch; it would remove local identity
and messages. An in-place update requires the original signing key. A separately
identified test app can instead be built when needed; it would have its own data
and identity and cannot prove preservation of the original installation.

For a phone still showing a blank/error map, capture the debug APK's aggregate
native evidence without clearing app data:

```sh
adb logcat -d -s PalMeshOfflineMap:I Mbgl-HttpRequest:V Mbgl-ConnectivityReceiver:V AndroidRuntime:E ReactNativeJS:E
```

Redact session tokens in any SDK URLs before sharing logs. Record phone model,
Android version, APK SHA/certificate, whether Wi-Fi/data were off before launch,
and whether tile/glyph hits or render features appear. These distinguish failed
asset/server requests, SDK scheduling and GPU/style errors on the actual device.
