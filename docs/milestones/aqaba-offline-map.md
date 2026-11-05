# Aqaba offline map demonstration

The demo starts at Aqaba, Jordan (`29.531 N, 35.006 E`, zoom 13), while retaining
the existing Jordan map bounds. This is a camera position only. It never creates
a GPS fix, outgoing location packet or SOS position. A pack outside Aqaba's
coverage fails visibly rather than switching to an old regional map or an
online style. Streets and buildings start at zoom 13; native map detail reaches
zoom 14 and can be overzoomed locally to 18.

The existing Jordan generator and authentic OpenStreetMap artifact are reused.
The [successful producer](https://github.com/saradaas01/PalMesh1/actions/runs/42001163336)
built source `f8d89e8d8977625fb724f4c560197c92f9492e1d` and published
[`palmesh-candidate-jordan-map`, artifact 13403170758](https://github.com/saradaas01/PalMesh1/actions/runs/42001163336/artifacts/13403170758).
The producer's logged data time is `2026-11-03T21:24:23Z` and MBTiles SHA-256 is
`4a291b601e85628eea7e0d51595c027044c078eee89ec5ff39866d49ec106ba2`.
The ZIP SHA-256 is
`ae71d7c288f495926d255b8d77c80f2492f6706ba62122752d0fa69b9a51f94b`.
The map and manifest retain their original bytes, source provenance, ODbL
license, attribution and timestamps; this change does not relabel old data as
new data. Candidate map generation is now an explicit manual refresh workflow.

`scripts/maps/package.py --report dist/maps/aqaba-coverage.json` validates the
artifact before staging it and the complete 256-page Noto glyph atlas for both
platforms. It also generates the runtime's expected map digest. All styles,
tiles and glyph requests remain on the token-protected loopback host. The
native host and APK checks enforce the expected digest and bundled resources.
There is no network style or remote tile fallback.

The validator checks detailed tiles around central Aqaba, the fort/waterfront
area, northern Aqaba and eastern Aqaba. The three urban samples must contain street and building features; the sampled
area must also contain genuinely tagged named places/POIs and Arabic names.
The eastern surroundings sample is reported honestly even when sparse. The
first genuine-artifact CI run found no buildings there and correctly stopped
under the original overly broad requirement. The revised check preserves urban
detail requirements and reports zero counts, sparsity and actual tile coordinates
for surrounding coverage; it never inserts features or substitutes map bytes. The
small existing OSM profile includes named places and selected medical/essential
POIs; it does not include every tourism or historic landmark label. An OSM
feature, name or road is not evidence of current access, safety or an operating
service.

The map change preserves real OS GPS acquisition, permission handling, fix age
and accuracy, explicit refresh, and voluntary public sharing. SOS publication
still uses the latest valid cached fix without waiting for GPS. Red markers and
View on map keep the coordinates and ID of each original report; an unlocated
report remains Location unavailable. Blue local and amber voluntary peer
markers remain distinct. A selected report is a last reported position, not
live tracking or proof of a connection.

## Verification and remaining physical checks

Local checks: 60 map packaging/provenance/coverage tests, 87 map/GPS/SOS
domain tests, 13 renderer UI tests, and 87 Android harness tests pass. Synthetic
unit tiles only exercise validators and are never offered as production assets.
The signed emulator SOS fixture and OS GPS injection now use distinct Aqaba
coordinates. Historical sealed replay APKs predate this fixture and must be
replaced before executing the updated Aqaba harness.

The local environment could not retrieve the published artifact bytes because
the connector download host is outside its configured network policy. The
hosted build must download the pinned artifact, validate its bytes with the new
checks, retain `aqaba-coverage.json`, package real MBTiles/glyphs and verify the
resulting APK. Local source tests alone do not establish those hosted results.
Emulator acceptance is synthetic native OS GPS evidence, not physical GNSS or
a two-phone communication result.

Use only the new side-by-side demo application for this checklist. Keep existing
PalMesh installations, identity keys and conversation databases intact.

1. On a fresh demo installation, before acquiring any location, send an SOS to
   another demo phone. Confirm its incoming report says Location unavailable
   and offers no action that substitutes a position.
2. Disable mobile data and Wi-Fi internet on both phones. Open Map and confirm
   Aqaba streets, buildings and Arabic names render; pan north/east/waterfront,
   zoom in/out, close and restart the app, then repeat with internet still off.
   Wi-Fi Direct/Bluetooth may remain available for the offline mesh test.
3. Outdoors, grant location permission and explicitly update My location.
   Confirm a blue marker appears only after an actual fix, with age and
   accuracy/approximation status. Confirm refreshing does not share the fix.
   Deny permission and disable Location separately; retain the last known fix
   and confirm actionable status, with SOS still available.
4. Send an SOS while a new GPS request is pending. Confirm it queues promptly
   using the existing valid cached fix, or no fix if none exists. Do not wait
   for a fresh fix or present an unsuccessful local write as queued.
5. Receive two SOS reports at different acquired positions, including an old
   cached fix. Confirm separate red markers; tap each marker and each inbox
   View on map action. Verify its exact original message, sender identity/name
   when available, original report time, coordinates and stale-location warning.
6. Open the SOS notification after a cold restart and repeat map navigation.
   Confirm missing-location reports remain unlocated and that reports outside
   the bundled Jordan bounds display a coverage warning.
7. Explicitly share a location after reading the public-sharing disclosure.
   Confirm amber peer markers remain distinct and that restarting does not
   enable periodic sharing or change original SOS coordinates.

Record phone models, Android versions, APK/source digest, source data date,
permission choices, internet isolation and actual observations. Do not describe
an emulator-injected position as a physical GNSS fix.
