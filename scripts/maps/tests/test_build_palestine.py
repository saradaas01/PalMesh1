"""PBF header fixtures only; these files contain no actual geographic features."""
import datetime as dt
from pathlib import Path
import struct
import sys
import tempfile
import unittest
import zlib
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from build_palestine import osm_timestamp
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


if __name__ == '__main__':
    unittest.main()
