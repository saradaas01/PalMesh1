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
# Deliberately broad rectangular extent covering Gaza and the West Bank.
PALESTINE_BOUNDS = (34.15, 31.15, 35.65, 32.65)
COVERAGE_POINTS = {
    "Gaza City": (34.46, 31.50), "Rafah": (34.25, 31.29),
    "Khan Younis": (34.30, 31.35), "Ramallah": (35.20, 31.90),
    "Nablus": (35.26, 32.22), "Hebron": (35.10, 31.53),
    "Jenin": (35.30, 32.46), "Jericho": (35.44, 31.86),
    "Tulkarm": (35.03, 32.31),
}


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


def tile_layers(stored: bytes) -> dict[str, dict[str, object]]:
    if not 0 < len(stored) <= MAX_TILE_BYTES:
        raise ValueError('Tile exceeds native tile size limit')
    if stored.startswith(b'\x1f\x8b'):
        with gzip.GzipFile(fileobj=io.BytesIO(stored)) as compressed:
            decoded = compressed.read(MAX_DECODED_BYTES + 1)
    else:
        decoded = stored
    if len(decoded) > MAX_DECODED_BYTES:
        raise ValueError('Decompressed vector tile exceeds native limit')
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


def validate(path: Path, expected_sha256: str, require_palestine: bool = True) -> dict:
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
        if not 0 <= lower <= upper <= 22 or (require_palestine and upper < 14):
            raise ValueError('Street/building data requires a maximum zoom of at least 14')
        bounds = tuple(float(value) for value in metadata['bounds'].split(','))
        if len(bounds) != 4 or not all(math.isfinite(v) for v in bounds) or not -180 <= bounds[0] < bounds[2] <= 180 or not -85.051129 <= bounds[1] < bounds[3] <= 85.051129:
            raise ValueError('Invalid map bounds')
        if require_palestine and not (bounds[0] <= 34.21 and bounds[1] <= 31.21 and bounds[2] >= 35.58 and bounds[3] >= 32.56):
            raise ValueError('Map bounds do not cover Gaza and the West Bank')
        source_layers = json.loads(metadata['json'])['vector_layers']
        names = [layer['id'] for layer in source_layers]
        if not 0 < len(names) <= 128 or len(set(names)) != len(names) or any(not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_-]{0,127}', name) for name in names):
            raise ValueError('Invalid vector-layer metadata')
        if not metadata.get('attribution', '').strip():
            raise ValueError('Map attribution is required')
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
        if require_palestine:
            if not any(re.search('road|transport|street', n, re.I) and c for n, c in layer_features.items()) or not any('building' in n.lower() and c for n, c in layer_features.items()):
                raise ValueError('Map must contain streets and buildings')
            if not arabic_attributes:
                raise ValueError('Arabic name attributes are absent')
            for place, (lon, lat) in COVERAGE_POINTS.items():
                column, row = xyz_tile(lon, lat, upper)
                tile = db.execute('SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=? LIMIT 1', (upper, column, row)).fetchone()
                if tile is None or not any(d['features'] for d in tile_layers(tile[0]).values()):
                    raise ValueError('No detailed map coverage at ' + place)
        # Native tile lookups must use an index, including normalized MBTiles views.
        query_plan = ' '.join(str(part) for row in db.execute('EXPLAIN QUERY PLAN SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=? LIMIT 1', (upper, 0, 0)) for part in row)
        if 'SEARCH' not in query_plan.upper():
            raise ValueError('Tile coordinate lookup lacks an index')
        return {'sha256': digest, 'bytes': path.stat().st_size, 'bounds': list(bounds), 'minZoom': lower, 'maxZoom': upper,
                'sourceLayers': names, 'tilesByZoom': counts, 'layerFeatureOccurrences': layer_features,
                'hasArabicNames': arabic_attributes, 'attribution': metadata['attribution']}


def checked_manifest(path: Path, mbtiles: Path) -> dict:
    manifest = json.loads(path.read_text(encoding='utf-8'))
    if manifest.get('schemaVersion') != 1 or manifest.get('file') != 'palestine.mbtiles':
        raise ValueError('Unsupported map manifest')
    timestamp = dt.datetime.fromisoformat(manifest['dataTimestamp'].replace('Z', '+00:00'))
    if timestamp.tzinfo is None or timestamp > dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=5):
        raise ValueError('Map data timestamp must be an actual past UTC timestamp')
    if manifest.get('license') != 'ODbL-1.0' or not manifest.get('sourceUrl', '').startswith('https://'):
        raise ValueError('OSM map provenance and ODbL license are required')
    report = validate(mbtiles, manifest['sha256'])
    for key in ('bytes', 'bounds', 'minZoom', 'maxZoom', 'sourceLayers'):
        if manifest.get(key) != report[key]:
            raise ValueError('Manifest disagrees with MBTiles: ' + key)
    return manifest
