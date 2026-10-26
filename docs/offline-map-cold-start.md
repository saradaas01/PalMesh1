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
not a byte-identical old APK. Accessible controls and explicit gesture settings
also remain. It never artificially forces the SDK offline.

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
zoom and requires an increase of at least 0.5 after pressing the accessible
**Zoom in** button, then a separate pixel change after panning. These controls
also make map zoom usable without multi-touch; double-tap/pinch interaction
remains a separate physical gesture check. Earlier runs only proved changed gesture pixels,
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
85 React Native tests, 49 Android-tool tests and 53 map-tool tests. The ARM64
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

Source `217d07f`, SwANGLE job `121847663232` in
[run 40401278080](https://github.com/saradaas01/PalMesh1/actions/runs/40401278080),
produced a full-resolution offline image with legible Arabic names including
القدس and غزة. This confirms that the preserved glyph pack can render Arabic
offline under that emulator backend. Its overall job failed the new zoom check:
debug sampling had stopped after initial readiness, leaving no fresh camera
measurement. Another job failed an ADB-root startup request. Neither failure
is reclassified as a passing end-to-end run. Later changes sample debug camera
state for a bounded 60 seconds/on camera changes, verify actual guest UID 0
with bounded root retries, and use accessible product zoom controls. SwiftShader
image artifacts do not establish a physical-phone font defect.

### Reproducible nested-map gesture defect

Source `e89b3d2`, run `40403793272`, verified native zoom from
6.5160958492 to 7.5160958492 and local tile hits increasing from two to four,
but then failed because swiping did not change the map pixels. Inspection of
the pinned Android bridge's `MLRNMapView.onTouchEvent` shows that parent touch
interception is disabled only when its nullable `scrollEnabled` field is
explicitly true. Omitting `dragPan` leaves that field null even though SDK map
gestures otherwise default to enabled; the surrounding FlatList can take the
swipe. The map now explicitly enables `dragPan`, `touchZoom` and `doubleTapZoom`.
This is an observed pan/lifecycle defect; it does not prove the separate phone
blank-map root cause. The stronger test requires both a native camera-movement
counter increase and changed pixels after the swipe. Only a count is exported;
camera center coordinates remain inside the component and are never logged.

Source `a503834` passed two complete primary-app cold starts, measured zoom
6.5160958492 → 7.5160958492, four local tile hits/three glyph hits and actual
camera movement with changed pixels. The isolated SwANGLE app passed its first
render/zoom/pan but missed pan on restart. The follow-up keeps camera constraint
props stable across report-clock updates and uses a fresh visible viewport and
a substantial vertical swipe in the test, still requiring native movement.
The old baseline classifier also wrongly accepted an initial zero-count sample
after later successful rendering. Its success message in run `40405641252`
**does not prove a connectivity-gate reproduction**. The classifier now records
recognized baseline behavior separately, requires sustained final zero-count
samples for a blank result, and never accepts infrastructure failures. Regression
tests cover this false-positive case. The physical blank-map cause remains
unconfirmed; no baseline observation is presented as a passing fixed-app test.

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
identified test app is built with `-PpalmeshIsolatedMapTest=true`: its ID is
`org.palmesh.maptest` and launcher label is **PalMesh Map Test**. It has its own
data and identity and cannot prove migration of the original installation.
The normal debug/release application remains `org.palmesh`. The verifier requires
an explicit `--isolated-map-test` flag, that exact ID/label, debuggability,
embedded JavaScript and a checksum-matching map. It rejects using this mode as
a release. The SwANGLE x86_64 job runs the isolated identity; the ARM64 job
publishes both the primary APK and `android-offline-map-isolated-test-apk`.
Download/extract the latter ZIP and install `palmesh-map-test.apk` alongside
the existing app. Do not uninstall or clear the existing PalMesh app. Disable
Wi-Fi/mobile data before opening **PalMesh Map Test** for the cold-start retest.
Its identity/history are separate; use the original app for existing conversations.

For a phone still showing a blank/error map, capture the debug APK's aggregate
native evidence without clearing app data:

```sh
adb logcat -d -s PalMeshOfflineMap:I Mbgl-HttpRequest:V Mbgl-ConnectivityReceiver:V AndroidRuntime:E ReactNativeJS:E
```

Redact session tokens in any SDK URLs before sharing logs. Record phone model,
Android version, APK SHA/certificate, whether Wi-Fi/data were off before launch,
and whether tile/glyph hits or render features appear. These distinguish failed
asset/server requests, SDK scheduling and GPU/style errors on the actual device.
