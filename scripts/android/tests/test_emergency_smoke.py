"""Scrollable geometry must come from the actual padded/native hierarchy."""
import json,sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from emergency_smoke import scroll_surface, report_control, EmergencySmoke, REPORT_ID, REPORT_BODIES
from unittest.mock import Mock,patch

def native_card(body,heading='Incoming SOS',button=True,button_bounds='[48,780][672,852]',resource_id=''):
 return f'''<node class="android.view.ViewGroup" resource-id="{resource_id}" scrollable="false" bounds="[24,500][696,950]">
 <node class="android.widget.TextView" text="{heading}" enabled="true" bounds="[48,510][672,546]"/>
 <node class="android.view.ViewGroup" scrollable="false" bounds="[48,570][672,660]">
  <node class="android.widget.TextView" text="{body}" enabled="true" bounds="[48,580][672,620]"/>
 </node>
 <node class="android.widget.TextView" text="Reported: 28 Oct 2026, 18:00 (Palestine time)" bounds="[48,670][672,706]"/>
 {('<node class="android.view.ViewGroup" content-desc="View on map" enabled="true" clickable="true" bounds="'+button_bounds+'"/>') if button else '<node class="android.widget.TextView" text="Location unavailable" bounds="[48,720][672,756]"/>'}
 </node>'''

def native_inbox(*cards):
 return '<hierarchy><node class="android.view.ViewGroup" bounds="[0,0][720,1280]"><node class="android.widget.TextView" text="SOS inbox" bounds="[24,230][696,290]"/><node class="androidx.recyclerview.widget.RecyclerView" scrollable="true" bounds="[24,480][696,1109]">'+''.join(cards)+'</node></node></hierarchy>'

