# Palestine offline map packs

**No Palestine MBTiles dataset is currently included.** The app displays the
unavailable state until a real, validated map is bundled. The source glyph atlas
under `assets/map-fonts` is included; fonts alone do not supply a map.

The cloud proxy currently rejects the official `download.geofabrik.de` source
with HTTP CONNECT 403. Publishing network settings that permit that domain, or
providing an authentic extract plus its independently trusted SHA-256, is
required before generating the map. Do not substitute test fixtures or scraped
public map tiles.

## Generate from OpenStreetMap

Use Python 3.10+ and upstream [tilemaker 3.2.x](https://github.com/systemed/tilemaker/releases/tag/v3.2.0)
on the build machine. Obtain or build the executable from that official release
and provide its path. PalMesh checks the executable's reported version and
records its SHA-256; this does not authenticate an arbitrary binary supplied by
someone else. Follow tilemaker's build instructions for your operating system.

With permitted access to Geofabrik:

```sh
python3 scripts/maps/build_palestine.py --download --tilemaker /path/to/tilemaker
```

With an authentic local Geofabrik PBF whose SHA-256 was independently obtained:

```sh
python3 scripts/maps/build_palestine.py \
  --source /path/to/israel-and-palestine.osm.pbf \
  --source-sha256 "$PALMESH_SOURCE_SHA256" \
  --source-url https://download.geofabrik.de/asia/israel-and-palestine-latest.osm.pbf \
  --tilemaker /path/to/tilemaker
```

The download command checks Geofabrik's published MD5 over HTTPS for transfer
corruption and records SHA-256 locally. MD5 is not an authenticity signature.
Both workflows require a real PBF replication timestamp, retained as the source
data date. Build time is never presented as source freshness.

The profile clips to `34.15,31.15,35.65,32.65`, covering Gaza and the West Bank,
and emits zooms 6–14. It includes roads, buildings, place names, water, land use
and selected points of interest, with Arabic names retained. The default
configuration fetches no remote shapefiles. It cannot establish current road
access or operating facilities.

Successful generation produces `palestine.mbtiles` and
`palestine.manifest.json`. Validation scans every tile, checks the database
index and declared layers, and requires detailed coverage at Gaza City, Rafah,
Khan Younis, Ramallah, Nablus, Hebron, Jenin, Jericho and Tulkarm. Bounds alone
are insufficient. These structural checks do not certify map accuracy.

## Verify and package

```sh
python3 -m unittest discover -s scripts/maps/tests -v
python3 scripts/maps/package.py --fonts-only --check
python3 scripts/maps/package.py --check
python3 scripts/maps/package.py
```

Full packaging first verifies the map digest, source/build provenance, UTC
source date, attribution, tile contents and all 256 glyph pages. It stages
identical resources in:

```text
android/app/src/main/assets/palmesh/
ios/PalMesh/palmesh/
```

It includes offline ODbL/OSM notices and the glyph SIL Open Font License, then
generates `src/features/maps/infrastructure/bundledMap.ts` with the verified
map digest. `--check` verifies source artifacts without modifying those files.
`--fonts-only` explicitly avoids generating a map digest or claiming map data
exists. Each staged file is copied and checksum-checked before replacing its
destination. A map and its manifest must be shipped together; interrupted
staging must be rerun before building a release.

The source PBF and MBTiles are large generated files excluded from Git.
Preserve the manifest in Git and retain the real dataset in an approved
artifact store or offline distribution medium. A Git backup of the source
repository does not back up ignored map databases. Do not attach a generated
map to a release until its license, date, coverage and resource hashes have
been reviewed and actual offline rendering has been tested on both platforms.

## Reviewed Actions artifact

The signed Android workflow consumes an already reviewed artifact from an
Actions run in **this repository**, named `palmesh-reviewed-palestine-map`.
Preparing that artifact requires real licensed data; the release workflow never
downloads map data or substitutes a fixture. First generate/obtain the genuine
map pair, run the full checks above, review its license/source date/coverage, and
record the SHA-256 of each file through an independent operator review. Do not
derive the trusted release pins from a subsequently downloaded artifact or its
included checksum file. Use an approved artifact store/offline medium to retain
the source dataset as well as this time-limited Actions copy.

Your trusted same-repository map preparation workflow must provision the two
reviewed files into its workspace through your controlled data source. After
validation, upload **only** these exact regular files, without a containing
folder or any extra entries:

```yaml
- name: Validate the genuine reviewed map pair
  run: python3 scripts/maps/package.py --check
- uses: actions/upload-artifact@v4
  with:
    name: palmesh-reviewed-palestine-map
    path: |
      mapdata/palestine.mbtiles
      mapdata/palestine.manifest.json
    if-no-files-found: error
    compression-level: 0
    retention-days: 14
```

This is a step to add to your trusted preparation workflow after its controlled
data provisioning, not a claim that an artifact or Palestine map currently
exists. Never upload source PBFs, SQLite sidecars, signing material or extra
checksum/readme files in this named artifact. Confirm both expected files are
present; the release importer requires the exact pair. Record the producing run
ID from its GitHub Actions run URL and preserve the separately reviewed file
hashes. Artifact names alone do not establish trusted provenance, and GitHub
artifact archive digests are different from the individual file hashes.

Dispatch `release-android.yml` with the producing `map_artifact_run_id`,
`map_sha256`, `map_manifest_sha256` and release version inputs. The workflow must
first be reviewed onto the repository's default branch to support manual
dispatch. It downloads from the same repository with the existing scoped
`GITHUB_TOKEN`, checks pinned hashes before importing, and runs full map
provenance/coverage validation. If a tracked `palestine.manifest.json` already
exists it must match the reviewed artifact exactly; review a new manifest in
Git instead of overwriting it during release. Rebuild/review/re-upload and use
new pins when any approved map or manifest bytes change. Expired/deleted or
mismatching artifacts fail closed; do not broaden download access or disable
checks to proceed.

## Device validation

Build the application after staging and check that both the MBTiles database
and font/notice resources appear in the install artifact. On devices without
internet, verify Arabic labels at several zoom levels, pan between Gaza and
West Bank cities, restart, and repeat. Verify missing/corrupt map behavior and
available storage during first launch. The native host retains an extracted
copy, so budget space for the packaged asset, retained database and temporary
copy during import. Physical-device rendering and GPS checks remain required.
