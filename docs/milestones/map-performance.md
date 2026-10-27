# Ordinary Android map performance

The user confirmed on TECNO POVA 5 / LH7n, Android 14, Helio G99, 8 GB RAM,
1080×2460: offline rendering works, but interaction is severely laggy for roughly
one minute and becomes normal afterwards.

PR #9's acceptance tracing was enabled for every debuggable APK. It enumerated
all rendered geometry, all roads again, and labels, then fetched camera state
on a one-second timer for 60 seconds and from rendering/camera callbacks. An
observed overview probe returned 8,337 geometry + 7,781 road + six label objects:
16,124 complete feature records crossing the native/JS bridge in one probe.
These include full coordinates/properties; they are not cheap count queries.
Repeated allocation, serialization and collection compete with rendering and
input handling. The 60-second polling window matches the physical report.
This acceptance work should not have been enabled in a human-facing test APK.

Normal debug/release maps now make **zero queryRenderedFeatures calls**. During
loading they read only small native local-resource counters, with at most 12
attempts and the existing honest error deadline. Once local data is ready,
polling and rendering/camera observation callbacks stop. The map component is
memoized and retains stable camera props. Native tile tracing and full rendered
feature diagnostics require explicit `-PpalmeshMapDiagnostics=true` in a debug
acceptance build; release builds cannot enable them. Published ARM64 APKs have
that metadata explicitly verified false inside the sealed APK.

The data, local-only style/glyph URLs, tokenized loopback server, Arabic fonts,
GPS and SOS are preserved. No radio, encryption, identity or database reset is
part of this fix. Runtime readiness uses successful local tile delivery; actual
pixels/Arabic appearance are separately checked by emulator acceptance rather
than enumerating features continuously on users' phones.

`map_perf_smoke.py` exercises the actual ordinary APK offline, performs repeated
zoom/navigation actions and a visible pan, checks that no diagnostic feature
records appear and loading-status polling stops, then verifies chat/SOS/identity
persistence after restart. It retains screenshots, CPU/thread samples, Android
UI gfxinfo and available SurfaceFlinger timestamps. Automation wall times include
ADB/UI-dump overhead; gfxinfo alone does not measure all MapLibre GPU work.
Emulator CPU/frame statistics are not physical TECNO FPS measurements.

The new **PalMesh Map Performance Test** package (`org.palmesh.mapperftest`)
installs alongside both `org.palmesh` and the previous `org.palmesh.maptest`.
It has a separate identity/storage. Neither installed app needs removal or data
clearing. CI debug signing keys are ephemeral, so this deliberately avoids
requiring an in-place signature update. The Actions artifact is named
`android-offline-map-performance-test-apk`; install its
`palmesh-map-performance-test.apk`. Physical smoothness requires user retesting.

Hosted evidence at `1c503b1`: run 40527807315, job 122272834700 passed
two cold starts with external guest networking blocked, ordinary-build actual
street pixels, zoom/pan pixel changes, zero diagnostic feature records, bounded
readiness polling, public chat/SOS persistence and stable identity. OS CPU/thread
and frame diagnostics are retained in the workflow artifact. This is emulator
evidence, not a TECNO phone performance measurement. ARM64 APK verification and
publication passed in job 122272833977.

The separate instrumented acceptance jobs stalled their gesture checks while
repeatedly querying 8,337 geometry and 7,781 road records; the ordinary performance
job passed. Acceptance now captures one initial geometry/label sample and uses
scalar zoom/center getters for subsequent camera evidence. Counts in that mode
describe the initial sample; post-gesture screenshots separately prove rendering.
Ordinary builds still make zero rendered-feature queries.
