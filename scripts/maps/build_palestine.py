#!/usr/bin/env python3
"""Generate a real Palestine pack from an authentic OSM PBF using tilemaker 3.2.

The input is never synthesized. Direct Geofabrik downloads retain TLS checks,
compare the vendor's published transport checksum, and record a local SHA-256.
A locally supplied extract requires an independently trusted SHA-256 argument.
"""
from __future__ import annotations
import argparse
import datetime as dt
import hashlib
import json
from pathlib import Path
import re
import shutil
import sqlite3
import struct
import subprocess
import sys
import urllib.request
import zlib
from mbtiles import fields, sha256, validate, PALESTINE_BOUNDS

ROOT = Path(__file__).resolve().parents[2]
GEOfABRIK = 'https://download.geofabrik.de/asia/israel-and-palestine-latest.osm.pbf'
ATTRIBUTION = '© OpenStreetMap contributors. Open Database License (ODbL) 1.0. https://www.openstreetmap.org/copyright'


def download(source: Path) -> None:
    source.parent.mkdir(parents=True, exist_ok=True)
    published = urllib.request.urlopen(GEOfABRIK + '.md5', timeout=60).read(1024).decode('ascii').split()[0]
    if not re.fullmatch(r'[a-fA-F0-9]{32}', published):
        raise ValueError('Malformed Geofabrik transport checksum')
    temporary = source.with_suffix(source.suffix + '.downloading')
    try:
        digest = hashlib.md5(usedforsecurity=False)
        with urllib.request.urlopen(GEOfABRIK, timeout=60) as response, temporary.open('wb') as output:
            size = 0
            for chunk in iter(lambda: response.read(1024 * 1024), b''):
                size += len(chunk)
                if size > 2 * 1024**3:
                    raise ValueError('Unexpectedly large regional OSM extract')
                digest.update(chunk)
                output.write(chunk)
        if digest.hexdigest() != published.lower():
            raise ValueError('Source transport checksum mismatch; the daily file may have changed, retry')
        temporary.replace(source)
    finally:
        temporary.unlink(missing_ok=True)


def osm_timestamp(path: Path) -> str:
    with path.open('rb') as source:
        raw_length = source.read(4)
        if len(raw_length) != 4:
            raise ValueError('Truncated OSM PBF')
        header_length = struct.unpack('>I', raw_length)[0]
        if not 0 < header_length <= 64 * 1024:
            raise ValueError('Invalid OSM PBF header length')
        header = {number: value for number, _, value in fields(source.read(header_length))}
        if header.get(1) != b'OSMHeader' or not 0 < header.get(3, 0) <= 32 * 1024 * 1024:
            raise ValueError('An OSM PBF HeaderBlock is required')
        blob = {number: value for number, _, value in fields(source.read(header[3]))}
        if 1 in blob:
            decoded = blob[1]
        elif 3 in blob:
            if not 0 < blob.get(2, 0) <= 32 * 1024 * 1024:
                raise ValueError('Invalid PBF uncompressed header size')
            decoder = zlib.decompressobj()
            decoded = decoder.decompress(blob[3], blob[2] + 1)
            if len(decoded) != blob[2] or not decoder.eof or decoder.unconsumed_tail:
                raise ValueError('Corrupt PBF compressed header')
        else:
            raise ValueError('Unsupported OSM PBF compression')
        values = {number: value for number, _, value in fields(decoded)}
        if 32 not in values:
            raise ValueError('OSM replication timestamp absent; supply a dated authentic Geofabrik extract')
        timestamp = dt.datetime.fromtimestamp(values[32], dt.timezone.utc)
        if timestamp > dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=5):
            raise ValueError('OSM data timestamp is in the future')
        return timestamp.isoformat().replace('+00:00', 'Z')


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--download', action='store_true')
    parser.add_argument('--source', type=Path, default=ROOT / 'mapdata/source/israel-and-palestine.osm.pbf')
    parser.add_argument('--source-sha256', help='Trusted digest required for a locally supplied source')
    parser.add_argument('--source-url', default=GEOfABRIK)
    parser.add_argument('--tilemaker', default='tilemaker', help='Path to upstream tilemaker 3.2.x binary')
    parser.add_argument('--output', type=Path, default=ROOT / 'mapdata/palestine.mbtiles')
    args = parser.parse_args()
    if args.download:
        download(args.source)
    elif not args.source_sha256:
        parser.error('--source-sha256 is required unless downloading directly from Geofabrik')
    source_digest = sha256(args.source)
    if args.source_sha256 is not None and source_digest != args.source_sha256:
        raise ValueError('OSM source SHA-256 mismatch')
    timestamp = osm_timestamp(args.source)
    tool = shutil.which(args.tilemaker)
    if tool is None:
        raise ValueError('Install official tilemaker 3.2.x first: https://github.com/systemed/tilemaker/releases/tag/v3.2.0')
    tool_hash = sha256(Path(tool))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_name(args.output.stem + '.building.mbtiles')
    try:
        command = [tool, '--input', str(args.source.resolve()), '--output', str(temporary.resolve()),
                   '--config', str(ROOT / 'scripts/maps/tilemaker.json'), '--process', str(ROOT / 'scripts/maps/tilemaker.lua'),
                   '--bbox', ','.join(str(v) for v in PALESTINE_BOUNDS), '--threads', '2']
        subprocess.run(command, check=True)
        with sqlite3.connect(temporary) as db:
            # MBTiles metadata is textual. This schema deliberately supplies the
            # real data timestamp, attribution and source; no fetch date is substituted.
            for name, value in [('attribution', ATTRIBUTION), ('scheme', 'tms'), ('format', 'pbf'),
                                ('bounds', ','.join(str(v) for v in PALESTINE_BOUNDS)),
                                ('osm_data_timestamp', timestamp)]:
                db.execute('DELETE FROM metadata WHERE name=?', (name,))
                db.execute('INSERT INTO metadata(name,value) VALUES(?,?)', (name, value))
            db.commit()
        digest = sha256(temporary)
        report = validate(temporary, digest)
        manifest = {'schemaVersion': 1, 'file': 'palestine.mbtiles', **report,
                    'dataTimestamp': timestamp, 'sourceUrl': args.source_url, 'sourceSha256': source_digest,
                    'license': 'ODbL-1.0', 'licenseUrl': 'https://opendatacommons.org/licenses/odbl/1-0/',
                    'generator': 'tilemaker 3.2.x', 'generatorSha256': tool_hash,
                    'configurationSha256': sha256(ROOT / 'scripts/maps/tilemaker.json'),
                    'profileSha256': sha256(ROOT / 'scripts/maps/tilemaker.lua'),
                    'limitations': 'OSM historic features, not verified current conditions. No hazard, damage or safe-route information.'}
        temporary.replace(args.output)
        manifest_path = args.output.with_suffix('.manifest.json')
        manifest_path.write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
        print('Generated validated OSM map: ' + str(args.output))
        print('Data timestamp: ' + timestamp + '; SHA-256: ' + digest)
    finally:
        temporary.unlink(missing_ok=True)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError, subprocess.CalledProcessError) as error:
        print('Map generation failed: ' + str(error), file=sys.stderr)
        sys.exit(1)
