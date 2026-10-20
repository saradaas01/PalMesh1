# PalMesh offline vector tiles (Android)

This local React Native library opens a bundled MBTiles SQLite file read-only and
serves vector tiles to MapLibre over a token-protected HTTP socket bound only to
`127.0.0.1` on an ephemeral port. It makes no public network requests. The typed,
injected adapter lives in `src/features/maps/infrastructure/NativeOfflineMapSource.ts`.
Importing the adapter does not load React Native or open a database.

## Host installation

From the native React Native host app, install this local package (adjust the
relative path to the repository):

```sh
npm install ../PalMesh1/native/palmesh-offline-maps
```

Autolinking registers `NativeModules.PalMeshOfflineMaps`. For manual registration,
add `new com.palmesh.offlinemaps.PalMeshOfflineMapsPackage()` to the host packages.
The library uses legacy-module interoperability on the New Architecture. The
host supplies Android Gradle tooling and React Native dependencies.

Place a legally distributable, independently verified Palestine vector dataset at:

```text
android/app/src/main/assets/palmesh/palestine.mbtiles
```

**No map dataset is included in this repository.** Missing assets fail cleanly;
the application can still show saved locations and send SOS. Map coverage,
freshness, detail, licensing and attribution depend on the actual dataset the
host ships. Do not substitute a live tile URL for the missing asset.

The MBTiles file must use `format=pbf`, TMS rows (the standard MBTiles scheme),
integer `minzoom` and `maxzoom` in `0..22`, comma-separated geographic `bounds`,
and `json` metadata containing a nonempty `vector_layers` array of unique `id`s.
Raster files, XYZ-row MBTiles, absent required metadata and invalid metadata are
rejected. Layer IDs allow letters, digits, underscores and hyphens, with a
letter/underscore first. The `tiles` table or view must expose the standard
`zoom_level`, `tile_column`, `tile_row` and `tile_data` columns and should have
an efficient coordinate lookup index. Ordinary indexed MBTiles and normalized
MBTiles views are supported. HTML attribution is reduced to inert plain text.

```ts
import { NativeModules } from 'react-native';
import { NativeOfflineMapSource } from './src/features/maps/infrastructure/NativeOfflineMapSource';

const maps = new NativeOfflineMapSource(NativeModules.PalMeshOfflineMaps, {
  assetName: 'palmesh/palestine.mbtiles',
  // Set this to the trusted SHA-256 of the exact bundled file (64 hex digits).
  // expectedSha256: '...actual independently verified digest...',
});
// Inject maps into LocationService. That service owns open/abort/close.
```

A digest pins file integrity only when obtained from a trusted source. When
configured, both an existing retained copy and a fresh copy are checked; a bad
retained file is replaced from the bundled asset, and a bad asset is rejected.
Without `expectedSha256`, no cryptographic integrity claim is made. The initial
copy goes to app-private no-backup storage and is atomically renamed after
completion. APK updates produce a new copy; obsolete copies are removed after
a successful replacement. Allow enough free disk space for the bundled asset
and its private copy. The individual asset limit is 8 GiB.

## Loopback HTTP policy

Android requires `INTERNET` for loopback sockets; the library manifest supplies
that permission. On Android versions that block cleartext HTTP by default, the
**host app** must allow only the loopback destination in its existing network
security configuration. Merge this domain block with the host's configuration:

```xml
<!-- android/app/src/main/res/xml/network_security_config.xml -->
<network-security-config>
    <base-config cleartextTrafficPermitted="false" />
    <domain-config cleartextTrafficPermitted="true">
        <domain includeSubdomains="false">127.0.0.1</domain>
    </domain-config>
</network-security-config>
```

```xml
<!-- Attribute on the existing host <application> element. -->
android:networkSecurityConfig="@xml/network_security_config"
```

Do not globally enable cleartext traffic to make maps work. The local socket is
HTTP rather than HTTPS, has a fresh random 128-bit path token per session, and
requires an exact loopback Host header. The token limits casual local access;
it is not isolation from malicious software running inside the same app or a
compromised device. When bundled Noto resources are present, the descriptor also
supplies a glyph URL on that same token-protected local host. No remote font,
sprite, style or tile URL is supplied; the application style must remain offline.

## Limits and lifecycle

Only one source owns the native module at a time. The TypeScript adapter settles
aborted opens promptly and serializes cleanup before restarting. Native copy
and checksum work observes cancellation between chunks. `close()` stops the
listener, closes clients, stops workers and closes SQLite; module invalidation
does the same. A map session uses two workers and a queue of 16 requests. Headers
are capped at 8 KiB, requests time out, and active tile reads/writes have a
five-second deadline with SQLite cancellation. Oversized/malformed requests
are discarded. Stored tile blobs are capped at 1 MiB (below the default Android
SQLite cursor window) and gzip decompression at 4 MiB. PBF framing is checked;
raw PBF and gzip PBF are supported, while invalid
or absent tiles return 404. XYZ request rows are flipped to TMS on each query.
The first usable tile is checked during open. The host must validate dataset
quality and avoid unindexed multi-GB SQLite scans.

The bridge interface supports an injected iOS implementation, but **this package
does not implement an iOS tile host**; absent bridges report unavailable. Java
sources have been syntax-parsed in the cloud environment. Android compilation,
MapLibre networking on the real host, bundle size/storage behavior, and physical
device rendering have not been verified here. Native SDK/Maven availability and
the actual map asset are prerequisites for those checks.

## iOS

`PalMeshOfflineMaps.podspec` supplies the same bridge on iOS using read-only SQLite and a token-protected socket bound only to `127.0.0.1`. The host preserves the `palmesh/...` asset directory in the application bundle. Its vector tile URL applies XYZ-to-TMS conversion, bounded gzip validation and socket/query deadlines. Bundled glyph ranges use the same session token. See [iOS host setup and limitations](../../docs/ios-app.md). Native compilation and rendering validation require macOS/Xcode and an actual bundled dataset.
