# Offline maps and last-known location

The maps feature adds MapLibre rendering, read-only Android and iOS vector MBTiles
host, foreground GPS capture, opt-in DTN location broadcasts and an independent
SQLite location registry. The SOS control queues directly through the DTN
engine with a timestamped cached fix when available, without waiting for GPS,
map initialization or the location database.

**No Palestine MBTiles file is included.** With no asset, the screen reports
that the map is unavailable and continues to show stored coordinates and SOS.
No remote basemap or download is substituted. The included
[Android application shell](android-app.md) mounts the feature modules and has
built a development APK. Physical-device rendering and GPS behavior remain
unverified. The [iOS host](ios-app.md) passed its macOS Release simulator build;
physical iPhone rendering and GPS remain separate acceptance checks.

The verified 256-page Noto glyph atlas and Arabic presentation forms are bundled
for local street/place labels. The real map-data download is currently blocked
by the cloud proxy. Follow [map generation and packaging](../mapdata/README.md)
once official Geofabrik access or an authentic local extract is available.

## Files and dependencies

```text
src/features/maps/
  domain/                         Location validation, age labels, offline style
  application/LocationService.ts   State, persistence, broadcasts and SOS
  infrastructure/                 SQLite, cancellable GPS and native map adapters
  ui/                             MapsProvider, useMaps, PalMeshMapsApp
native/palmesh-offline-maps/        Android/iOS read-only MBTiles and glyph hosts
scripts/maps/                      Real OSM generation, validation and packaging
assets/map-fonts/                  Verified Noto glyph atlas and SIL OFL license
assets/map-licenses/               ODbL text and OpenStreetMap attribution
```

Pinned dependencies are MapLibre React Native 11.5.0 and community geolocation
3.4.0, alongside React Native 0.88.0. Core exports from `features/maps` never load
React Native, MapLibre or the geolocation native module. Import screens from
`features/maps/ui` and native factories from `features/maps/infrastructure/reactNative`.

## Map asset and native setup

The delivered hosts link `native/palmesh-offline-maps`, MapLibre, geolocation
and safe-area context. Follow the
[native integration guide](../native/palmesh-offline-maps/README.md) when embedding
the feature elsewhere. Generate and stage licensed, verified data using
`scripts/maps/package.py`; it places the map at:

```text
android/app/src/main/assets/palmesh/palestine.mbtiles
ios/PalMesh/palmesh/palestine.mbtiles
```

The bridge expects a standard `metadata` table and `tiles` table/view, PBF
vector tiles, TMS rows, `format=pbf`, `bounds=west,south,east,north`, integer
`minzoom`/`maxzoom` within 0–22 and `json.vector_layers[].id`. Up to 128 unique
source layers are supported. Attribution is displayed as inert text. Use the
pack's required credit/license, including OpenStreetMap attribution if relevant.
The source-layer geometry style adapts to metadata rather than assuming a
particular tile schema. It supplies polygons, lines, points and street/place
labels when the native descriptor includes bundled glyphs. Label selection
prefers `name:ar`, then `name`, `name:en` and `name:latin`. Older/custom packs
without glyph resources can render geometry without labels.

The native host copies the bundled database into internal no-backup storage,
opens it read-only and serves tiles only on a token-protected `127.0.0.1` port.
XYZ requests are translated to MBTiles TMS rows; gzip tiles retain their content
encoding. The map packager generates a pinned SHA-256 for the delivered host to
validate the copied map. Custom native-source callers can supply a trusted
`expectedSha256`; omitting it removes this content check. Large
packs need space for both the APK asset and extracted file, plus a temporary
copy during preparation. Never copy a live SQLite database with an uncheckpointed
WAL as a standalone MBTiles asset.

Android sockets require `INTERNET` even without internet connectivity. Permit
cleartext only for loopback using the native guide's network-security config;
do not enable application-wide cleartext. The style has no remote TileJSON,
glyph service, sprites or online fallback. Tiles and glyphs share the same
random session token and loopback host. Android explicitly overrides MapLibre's
SDK reachability hint before mounting to make local scheduling independent of
system internet reachability. This never enables a device network or adds online
services. See [cold-start diagnosis and acceptance](offline-map-cold-start.md).
The iOS bridge implements the same descriptor, bounded reads
and token-protected local glyph contract; its host preserves the asset folder.

For GPS, the host manifest must grant fine/coarse foreground location. The radio
library's fine-location declaration has a maximum SDK for Wi-Fi discovery, so
remove that restriction in the app's merged permission declaration:

```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
          xmlns:tools="http://schemas.android.com/tools">
  <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION"
                   tools:remove="android:maxSdkVersion" />
  <uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
</manifest>
```

The native factory requests both permissions and accepts approximate location.
It uses Android's system location provider without Google Play Services. GPS
can work offline, but a cold fix may exceed the action deadline without assisted
GPS. For iOS, set `NSLocationWhenInUseUsageDescription` and link geolocation;
the factory requests only when-in-use authorization. No background-location
permission or persistent GPS watch is requested.

