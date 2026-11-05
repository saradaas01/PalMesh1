#!/usr/bin/env python3
"""Strict, dependency-free checks shared by map build and release packaging.

These checks validate an artifact, not whether the map reflects conditions on
the ground. Missing or out-of-date OSM features must never imply a safe route.
"""
from __future__ import annotations
import datetime as dt
import gzip
import hashlib
import io
import json
import math
from pathlib import Path
import re
import sqlite3
import urllib.parse

MAX_TILE_BYTES = 1024 * 1024
MAX_DECODED_BYTES = 4 * MAX_TILE_BYTES
# The bundled offline region: a rectangle covering all of Jordan, from the
# Gulf of Aqaba to the Syrian border and from the Jordan Valley to Iraq.
MAP_FILE = 'jordan.mbtiles'
MAP_MANIFEST = 'jordan.manifest.json'
MAP_BOUNDS = (34.85, 29.10, 39.35, 33.45)
# A generated pack must have street-level detail at each of these cities.
COVERAGE_POINTS = {
    "Amman": (35.93, 31.95), "Zarqa": (36.09, 32.07),
    "Irbid": (35.85, 32.55), "Aqaba": (35.01, 29.53),
    "Mafraq": (36.21, 32.34), "Madaba": (35.79, 31.72),
    "Karak": (35.70, 31.18), "Ma'an": (35.73, 30.19),
    "Jerash": (35.90, 32.28), "Salt": (35.73, 32.04),
}
# These sample the demonstration area, independently of country-wide coverage.
# Names describe sample areas, not a promise that a particular OSM feature exists.
AQABA_COVERAGE_POINTS = {
    'Central Aqaba': (35.006, 29.531),
    'Fort and waterfront area': (35.006, 29.526),
    'Northern Aqaba': (35.016, 29.550),
    'Eastern Aqaba': (35.030, 29.535),
}
# Require built detail at the urban samples. Surrounding coverage is still
# inspected and reported verbatim; genuine sparse tiles need not invent buildings.
AQABA_URBAN_SAMPLES = frozenset({'Central Aqaba', 'Fort and waterfront area', 'Northern Aqaba'})


def data_timestamp(value: object) -> dt.datetime:
    """Require an explicit UTC source timestamp, never substitute build time."""
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|\+00:00)', value):
        raise ValueError('Map data timestamp must be an actual past UTC timestamp')
    timestamp = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    if timestamp > dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=5):
        raise ValueError('Map data timestamp must be an actual past UTC timestamp')
    return timestamp


def provenance_url(value: object) -> str:
    if not isinstance(value, str):
        raise ValueError('A public HTTPS source URL is required')
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username is not None or parsed.password is not None or parsed.query or parsed.fragment or re.search(r'[\x00-\x20\x7f]', value):
        raise ValueError('A public HTTPS source URL without credentials or query tokens is required')
    return value


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def varint(data: bytes, offset: int) -> tuple[int, int]:
    result = 0
    for shift in range(0, 70, 7):
        if offset >= len(data):
            raise ValueError('Truncated protobuf integer')
        value = data[offset]
        offset += 1
        result |= (value & 127) << shift
        if value < 128:
            return result, offset
    raise ValueError('Oversized protobuf integer')


def fields(data: bytes):
    offset = 0
    while offset < len(data):
        tag, offset = varint(data, offset)
        number, wire = tag >> 3, tag & 7
        if number == 0:
            raise ValueError('Invalid protobuf field')
        if wire == 0:
            value, offset = varint(data, offset)
        elif wire in (1, 5):
            end = offset + (8 if wire == 1 else 4)
            if end > len(data):
                raise ValueError('Truncated fixed-width protobuf field')
            value, offset = data[offset:end], end
        elif wire == 2:
            size, offset = varint(data, offset)
            end = offset + size
            if end > len(data):
                raise ValueError('Truncated protobuf bytes')
            value, offset = data[offset:end], end
        else:
            raise ValueError('Unsupported protobuf wire type')
        yield number, wire, value


