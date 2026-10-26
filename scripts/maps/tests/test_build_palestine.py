"""PBF header fixtures only; these files contain no actual geographic features."""
import datetime as dt
from pathlib import Path
import struct
import sqlite3
import gzip
import sys
import tempfile
import unittest
import zlib
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from build_palestine import osm_timestamp, remove_empty_generated_tiles, publish_generated_pair
from mbtiles import tile_layers
from test_mbtiles import item, vi


def pbf_header(timestamp=1767225600, compressed=True):
    data = vi(32 << 3) + vi(timestamp) if timestamp is not None else b''
    blob = vi(2 << 3) + vi(len(data)) + item(3, zlib.compress(data)) if compressed else item(1, data)
    header = item(1, b'OSMHeader') + vi(3 << 3) + vi(len(blob))
    return struct.pack('>I', len(header)) + header + blob


class TimestampTest(unittest.TestCase):
    def inspect(self, data):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'header-fixture.pbf'
            path.write_bytes(data)
            return osm_timestamp(path)

    def test_data_timestamp_comes_from_source_not_build_time(self):
        for compressed in (True, False):
            with self.subTest(compressed=compressed):
                self.assertEqual(self.inspect(pbf_header(compressed=compressed)), '2026-01-01T00:00:00Z')

    def test_missing_replication_time_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'timestamp absent'):
            self.inspect(pbf_header(timestamp=None, compressed=False))

    def test_future_data_is_rejected(self):
        future = int(dt.datetime(2099, 1, 1, tzinfo=dt.timezone.utc).timestamp())
        with self.assertRaisesRegex(ValueError, 'timestamp'):
            self.inspect(pbf_header(timestamp=future))

    def test_truncated_headers_never_pass_as_source_data(self):
        data = pbf_header()
        for length in (0, 2, 4, 8, len(data) - 1):
            with self.subTest(length=length), self.assertRaises(ValueError):
                self.inspect(data[:length])

    def test_wrong_wire_type_is_rejected_as_malformed_input(self):
        header = item(1, b'OSMHeader') + item(3, b'not a length')
        with self.assertRaisesRegex(ValueError, 'HeaderBlock'):
            self.inspect(struct.pack('>I', len(header)) + header)

    def test_trailing_compressed_header_payload_is_rejected(self):
        data = vi(32 << 3) + vi(1767225600)
        blob = vi(2 << 3) + vi(len(data)) + item(3, zlib.compress(data) + b'unexpected')
        header = item(1, b'OSMHeader') + vi(3 << 3) + vi(len(blob))
        with self.assertRaisesRegex(ValueError, 'Corrupt PBF'):
            self.inspect(struct.pack('>I', len(header)) + header + blob)


class GeneratedEmptyTileTests(unittest.TestCase):
    def fixture(self, path, blobs):
        with sqlite3.connect(path) as db:
            db.execute('CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB)')
            db.executemany('INSERT INTO tiles VALUES (14, ?, 1, ?)', enumerate(blobs))

    def test_omits_only_decoded_empty_output_and_keeps_every_nonempty_byte(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'generated.mbtiles'
            nonempty = gzip.compress(b'nonempty-invalid-protobuf-is-not-repaired')
            self.fixture(path, [gzip.compress(b''), nonempty])
            self.assertEqual(remove_empty_generated_tiles(path), 1)
            with sqlite3.connect(path) as db:
                self.assertEqual(db.execute('SELECT tile_data FROM tiles').fetchall(), [(nonempty,)])
            with self.assertRaises(ValueError): tile_layers(nonempty)

    def test_malformed_gzip_fails_without_deleting_prior_empty_tiles(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'generated.mbtiles'
            self.fixture(path, [gzip.compress(b''), b'\x1f\x8bcorrupt'])
            with self.assertRaises((OSError, EOFError)): remove_empty_generated_tiles(path)
            with sqlite3.connect(path) as db:
                self.assertEqual(db.execute('SELECT COUNT(*) FROM tiles').fetchone()[0], 2)

    def test_import_validator_still_rejects_layerless_tiles(self):
        with self.assertRaisesRegex(ValueError, 'no layers'): tile_layers(gzip.compress(b''))


class PreservingPublicationTests(unittest.TestCase):
    def test_existing_map_is_never_replaced(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'generated.mbtiles'; source.write_bytes(b'new')
            output = Path(directory) / 'palestine.mbtiles'; output.write_bytes(b'operator-map')
            with self.assertRaises(FileExistsError): publish_generated_pair(source, output, {})
            self.assertEqual(output.read_bytes(), b'operator-map')

    def test_existing_manifest_rolls_back_only_our_new_map(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'generated.mbtiles'; source.write_bytes(b'new')
            output = Path(directory) / 'palestine.mbtiles'
            manifest = output.with_suffix('.manifest.json'); manifest.write_bytes(b'operator-manifest')
            with self.assertRaises(FileExistsError): publish_generated_pair(source, output, {})
            self.assertFalse(output.exists())
            self.assertEqual(manifest.read_bytes(), b'operator-manifest')

    def test_new_pair_retains_the_generated_bytes_and_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'generated.mbtiles'; source.write_bytes(b'new')
            output = Path(directory) / 'palestine.mbtiles'
            publish_generated_pair(source, output, {'candidate': True})
            self.assertEqual(output.read_bytes(), b'new')
            self.assertIn('candidate', output.with_suffix('.manifest.json').read_text())


if __name__ == '__main__':
    unittest.main()