class EmergencyScrollTests(unittest.TestCase):
 def test_view_action_is_scoped_to_the_original_report(self):
  xml='<hierarchy><node resource-id="sos-entry-outgoing"><node content-desc="View on map" enabled="true" clickable="true" bounds="[0,100][100,150]"/></node><node resource-id="org.palmesh.emergencytest:id/sos-entry-incoming"><node content-desc="View on map" enabled="true" clickable="true" bounds="[0,200][100,250]"/></node><node resource-id="sos-entry-no-fix"/></hierarchy>'
  self.assertEqual(report_control(xml,'incoming','View on map').get('bounds'),'[0,200][100,250]')
  self.assertIsNone(report_control(xml,'no-fix','View on map'))
  self.assertIsNone(report_control(xml,'missing','View on map'))

 def test_unique_fixture_body_finds_its_card_when_native_test_id_is_absent(self):
  target=native_card(REPORT_BODIES[REPORT_ID])
  xml=native_inbox(native_card('I need help','Your SOS',button_bounds='[48,510][672,582]'),native_card('SIMULATED SOS no location',button=False),target,native_card('SIMULATED SOS old location',button_bounds='[48,900][672,972]'))
  self.assertEqual(report_control(xml,REPORT_ID,'View on map').get('bounds'),'[48,780][672,852]')
  self.assertIsNone(report_control(xml,'not-a-known-fixture','View on map'))

 def test_missing_location_never_borrows_outgoing_or_other_incoming_action(self):
  missing_id='80333333-3333-4333-8333-333333333333'
  xml=native_inbox(native_card('I need help','Your SOS'),native_card(REPORT_BODIES[missing_id],button=False),native_card(REPORT_BODIES[REPORT_ID]))
  self.assertIsNone(report_control(xml,missing_id,'View on map'))

 def test_fallback_refuses_duplicate_bodies_and_a_wrapper_with_two_report_boundaries(self):
  card=native_card(REPORT_BODIES[REPORT_ID])
  self.assertIsNone(report_control(native_inbox(card,card),REPORT_ID,'View on map'))
  # A flattened target without its own button must not ascend into a sibling.
  target='<node class="android.view.ViewGroup"><node text="SIMULATED SOS new location" bounds="[48,600][672,640]"/></node>'
  wrapper='<node class="android.view.ViewGroup">'+target+native_card('I need help','Your SOS')+'</node>'
  self.assertIsNone(report_control(native_inbox(wrapper),REPORT_ID,'View on map'))
  combined='<node class="android.view.ViewGroup"><node text="Incoming SOS"/>'+target+native_card('Another incoming report')+'</node>'
  self.assertIsNone(report_control(native_inbox(combined),REPORT_ID,'View on map'))
  # Even a clipped heading must not let a no-location card borrow a sibling action.
  missing='<node class="android.view.ViewGroup">'+target+'<node text="Location unavailable"/></node>'
  outgoing='<node class="android.view.ViewGroup"><node content-desc="View on map" enabled="true" clickable="true" bounds="[48,780][672,852]"/></node>'
  self.assertIsNone(report_control(native_inbox('<node class="android.view.ViewGroup">'+missing+outgoing+'</node>'),REPORT_ID,'View on map'))

 def test_clipped_target_button_never_substitutes_a_visible_other_report(self):
  outgoing=native_card('I need help','Your SOS')
  for bounds in ('[48,1109][672,1109]','[48,1120][672,1192]'):
   xml=native_inbox(outgoing,native_card(REPORT_BODIES[REPORT_ID],button_bounds=bounds))
   self.assertIsNone(report_control(xml,REPORT_ID,'View on map'))
  xml=native_inbox(outgoing,native_card(REPORT_BODIES[REPORT_ID],button_bounds='[48,1000][672,1072]'))
  self.assertEqual(report_control(xml,REPORT_ID,'View on map').get('bounds'),'[48,1000][672,1072]')

 def test_restart_text_validation_scrolls_until_the_original_body_is_visible(self):
  clipped=native_inbox('<node text="SIMULATED SOS new location" bounds="[48,1150][672,1190]"/>')
  visible=native_inbox('<node text="SIMULATED SOS new location" bounds="[48,600][672,640]"/>')
  harness=object.__new__(EmergencySmoke);harness.dump=Mock(side_effect=[clipped,visible]);harness.command=Mock()
  harness.show_report_text(REPORT_ID,'retained-sos-focus.xml')
  self.assertEqual(harness.command.call_count,1)
  self.assertEqual(harness.command.call_args.args[:4],('shell','input','swipe','690'))

 def test_restart_text_validation_is_bounded(self):
  xml=native_inbox('<node text="SIMULATED SOS old location" bounds="[48,600][672,640]"/>')
  harness=object.__new__(EmergencySmoke);harness.dump=Mock(return_value=xml);harness.command=Mock()
  with self.assertRaisesRegex(RuntimeError,'Original SOS text not visible'):
   harness.show_report_text(REPORT_ID,'retained-sos-focus.xml')
  self.assertEqual(harness.command.call_count,18)

 def test_report_action_search_uses_small_slow_bounded_scroll_steps(self):
  clipped=native_inbox(native_card(REPORT_BODIES[REPORT_ID],button_bounds='[48,1120][672,1192]'))
  visible=native_inbox(native_card(REPORT_BODIES[REPORT_ID],button_bounds='[48,970][672,1042]'))
  harness=object.__new__(EmergencySmoke);harness.dump=Mock(side_effect=[clipped,visible]);harness.command=Mock()
  with patch('builtins.print'):harness.press_report(REPORT_ID,'View on map')
  swipe=harness.command.call_args_list[0].args
  self.assertEqual(swipe,('shell','input','swipe','690','1064','690','964','2000'))
  self.assertLessEqual(abs(int(swipe[4])-int(swipe[6]))/(int(swipe[7])/1000),50)
  self.assertEqual(harness.command.call_args_list[1].args[:3],('shell','input','tap'))
  harness.dump=Mock(return_value=clipped);harness.command=Mock()
  with patch('builtins.print'),self.assertRaisesRegex(RuntimeError,'Original SOS control missing'):
   harness.press_report(REPORT_ID,'View on map')
  self.assertEqual(harness.command.call_count,36)

 def test_report_search_logs_card_ids_and_target_button_bounds_without_xml(self):
  target=native_card(REPORT_BODIES[REPORT_ID],resource_id='org.palmesh.emergencytest:id/sos-entry-'+REPORT_ID)
  outgoing=native_card('I need help','Your SOS',resource_id='sos-entry-outgoing')
  harness=object.__new__(EmergencySmoke);harness.dump=Mock(return_value=native_inbox(outgoing,target));harness.command=Mock()
  with patch('builtins.print') as output:harness.press_report(REPORT_ID,'View on map')
  message=output.call_args.args[0];evidence=json.loads(message.removeprefix('EMERGENCY_REPORT_SEARCH '))
  self.assertEqual(evidence['attempt'],1)
  self.assertEqual([n['id'] for n in evidence['cards']],['sos-entry-outgoing','sos-entry-'+REPORT_ID])
  self.assertEqual(evidence['targetButtons'],[{'label':'View on map','bounds':'[48,780][672,852]','enabled':'true'}])
  self.assertNotIn('<node',message);self.assertNotIn(REPORT_BODIES[REPORT_ID],message)

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
