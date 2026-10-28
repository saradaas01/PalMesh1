# Emergency Map and foreground GPS

This milestone builds on PR #11 → #10 → #9 without merging them. The user reports
successful physical two-phone chat/SOS exchange, but TECNO POVA 5 / Android 14
could not acquire GPS even with device Location on and Precise permission. No
phone is attached here. Those user results are distinct from automated evidence.

## Findings and implementation

The old source discarded accuracy and collapsed native failures plus a 20-second
watch deadline into one generic unavailable error. The library's Android watch
selected GPS before checking permission: coarse-only access could select GPS,
then fail without trying a permitted network provider. Its disabled-provider
callback did not notify the watch. Precise permission was granted in the reported
TECNO test, so the coarse-only defect does not establish that phone's exact cause.
A short cold-acquisition budget is a limitation, not a proven hardware diagnosis.

Android now uses scoped LocationManager requests, independent of Play Services or
an app internet service. It checks foreground fine/coarse authorization and the
device Location switch, subscribes only to permitted enabled GPS/network providers,
accepts a genuinely fresh monotonic-age cached fix, and waits up to 90 seconds for
a cold fix (permission waiting separately bounded to 30 seconds). Network fixes
can provide an explicitly approximate fallback after 10 seconds. No provider fix
means no coordinate; there is no manufactured fallback. Cancel, leaving the map,
backgrounding, stop and completion remove listeners and timers. Distinct denied,
disabled, timeout and provider errors give simple English/Arabic instructions.
`adb logcat -s PalMeshGps` shows sanitized request/provider/outcome stages, never
coordinates, message content, identities or keys.

Local accuracy/approximation metadata is additive and bound to its fix timestamp
in the protected location database. Existing identity, database schemas and records
are preserved. The three-field signed wire location contract stays compatible:
received reports therefore say accuracy was not provided and may be approximate.
The receiver must never infer precise accuracy from another record or a contact.

The map uses EmergencyService's durable original-ID SOS entries, not the latest
per-contact location registry. Two SOS reports by the same contact retain separate
markers and original fixes; reports without coordinates remain visible with
Location unavailable. Original report time (Palestine time), GPS fix age, old
location warnings, saved names and unknown accuracy remain explicit. Blue is the
local stored fix, red is SOS, amber is voluntary peer sharing. No marker means
live presence, connection, rescue or a safe route. Out-of-coverage focus gives an
honest message and keeps the original coordinates in optional details.

SOS markers and list actions select the report. Inbox View on map passes its ID;
Android notification taps use ACTION_VIEW to open the inbox through a fixed, content-free URI, including cold process recreation.
Coordinates are optional details. Sharing remains opt-in, public to mesh peers,
and foreground-only. SOS uses its existing cached-fix behavior immediately and
never waits for acquisition. Incoming SOS lists are virtualized to keep a large
archive from burdening map gestures. Genuine tiles, glyphs and provenance are
unchanged; no online map is added.

## Verification and physical retest

Core tests use signed realistic synthetic packets, actual DTN validation, SQLite
reopening, duplicate/tamper rejection and original-ID map projection. UI tests cover
missing/old locations, focus, cancellation, error guidance and SOS availability.
Native JVM tests cover permitted provider selection, monotonic cache freshness at delayed fallback/deadline delivery, and newer equal-accuracy candidates.
The hosted workflow checks an actual notification tap after confirmed process death, native marker-tap camera focus, screenshots/map pixels and native GPS injection
in a fresh externally blocked AOSP guest. Only completed results count as passed;
exact source, job results, checksum and APK links are recorded in PR #12.

The ARM64 human APK is **org.palmesh.emergencytest / PalMesh Emergency Map Test**,
separate from every earlier app, with a fresh test identity. It contains no synthetic
SOS injection and runs without map diagnostics. An alternate x86-only entry point seeds explicitly SIMULATED signed
SOS reports through the normal DTN receiver for emulator acceptance, with acceptance-only native camera counters. Gradle refuses
that entry for ARM64/release; APK verification refuses a synthetic marker in a human
build. Neither test path bypasses message authentication or changes a real app's
identity. The simulator/emulator do not establish physical GNSS or radio behavior.

On both actual phones, keep Location enabled and allow foreground Precise location;
try My location outdoors with a clear sky and allow the bounded cold-acquisition
wait. Confirm blue marker/accuracy and persistence after offline restart. Confirm
Cancel and each relevant error leave SOS immediately sendable. Explicitly share
once, then exchange two located SOS reports and one without a fix, checking the
original IDs/positions, names/times, red markers, inbox focus and unknown accuracy.
Also retest offline gestures, Arabic/font sizes, notification taps, encrypted chat,
SOS responses and radio delivery. Do not delete any original installation.
