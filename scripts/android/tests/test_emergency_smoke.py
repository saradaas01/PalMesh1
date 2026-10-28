"""Scrollable geometry must come from the actual padded/native hierarchy."""
import sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from emergency_smoke import scroll_surface, report_control, EmergencySmoke
from unittest.mock import Mock
class EmergencyScrollTests(unittest.TestCase):
 def test_view_action_is_scoped_to_the_original_report(self):
  xml='<hierarchy><node resource-id="sos-entry-outgoing"><node content-desc="View on map" enabled="true" clickable="true" bounds="[0,100][100,150]"/></node><node resource-id="org.palmesh.emergencytest:id/sos-entry-incoming"><node content-desc="View on map" enabled="true" clickable="true" bounds="[0,200][100,250]"/></node><node resource-id="sos-entry-no-fix"/></hierarchy>'
  self.assertEqual(report_control(xml,'incoming','View on map').get('bounds'),'[0,200][100,250]')
  self.assertIsNone(report_control(xml,'no-fix','View on map'))
  self.assertIsNone(report_control(xml,'missing','View on map'))

 def test_inbox_padding_and_map_margin_are_respected(self):
  for left,right in [(24,696),(0,720)]:
   xml=f'<hierarchy><node scrollable="true" bounds="[{left},480][{right},1109]"/><node scrollable="true" bounds="[24,900][696,1050]"/></hierarchy>'
   area=scroll_surface(xml);self.assertEqual(area,(left,480,right,1109));self.assertGreater(area[2]-6,left);self.assertLess(area[2]-6,right)

 def test_guide_waits_for_the_child_before_skipping(self):
  harness=object.__new__(EmergencySmoke);harness.wait_ui=Mock(return_value='');harness.command=Mock();harness.finish_guide('first')
  self.assertFalse(harness.skip_onboarding);self.assertEqual(harness.wait_ui.call_count,2)
  predicate=harness.wait_ui.call_args_list[0].args[0]
  self.assertFalse(predicate('<hierarchy><node content-desc="Contacts" enabled="true" clickable="true"/></hierarchy>'))
  self.assertTrue(predicate('<hierarchy><node content-desc="Skip for now" enabled="true" clickable="true" bounds="[0,0][100,100]"/></hierarchy>'))
  complete=harness.wait_ui.call_args_list[1].args[0]
  for _ in range(8):self.assertFalse(complete('<hierarchy><node content-desc="Skip for now" enabled="true" clickable="true" bounds="[0,0][100,100]"/></hierarchy>'))
  self.assertEqual(harness.command.call_count,6)
  self.assertTrue(complete('<hierarchy><node content-desc="Contacts" enabled="true" clickable="true"/></hierarchy>'))