def decoded_tile(stored: bytes) -> bytes:
    if not 0 < len(stored) <= MAX_TILE_BYTES:
        raise ValueError('Tile exceeds native tile size limit')
    if stored.startswith(b'\x1f\x8b'):
        with gzip.GzipFile(fileobj=io.BytesIO(stored)) as compressed:
            decoded = compressed.read(MAX_DECODED_BYTES + 1)
    else:
        decoded = stored
    if len(decoded) > MAX_DECODED_BYTES:
        raise ValueError('Decompressed vector tile exceeds native limit')
    return decoded


def tile_layers(stored: bytes) -> dict[str, dict[str, object]]:
    decoded = decoded_tile(stored)
    layers = {}
    for number, wire, value in fields(decoded):
        if number != 3 or wire != 2:
            raise ValueError('Vector tile contains a non-layer top-level field')
        name, keys, features, version = None, [], 0, None
        for field, kind, item in fields(value):
            if field == 1 and kind == 2:
                name = item.decode('utf-8')
            elif field == 2 and kind == 2:
                features += 1
            elif field == 3 and kind == 2:
                keys.append(item.decode('utf-8'))
            elif field == 15 and kind == 0:
                version = item
        if name is None or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_-]{0,127}', name) or name in layers:
            raise ValueError('Invalid or repeated vector layer name')
        if version not in (1, 2):
            raise ValueError('Unsupported vector tile version')
        layers[name] = {'features': features, 'keys': keys}
    if not layers:
        raise ValueError('Vector tile has no layers')
    return layers


def xyz_tile(longitude: float, latitude: float, zoom: int) -> tuple[int, int]:
    count = 1 << zoom
    column = math.floor((longitude + 180) / 360 * count)
    xyz_row = math.floor((1 - math.asinh(math.tan(math.radians(latitude))) / math.pi) / 2 * count)
    return column, count - 1 - xyz_row  # MBTiles uses TMS rows.


def named_feature_counts(stored: bytes) -> dict[str, tuple[int, int]]:
    """Count actual nonempty name tags, rather than just layer key declarations."""
    result = {}
    for number, wire, layer in fields(decoded_tile(stored)):
        if number != 3 or wire != 2:
            raise ValueError('Vector tile contains a non-layer top-level field')
        name, keys, values, features = None, [], [], []
        for number, wire, value in fields(layer):
            if number == 1 and wire == 2:
                name = value.decode('utf-8')
            elif number == 2 and wire == 2:
                features.append(value)
            elif number == 3 and wire == 2:
                keys.append(value.decode('utf-8'))
            elif number == 4 and wire == 2:
                strings = [item.decode('utf-8') for field, kind, item in fields(value) if field == 1 and kind == 2]
                values.append(strings[0] if strings else None)
        named, arabic = 0, 0
        for feature in features:
            names = {}
            for number, wire, packed in fields(feature):
                if number != 2 or wire != 2:
                    continue
                tags, offset = [], 0
                while offset < len(packed):
                    tag, offset = varint(packed, offset)
                    tags.append(tag)
                if len(tags) % 2:
                    raise ValueError('Invalid feature name tags')
                for index in range(0, len(tags), 2):
                    key, value = tags[index:index + 2]
                    if key >= len(keys) or value >= len(values):
                        raise ValueError('Invalid feature name tag index')
                    if keys[key] in ('name', 'name:ar', 'name:en', 'name:latin') and values[value]:
                        names[keys[key]] = values[value]
            named += bool(names)
            arabic += bool(re.search(r'[\u0600-\u06ff]', names.get('name:ar', '')))
        result[name] = (named, arabic)
    return result


