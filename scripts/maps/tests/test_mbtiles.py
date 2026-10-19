"""Synthetic vector tiles here are validation fixtures, never map data."""
import gzip
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from mbtiles import fields, sha256, tile_layers, validate, xyz_tile


def vi(value):
    result = bytearray()
    while value > 127:
        result.append((value & 127) | 128)
        value >>= 7
    result.append(value)
    return bytes(result)


def item(number, value):
    return vi(number << 3 | 2) + vi(len(value)) + value


def fixture_tile():
    layer = item(1, b'fixture_roads') + item(3, b'name:ar') + vi(15 << 3) + vi(2)
    return item(3, layer)


class ValidationTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / 'fixture.mbtiles'
        with sqlite3.connect(self.path) as db:
            db.executescript('CREATE TABLE metadata(name TEXT PRIMARY KEY,value TEXT); CREATE TABLE tiles(zoom_level INTEGER,tile_column INTEGER,tile_row INTEGER,tile_data BLOB); CREATE UNIQUE INDEX tile_index ON tiles(zoom_level,tile_column,tile_row);')
            metadata = {'format': 'pbf', 'scheme': 'tms', 'minzoom': '0', 'maxzoom': '0', 'bounds': '-180,-85,180,85',
                        'json': json.dumps({'vector_layers': [{'id': 'fixture_roads'}]}), 'attribution': 'Validation fixture, not map data'}
            db.executemany('INSERT INTO metadata VALUES(?,?)', metadata.items())
            db.execute('INSERT INTO tiles VALUES(0,0,0,?)', (gzip.compress(fixture_tile()),))

    def tearDown(self):
        self.directory.cleanup()

    def inspect(self):
        return validate(self.path, sha256(self.path), require_palestine=False)

    def test_valid_compressed_and_uncompressed_mvt(self):
        report = self.inspect()
        self.assertEqual(report['tilesByZoom'], {'0': 1})
        self.assertTrue(report['hasArabicNames'])
        self.assertEqual(tile_layers(fixture_tile()), tile_layers(gzip.compress(fixture_tile())))

    def test_trusted_digest_mismatch(self):
        with self.assertRaisesRegex(ValueError, 'SHA-256 mismatch'):
            validate(self.path, '0' * 64, require_palestine=False)

    def test_open_wal_is_not_packaged(self):
        Path(str(self.path) + '-wal').touch()
        with self.assertRaisesRegex(ValueError, 'sidecar'):
            self.inspect()

    def test_xyz_instead_of_tms_is_rejected(self):
        with sqlite3.connect(self.path) as db:
            db.execute("UPDATE metadata SET value='xyz' WHERE name='scheme'")
        with self.assertRaisesRegex(ValueError, 'TMS'):
            self.inspect()

    def test_bad_coordinates_are_rejected(self):
        with sqlite3.connect(self.path) as db:
            db.execute('UPDATE tiles SET tile_row=1')
        with self.assertRaisesRegex(ValueError, 'coordinates'):
            self.inspect()

    def test_gzip_bomb_is_bounded(self):
        with self.assertRaisesRegex(ValueError, 'Decompressed'):
            tile_layers(gzip.compress(b'X' * (4 * 1024 * 1024 + 1)))

    def test_unknown_tile_layer_is_rejected(self):
        with sqlite3.connect(self.path) as db:
            db.execute("UPDATE metadata SET value=? WHERE name='json'", (json.dumps({'vector_layers': [{'id': 'other'}]}),))
        with self.assertRaisesRegex(ValueError, 'absent from metadata'):
            self.inspect()

    def test_scan_without_coordinate_index_is_rejected(self):
        with sqlite3.connect(self.path) as db:
            db.execute('DROP INDEX tile_index')
        with self.assertRaisesRegex(ValueError, 'lacks an index'):
            self.inspect()

    def test_fixture_cannot_be_misrepresented_as_palestine_map(self):
        with self.assertRaisesRegex(ValueError, 'maximum zoom'):
            validate(self.path, sha256(self.path))

    def test_tms_conversion_has_south_origin(self):
        self.assertEqual(xyz_tile(0, 0, 1), (1, 0))
        self.assertEqual(xyz_tile(0, 60, 1), (1, 1))

    def test_truncated_protobuf_is_rejected(self):
        for data in (b'\x1a\x80', b'\x1a\x02\xff', b'\x00'):
            with self.assertRaises(ValueError):
                list(fields(data))


if __name__ == '__main__':
    unittest.main()