## Composition root

```tsx
import type { RuntimeResources } from '../src/app/domain/types';
import { PalMeshMapsApp } from '../src/features/maps/ui';

// Created once by createNativeResources, with a secure vault, SQLCipher
// location repository, authenticated DTN engine and bundled map options.
// AppRuntime owns their lifecycle and starts the engine before the features.
declare const resources: RuntimeResources;
function MapsRoute({ isFocused }: { readonly isFocused: boolean }) {
  return <PalMeshMapsApp service={resources.locations} visible={isFocused} />;
}
```

Keep one service/provider and one native map-source owner per runtime. The
provider starts/stops feature subscriptions and its local tile host, never the
DTN engine, radios or host-owned database. At runtime disposal, unmount the
screen, await `locations.stop()`, stop the node, then close the connection.
The native composition uses separate dedicated encrypted SQLite handles.

## Sharing, persistence and freshness

Sharing starts disabled on every service start. **Update GPS** stores a fix
locally; **Share location once** captures GPS and queues one broadcast with the
normal 10-hop TTL. Periodic sharing is explicit and attempts at most once per
60 seconds by default. It runs only while both the app and maps route are
visible. Hiding the route, backgrounding, stopping or disabling sharing cancels
an active GPS action. A queued routing packet cannot be recalled by switching
sharing off. Coordinate broadcasts are signed, but readable by mesh participants;
direct-chat encryption does not make public locations confidential.

`setPowerMode('conserve')` pauses automatic capture/sharing. Explicit GPS/share
actions and SOS remain available; the host can also call the DTN engine's
separate conservation policy for routing. Map rendering reduces its requested
frame rate in conservation mode. Native battery monitoring is a host concern.

GPS watches are temporary and cleared after the first result, failure, abort
or deadline. Late permission results and native callbacks cannot start an
abandoned action or replace current state. Repeated in-flight presses are
bounded. SOS has its own guard and does not wait behind GPS.

The registry persists one local fix and the latest fix for each peer, with a
default capacity of 1,000 peers (configurable 1–20,000). It binds to the local
device identity and rejects reuse by a different identity. Older/equal fixes
do not replace newer reports or refresh their age; current UUID replays also
cannot change their payload. At capacity, the least recently received peer
reports are evicted. Local fixes persist independently of routing retention.

Only broadcast `location` or SOS packets containing a fix create peer markers.
Relayed private unicast messages do not. Future fixes beyond a five-minute
skew allowance relative to local arrival/current time are rejected. Sender clocks
and reported coordinates are self-asserted. The native app authenticates the
source key fingerprint, which does not prove a person's identity or the truth
of a location. A newer timestamp is not a guarantee of accuracy. Clock correction
can affect which future fixes pass the bound. See [the security model](security.md).

The peer list shows both GPS-fix age and local report-receipt age. A DTN report
received just now may describe an old location. Report age never establishes
current connectivity or presence. Points outside the bundled coverage remain
listed even though the camera is constrained to the pack's bounds.

Startup subscribes before reading routing history. Reports coalesce into a
bounded 1,000-peer pending map, flush in batches of 100 and retry after storage
failure. Refresh reconciles up to 1,000 retained routing records. A prolonged
archive failure, overflow or router retention expiry can leave gaps. Stored
coordinates and an already accepted routing SOS survive independent failures;
an unavailable archive is surfaced rather than reported as a failed SOS queue.

## Verification and limits

`npm run check` runs strict typing, core/real-SQLite/application/GPS tests,
React Native interaction tests and the build. Tests cover restart recovery,
monotonic fixes, filtering, bounded bursts, permissions, GPS cancellation,
foreground and conservation policy, map-source races and SOS during failure.
UI tests replace the native renderer at its boundary; they do not render real
vector tiles or establish hardware GPS performance.

`python3 -m unittest discover -s scripts/maps/tests -v` checks map build inputs,
MBTiles validation, source dates/provenance, native-compatible metadata,
bounded compression, glyph integrity/licensing and safe asset replacement.
Synthetic data appears only in validation fixtures and is never packaged as a
real map. `python3 scripts/maps/package.py --fonts-only --check` verifies the
real licensed glyph resources without claiming map data exists.

The Android app has built a development APK. Physical-device map rendering,
loopback policy, permissions and airplane-mode GPS/radio interruptions remain
unverified. A real approved Palestine dataset is still required. The generator
checks structural coverage at nine cities and retains the OSM source date;
it cannot verify present-day conditions. iOS Release simulator compilation has
passed; physical-device rendering and distribution signing remain required.
Application cryptography and encrypted persistence are
implemented, with the limitations described in the security model; no field
validation or independent security audit is claimed.

## Emergency assistance map

See [Emergency Map/GPS milestone](milestones/emergency-map-gps.md) for current
original-ID SOS markers, offline foreground acquisition, privacy, errors and the
physical retest plan. Earlier dataset/device limitations above are historical;
the map-bundled workflow pins the existing genuine Palestine producer artifact.
