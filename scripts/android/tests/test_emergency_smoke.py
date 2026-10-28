"""Scrollable geometry must come from the actual padded/native hierarchy."""
import sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from emergency_smoke import scroll_surface
class EmergencyScrollTests(unittest.TestCase):
 def test_inbox_padding_and_map_margin_are_respected(self):
  for left,right in [(24,696),(0,720)]:
   xml=f'<hierarchy><node scrollable="true" bounds="[{left},480][{right},1109]"/><node scrollable="true" bounds="[24,900][696,1050]"/></hierarchy>'
   area=scroll_surface(xml);self.assertEqual(area,(left,480,right,1109));self.assertGreater(area[2]-6,left);self.assertLess(area[2]-6,right)
