"""Regression for offscreen Android accessibility nodes in scrollable forms."""
import sys
from pathlib import Path
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from contacts_smoke import ContactsSmoke
class ContactControls(unittest.TestCase):
    def test_zero_bounds_and_footer_cannot_be_tapped(self):
        runner=ContactsSmoke(Path('/sdk'),Path('/tmp'),'emulator-5554',30)
        for bounds in ('[0,0][0,0]','[10,1100][700,1200]'):
            xml=f'<hierarchy><node content-desc="Name" clickable="true" enabled="true" bounds="{bounds}"/></hierarchy>'
            self.assertIsNone(runner.visible_control(xml,'Name'))
    def test_enabled_visible_form_control_is_usable(self):
        runner=ContactsSmoke(Path('/sdk'),Path('/tmp'),'emulator-5554',30)
        xml='<hierarchy><node content-desc="Name" clickable="true" enabled="true" bounds="[20,400][700,460]"/></hierarchy>'
        self.assertIsNotNone(runner.visible_control(xml,'Name'))
