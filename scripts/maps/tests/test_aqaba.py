"""Small synthetic MVT fixtures exercise checks; they are never packaged maps."""
from pathlib import Path
import sqlite3
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from mbtiles import AQABA_COVERAGE_POINTS, aqaba_coverage, named_feature_counts, xyz_tile


def vi(value):
    result = bytearray()
    while value > 127:
        result.append((value & 127) | 128)
        value >>= 7
    result.append(value)
    return bytes(result)


def item(number, value):
    return vi(number << 3 | 2) + vi(len(value)) + value


def layer(name, named=False, arabic=True, tags=None):
    label = 'العقبة' if arabic else 'Aqaba'
    key = 'name:ar' if arabic else 'name:en'
    feature = vi(3 << 3) + vi(1) + item(4, b'\x09\x00\x00')
    if named:
        feature += item(2, vi(0) + vi(0) if tags is None else tags)
    return item(3, item(1, name.encode()) + item(2, feature)
                + item(3, key.encode()) + item(4, item(1, label.encode())) + vi(15 << 3) + vi(2))


def tile(*, roads=True, buildings=True, landmark=True, named=True, arabic=True):
    return (layer('transportation', named, arabic) if roads else b'') \
        + (layer('building') if buildings else b'') \
        + (layer('poi', named, arabic) if landmark else b'')


class AqabaCoverageTest(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.addCleanup(self.db.close)
        self.db.execute('CREATE TABLE tiles(zoom_level INTEGER,tile_column INTEGER,tile_row INTEGER,tile_data BLOB, UNIQUE(zoom_level,tile_column,tile_row))')
        for lon, lat in AQABA_COVERAGE_POINTS.values():
            x, y = xyz_tile(lon, lat, 14)
            self.db.execute('INSERT OR IGNORE INTO tiles VALUES(14,?,?,?)', (x, y, tile()))

    def test_detailed_streets_buildings_and_real_name_tags_are_reported_per_area(self):
        report = aqaba_coverage(self.db, 14)
        self.assertEqual(set(report), set(AQABA_COVERAGE_POINTS))
        for sample in report.values():
            self.assertEqual(sample['zoom'], 14)
            self.assertEqual(sample['streetFeatures'], 1)
            self.assertEqual(sample['buildingFeatures'], 1)
            self.assertEqual(sample['namedPlaceOrPoiFeatures'], 1)
            self.assertEqual(sample['arabicNamedFeatures'], 2)

    def test_empty_named_key_declarations_do_not_pass_as_landmarks(self):
        self.db.execute('UPDATE tiles SET tile_data=?', (tile(named=False),))
        with self.assertRaisesRegex(ValueError, 'named places/POIs'):
            aqaba_coverage(self.db, 14)

    def test_road_labels_alone_are_not_landmark_coverage(self):
        self.db.execute('UPDATE tiles SET tile_data=?', (tile(landmark=False),))
        with self.assertRaisesRegex(ValueError, 'named places/POIs'):
            aqaba_coverage(self.db, 14)

    def test_missing_local_streets_or_buildings_fail_even_if_the_tile_is_nonempty(self):
        for details in ({'roads': False}, {'buildings': False}):
            with self.subTest(details=details):
                self.db.execute('UPDATE tiles SET tile_data=?', (tile(**details),))
                with self.assertRaisesRegex(ValueError, 'street/building detail'):
                    aqaba_coverage(self.db, 14)

    def test_missing_detailed_tile_and_insufficient_zoom_fail(self):
        with self.assertRaisesRegex(ValueError, 'zoom 14'):
            aqaba_coverage(self.db, 13)
        self.db.execute('DELETE FROM tiles')
        with self.assertRaisesRegex(ValueError, 'No detailed map coverage'):
            aqaba_coverage(self.db, 14)

    def test_arabic_names_are_checked_near_aqaba_not_only_elsewhere_in_jordan(self):
        self.db.execute('UPDATE tiles SET tile_data=?', (tile(arabic=False),))
        with self.assertRaisesRegex(ValueError, 'Arabic names'):
            aqaba_coverage(self.db, 14)

    def test_malformed_name_tag_indices_are_rejected(self):
        for tags in (vi(0), vi(1) + vi(0), vi(0) + vi(1)):
            with self.subTest(tags=tags), self.assertRaisesRegex(ValueError, 'feature name tag'):
                named_feature_counts(layer('poi', named=True, tags=tags))


if __name__ == '__main__':
    unittest.main()