def aqaba_coverage(db: sqlite3.Connection, zoom: int) -> dict:
    """Require urban street/building detail and report surrounding coverage honestly."""
    if zoom < 14:
        raise ValueError('Aqaba streets/buildings require detailed zoom 14 or greater')
    samples, landmarks, arabic_names = {}, 0, 0
    for place, (lon, lat) in AQABA_COVERAGE_POINTS.items():
        column, row = xyz_tile(lon, lat, zoom)
        tile = db.execute('SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=? LIMIT 1',
                          (zoom, column, row)).fetchone()
        if tile is None:
            raise ValueError('No detailed map coverage at ' + place)
        layers = tile_layers(tile[0])
        roads = sum(int(details['features']) for name, details in layers.items() if re.search('road|transport|street', name, re.I))
        buildings = sum(int(details['features']) for name, details in layers.items() if 'building' in name.lower())
        names = named_feature_counts(tile[0])
        named = sum(count for count, _ in names.values())
        arabic = sum(count for _, count in names.values())
        local_landmarks = sum(count for name, (count, _) in names.items() if re.search('poi|place', name, re.I))
        urban = place in AQABA_URBAN_SAMPLES
        if urban and (not roads or not buildings):
            raise ValueError(f'Aqaba sample lacks street/building detail: {place} (streets={roads}, buildings={buildings})')
        samples[place] = {'longitude': lon, 'latitude': lat, 'zoom': zoom,
                          'streetFeatures': roads, 'buildingFeatures': buildings,
                          'tileColumn': column, 'tileRowTms': row, 'urbanDetailRequired': urban,
                          'sparseBuiltDetail': not roads or not buildings,
                          'namedFeatures': named, 'arabicNamedFeatures': arabic,
                          'namedPlaceOrPoiFeatures': local_landmarks}
        landmarks += local_landmarks
        arabic_names += arabic
    if not landmarks or not arabic_names:
        raise ValueError('Aqaba coverage must include named places/POIs and Arabic names')
    return samples


def validate(path: Path, expected_sha256: str, require_region: bool = True) -> dict:
    if not re.fullmatch(r'[a-f0-9]{64}', expected_sha256):
        raise ValueError('A trusted lowercase SHA-256 digest is required')
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 8 * 1024**3:
        raise ValueError('Map must be a regular MBTiles file of at most 8 GiB')
    for suffix in ('-wal', '-shm', '-journal'):
        if Path(str(path) + suffix).exists():
            raise ValueError('Checkpoint and close SQLite before packaging; sidecar present: ' + suffix)
    digest = sha256(path)
    if digest != expected_sha256:
        raise ValueError('MBTiles SHA-256 mismatch')
    uri = 'file:' + urllib.parse.quote(str(path.resolve()), safe='/') + '?mode=ro&immutable=1'
    with sqlite3.connect(uri, uri=True) as db:
        if db.execute('PRAGMA quick_check').fetchall() != [('ok',)]:
            raise ValueError('SQLite integrity check failed')
        rows = db.execute('SELECT name,value FROM metadata LIMIT 257').fetchall()
        metadata = dict(rows)
        if len(rows) > 256 or len(metadata) != len(rows) or any(not isinstance(k, str) or not isinstance(v, str) or len(k) > 128 or len(v) > 262144 for k, v in rows):
            raise ValueError('Invalid MBTiles metadata')
        if metadata.get('format') != 'pbf' or metadata.get('scheme', 'tms') != 'tms':
            raise ValueError('PBF vector tiles with TMS rows are required')
        lower, upper = int(metadata['minzoom']), int(metadata['maxzoom'])
        if not 0 <= lower <= upper <= 22 or (require_region and upper < 14):
            raise ValueError('Street/building data requires a maximum zoom of at least 14')
        bounds = tuple(float(value) for value in metadata['bounds'].split(','))
        if len(bounds) != 4 or not all(math.isfinite(v) for v in bounds) or not -180 <= bounds[0] < bounds[2] <= 180 or not -85.051129 <= bounds[1] < bounds[3] <= 85.051129:
            raise ValueError('Invalid map bounds')
        if require_region and not (bounds[0] <= 34.95 and bounds[1] <= 29.18 and bounds[2] >= 39.30 and bounds[3] >= 33.37):
            raise ValueError('Map bounds do not cover Jordan')
        descriptor = json.loads(metadata['json'])
        source_layers = descriptor.get('vector_layers') if isinstance(descriptor, dict) else None
        if not isinstance(source_layers, list) or not 0 < len(source_layers) <= 128:
            raise ValueError('Invalid vector-layer metadata')
        names = [layer.get('id') if isinstance(layer, dict) else None for layer in source_layers]
        if any(not isinstance(name, str) or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_-]{0,127}', name) for name in names) or len(set(names)) != len(names):
            raise ValueError('Invalid vector-layer metadata')
        attribution = metadata.get('attribution', '')
        if not attribution.strip() or len(attribution) > 1024 or re.search(r'[<>\x00-\x1f\x7f]', attribution):
            raise ValueError('Plain-text map attribution of at most 1024 characters is required')
        counts, layer_features, arabic_attributes = {}, {}, False
        previous = None
        for zoom, column, row, stored in db.execute('SELECT zoom_level,tile_column,tile_row,tile_data FROM tiles ORDER BY zoom_level,tile_column,tile_row'):
            if not all(isinstance(value, int) for value in (zoom, column, row)) or not lower <= zoom <= upper or not 0 <= column < 1 << zoom or not 0 <= row < 1 << zoom:
                raise ValueError('Tile has coordinates outside its declared zoom range')
            key = zoom, column, row
            if key == previous:
                raise ValueError('Repeated tile coordinate')
            previous = key
            if not isinstance(stored, bytes):
                raise ValueError('Tile data must be a SQLite blob')
            for name, details in tile_layers(stored).items():
                if name not in names:
                    raise ValueError('Tile layer absent from metadata: ' + name)
                layer_features[name] = layer_features.get(name, 0) + details['features']
                arabic_attributes |= 'name:ar' in details['keys']
            counts[str(zoom)] = counts.get(str(zoom), 0) + 1
        if not counts or str(lower) not in counts or str(upper) not in counts:
            raise ValueError('Map is empty or declared zoom endpoints are absent')
        local_coverage = None
        if require_region:
            if not any(re.search('road|transport|street', n, re.I) and c for n, c in layer_features.items()) or not any('building' in n.lower() and c for n, c in layer_features.items()):
                raise ValueError('Map must contain streets and buildings')
            if not arabic_attributes:
                raise ValueError('Arabic name attributes are absent')
            for place, (lon, lat) in COVERAGE_POINTS.items():
                column, row = xyz_tile(lon, lat, upper)
                tile = db.execute('SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=? LIMIT 1', (upper, column, row)).fetchone()
                if tile is None or not any(d['features'] for d in tile_layers(tile[0]).values()):
                    raise ValueError('No detailed map coverage at ' + place)
            local_coverage = aqaba_coverage(db, upper)
        # Native tile lookups must use an index, including normalized MBTiles views.
        query_plan = ' '.join(str(part) for row in db.execute('EXPLAIN QUERY PLAN SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=? LIMIT 1', (upper, 0, 0)) for part in row)
        if 'SEARCH' not in query_plan.upper():
            raise ValueError('Tile coordinate lookup lacks an index')
        report = {'sha256': digest, 'bytes': path.stat().st_size, 'bounds': list(bounds), 'minZoom': lower, 'maxZoom': upper,
                'sourceLayers': names, 'tilesByZoom': counts, 'layerFeatureOccurrences': layer_features,
                'hasArabicNames': arabic_attributes, 'attribution': metadata['attribution']}
        if 'osm_data_timestamp' in metadata:
            data_timestamp(metadata['osm_data_timestamp'])
            report['dataTimestamp'] = metadata['osm_data_timestamp']
        if local_coverage is not None:
            report['aqabaCoverage'] = local_coverage
        return report


