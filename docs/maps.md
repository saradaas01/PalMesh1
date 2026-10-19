# Offline maps and last-known location

The maps feature adds MapLibre rendering, a read-only Android vector MBTiles
host, foreground GPS capture, opt-in DTN location broadcasts and an independent
SQLite location registry. The SOS control queues directly through the DTN
engine with a timestamped cached fix when available, without waiting for GPS,
map initialization or the location database.

**No Palestine MBTiles file is included.** With no asset, the screen reports
that the map is unavailable and continues to show stored coordinates and SOS.
No remote basemap or download is substituted. The included
[Android application shell](android-app.md) mounts the feature modules; its
native compilation and physical-device behavior remain unverified.

## Files and dependencies

```text
src/features/maps/
  domain/                         Location validation, age labels, offline style
  application/LocationService.ts   State, persistence, broadcasts and SOS
  infrastructure/                 SQLite, cancellable GPS and native map adapters
  ui/                             MapsProvider, useMaps, PalMeshMapsApp
native/palmesh-offline-maps/        Android read-only MBTiles tile bridge
```

Pinned dependencies are MapLibre React Native 11.5.0 and community geolocation
3.4.0, alongside React Native 0.88.0. Core exports from `features/maps` never load
React Native, MapLibre or the geolocation native module. Import screens from
`features/maps/ui` and native factories from `features/maps/infrastructure/reactNative`.

## Map asset and native setup

Install/link `native/palmesh-offline-maps` as a local dependency in the Android
host, alongside MapLibre, geolocation, safe-area context and the chosen SQLite
binding. Follow its [native integration guide](../native/palmesh-offline-maps/README.md).
Supply a licensed, verified Palestine vector pack at:

```text
android/app/src/main/assets/palmesh/palestine.mbtiles
```

The bridge expects a standard `metadata` table and `tiles` table/view, PBF
vector tiles, TMS rows, `format=pbf`, `bounds=west,south,east,north`, integer
`minzoom`/`maxzoom` within 0–22 and `json.vector_layers[].id`. Up to 128 unique
source layers are supported. Attribution is displayed as inert text. Use the
pack's required credit/license, including OpenStreetMap attribution if relevant.
The source-layer geometry style adapts to metadata rather than assuming a
particular tile schema. It supplies polygons, lines and points; street/place
labels require separately bundled font resources and are not included.

The native host copies the bundled database into internal no-backup storage,
opens it read-only and serves tiles only on a token-protected `127.0.0.1` port.
XYZ requests are translated to MBTiles TMS rows; gzip tiles retain their content
encoding. An optional trusted SHA-256 digest validates the copied map. Large
packs need space for both the APK asset and extracted file, plus a temporary
copy during preparation. Never copy a live SQLite database with an uncheckpointed
WAL as a standalone MBTiles asset.

Android sockets require `INTERNET` even without internet connectivity. Permit
cleartext only for loopback using the native guide's network-security config;
do not enable application-wide cleartext. The style has no remote TileJSON,
glyphs, sprites or online fallback. Leave MapLibre network handling enabled for
the local tile socket. iOS can use the same injected map-source contract but no
iOS MBTiles host is implemented here.

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
import { open } from '@op-engineering/op-sqlite';
import { OpSqliteDatabase } from '../src/features/dtn';
import { LocationService, SqliteLocationRepository } from '../src/features/maps';
import { createReactNativeLocationSource, createReactNativeOfflineMapSource }
  from '../src/features/maps/infrastructure/reactNative';
import { PalMeshMapsApp } from '../src/features/maps/ui';

declare const node: ReturnType<typeof import('../src/features/mesh').createMeshNode>;
const connection = open({ name: 'palmesh-locations.sqlite' });
const locations = new LocationService({
  engine: node.engine,
  repository: new SqliteLocationRepository(new OpSqliteDatabase(connection, {
    exclusiveConnection: true,
  })),
  source: createReactNativeLocationSource(),
  mapSource: createReactNativeOfflineMapSource({
    assetName: 'palmesh/palestine.mbtiles',
    // expectedSha256: '<trusted 64-character hex digest>',
  }),
});

// Start node in the native host bootstrap before mounting the screen.
await node.start();
function MapsRoute({ isFocused }: { readonly isFocused: boolean }) {
  return <PalMeshMapsApp service={locations} visible={isFocused} />;
}
```

Keep one service/provider and one native map-source owner per runtime. The
provider starts/stops feature subscriptions and its local tile host, never the
DTN engine, radios or host-owned database. At runtime disposal, unmount the
screen, await `locations.stop()`, stop the node, then close the connection.
Use a separate dedicated SQLite handle with the synchronous adapter.

## Sharing, persistence and freshness

Sharing starts disabled on every service start. **Update GPS** stores a fix
locally; **Share location once** captures GPS and queues one broadcast with the
normal 10-hop TTL. Periodic sharing is explicit and attempts at most once per
60 seconds by default. It runs only while both the app and maps route are
visible. Hiding the route, backgrounding, stopping or disabling sharing cancels
an active GPS action. A queued routing packet cannot be recalled by switching
sharing off. The UI explains that coordinate broadcasts are currently plaintext.

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
and source IDs remain unauthenticated; a newer timestamp is not a guarantee of
accuracy. Clock correction can affect which future fixes pass the bound.

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

The Android native sources have syntax checks, not a successful Android build.
Official React Native AAR retrieval was blocked with HTTP 403 in this environment.
Physical-device map rendering, loopback policy, permissions and airplane-mode
GPS/radio interruptions remain unverified. A real approved map asset, mobile
host integration, iOS tile hosting, authentication and encryption are still
required before deployment in the intended environment.
