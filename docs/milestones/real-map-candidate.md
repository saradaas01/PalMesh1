# Genuine Palestine map generation milestone

Official Geofabrik access succeeded on October 26, 2026. The download followed
HTTPS and matched its published transport MD5 (corruption check, not an
independent authenticity signature). Source SHA256:
`bb28f83176b77d1b58701b8e2ebe4b241d37c7871e51f2739a9a684b47c5d44f`.
The PBF HeaderBlock supplies source time `2026-10-25T21:21:21Z`.

A real run exposed 206 gzip(empty) edge tiles from tilemaker. Generation now
omits only zero-byte decoded MVT payloads in private temporary output. Nonempty
invalid protobuf/gzip and decompression bombs are never repaired or discarded.
Imported packs still reject layerless tiles and full-pack validation is unchanged.
Exclusive map/manifest publication preserves existing or racing operator files.
Tests verify empty-only filtering, corruption refusal, unchanged importer
rejection and preserving publication/rollback.

The fixed pipeline produced 4,958 nonempty tiles at zooms 6–14, all nine source
layers, Arabic attributes, streets/buildings and detailed coverage at all nine
configured cities. Exact bytes/provenance are recorded in the generated
[manifest](../verification/palestine-candidate.manifest.json). Full checked-manifest
validation passed. This is structural/provenance evidence, not operator approval,
field accuracy certification or physical rendering acceptance.

The candidate Actions workflow builds official tilemaker 3.2.0 from a pinned
source archive, uses signed Ubuntu dependency repositories, downloads genuine
OSM data, validates and publishes an explicitly candidate map artifact, packages
it and builds a bundled ARM64 debug APK. It uses no release credentials. Actual
workflow/artifact success must be verified before claiming publication.

Verification: 53 map tests, Python/YAML syntax, TypeScript/module checks, the real
pipeline and checked-manifest validation passed. No physical result is claimed.

## Legitimate alternative sources examined

- [Geofabrik regional extracts](https://download.geofabrik.de/asia/israel-and-palestine.html)
  now work here. Retain source date, URL, digests, generator/profile/config pins
  and ODbL attribution.
- [HOT Export Tool](https://export.hotosm.org/) provides custom OSM extracts under
  ODbL and requires an OSM account to create exports. No HOT extract was created,
  downloaded or validated here; format/coverage/provenance still need validation.
- [OSM export guidance](https://www.openstreetmap.org/export) lists bulk sources
  and size limits for ordinary XML exports. [BBBike official help](https://www.bbbike.org/help.html)
  describes OSM/ODbL downloads. No BBBike candidate with complete required coverage
  was obtained. Small city-only extracts cannot replace Gaza/West Bank coverage.

No network-policy, TLS, checksum or signed-package verification was bypassed.