def checked_manifest(path: Path, mbtiles: Path) -> dict:
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 262144:
        raise ValueError('Map manifest must be a regular JSON file of at most 256 KiB')
    manifest = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(manifest, dict) or manifest.get('schemaVersion') != 1 or manifest.get('file') != MAP_FILE:
        raise ValueError('Unsupported map manifest')
    data_timestamp(manifest.get('dataTimestamp'))
    provenance_url(manifest.get('sourceUrl'))
    if manifest.get('license') != 'ODbL-1.0' or manifest.get('licenseUrl') != 'https://opendatacommons.org/licenses/odbl/1-0/':
        raise ValueError('OSM map provenance and ODbL license are required')
    for key in ('sourceSha256', 'generatorSha256', 'configurationSha256', 'profileSha256'):
        if not isinstance(manifest.get(key), str) or not re.fullmatch(r'[a-f0-9]{64}', manifest[key]):
            raise ValueError('Map provenance digest is required: ' + key)
    report = validate(mbtiles, manifest['sha256'])
    for key in ('bytes', 'bounds', 'minZoom', 'maxZoom', 'sourceLayers', 'attribution', 'dataTimestamp'):
        if manifest.get(key) != report.get(key):
            raise ValueError('Manifest disagrees with MBTiles: ' + key)
    return manifest
