"""Regression gates for actual offline rendered-map evidence."""
from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import map_smoke


class MapSmokeTests(unittest.TestCase):
    def good(self):
        return dict(androidInternetConnected=False, loopbackOnly=True, sdkConnected=True,
                    geometry=100, roads=20, labels=10, arabicLabels=5, tileHits=4, glyphHits=8)

    def test_every_render_dimension_is_required(self):
        self.assertTrue(map_smoke.rendered_offline(self.good()))
        for field in ('geometry','roads','labels','arabicLabels','tileHits','glyphHits'):
            for value in (0, None, '1'):
                record=self.good(); record[field]=value
                self.assertFalse(map_smoke.rendered_offline(record), field)

    def test_online_or_non_loopback_results_cannot_pass_offline(self):
        for field, value in [('androidInternetConnected',True),('loopbackOnly',False),('sdkConnected',False)]:
            record=self.good(); record[field]=value
            self.assertFalse(map_smoke.rendered_offline(record))

    def test_inert_attribution_or_open_app_is_not_render_evidence(self):
        self.assertFalse(map_smoke.rendered_offline({'text':'© OpenStreetMap contributors','appOpened':True}))
        self.assertEqual(map_smoke.render_records('unrelated line\nrender_evidence broken'), [])
        self.assertEqual(map_smoke.render_records('I PalMeshOfflineMap: render_evidence {"roads":0}'), [{'roads':0}])

    def test_blank_pixels_or_ui_white_text_are_rejected(self):
        class Blank:
            width=720; height=1280
            def convert(self, mode): return self
            def crop(self, bounds): return self
            def getcolors(self, limit): return [(10000,(255,255,255)),(10000,(23,35,45))]
        with self.assertRaisesRegex(RuntimeError,'street detail'):
            map_smoke.map_pixels(Blank(), (0,100,720,500))


if __name__ == '__main__': unittest.main()
