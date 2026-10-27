"""Exercise smoke-runner safety and native UI interpretation without a device."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock

spec = importlib.util.spec_from_file_location('palmesh_smoke', Path(__file__).resolve().parents[1] / 'smoke.py')
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


class SmokeRunnerTests(unittest.TestCase):
    def test_disabled_or_nonactionable_sos_is_not_ready(self):
        for enabled, clickable in [('false', 'true'), ('true', 'false')]:
            xml = f'<hierarchy><node content-desc="{smoke.SOS}" enabled="{enabled}" clickable="{clickable}" bounds="[0,0][20,20]"/></hierarchy>'
            self.assertIsNone(smoke.find_control(xml, smoke.SOS))

    def test_control_selection_uses_enabled_native_bounds(self):
        xml = f'<hierarchy><node text="{smoke.SOS}" enabled="false" clickable="true"/><node content-desc="{smoke.SOS}" enabled="true" clickable="true" bounds="[20,40][120,100]"/></hierarchy>'
        self.assertEqual(smoke.center(smoke.find_control(xml, smoke.SOS)), (70, 70))

    def test_accessibility_metadata_keeps_the_exact_control_label(self):
        xml = f'<hierarchy><node content-desc="{smoke.SOS}, emergency action" enabled="true" clickable="true" bounds="[0,0][20,20]"/></hierarchy>'
        self.assertIsNotNone(smoke.find_control(xml, smoke.SOS))
        self.assertIsNone(smoke.find_control(xml, 'Help'))

    def test_invisible_or_malformed_bounds_fail(self):
        for bounds in ['[0,0][0,0]', '[1,1][0,0]', 'unknown']:
            node = smoke.ET.fromstring(f'<node bounds="{bounds}"/>')
            with self.assertRaises(RuntimeError):
                smoke.center(node)

    def test_identity_is_read_only_from_public_native_text(self):
        identity = 'pm1:' + 'ab' * 32
        self.assertEqual(smoke.fingerprint(f'<hierarchy><node text="{identity}"/></hierarchy>'), identity)
        self.assertIsNone(smoke.fingerprint('<hierarchy><node text="pm1:bad"/></hierarchy>'))
        self.assertIsNone(smoke.fingerprint(f'<hierarchy><node text="{identity}a"/></hierarchy>'))

    def test_physical_serial_is_refused_before_any_adb_command(self):
        with self.assertRaisesRegex(ValueError, 'emulator serials only'):
            smoke.Smoke(Path('/sdk'), Path('/results'), 'a-physical-phone', 60)

    def test_public_chat_requires_exact_body_and_queued_metadata(self):
        xml = ('<hierarchy><node text="' + smoke.PUBLIC_TEXT + '"/>'
               '<node text="02:31 PM · Waiting to connect"/></hierarchy>')
        self.assertTrue(smoke.public_chat_visible(xml))
        self.assertFalse(smoke.public_chat_visible(xml.replace(smoke.PUBLIC_TEXT, 'Other message')))
        self.assertFalse(smoke.public_chat_visible(xml.replace('Waiting to connect', 'Saved by another phone')))
        self.assertFalse(smoke.public_chat_visible(xml.replace('Waiting to connect', 'Not Waiting to connect')))

    def test_public_warning_is_required_before_synthetic_chat_input(self):
        runner = smoke.Smoke(Path('/sdk'), Path('/results'), 'emulator-5554', 10)
        runner.tap = Mock()
        runner.command = Mock()
        def wait(predicate, _description, _name):
            # A composer without the explicit privacy warning is not accepted.
            if not predicate('<hierarchy><node text="Message"/></hierarchy>'):
                raise RuntimeError('missing public warning')
        runner.wait_ui = wait
        with self.assertRaisesRegex(RuntimeError, 'missing public warning'):
            runner.queue_public_chat()
        runner.command.assert_not_called()

    def test_queue_error_never_counts_as_success_or_reaches_history(self):
        runner = smoke.Smoke(Path('/sdk'), Path('/results'), 'emulator-5554', 10)
        runner.public_thread = Mock()
        runner.tap = Mock()
        runner.command = Mock()
        def wait(predicate, _description, _name):
            xml = '<hierarchy><node text="Could not queue this message. Your draft is kept. Please try again."/></hierarchy>'
            if not predicate(xml):
                raise RuntimeError('queue notice absent')
        runner.wait_ui = wait
        with self.assertRaisesRegex(RuntimeError, 'queue notice absent'):
            runner.queue_public_chat()
        runner.command.assert_any_call('shell', 'input', 'text', smoke.PUBLIC_TEXT)
        self.assertNotIn(unittest.mock.call('Dismiss notice'), runner.tap.call_args_list)

    def test_restart_check_requires_retained_body_and_custody(self):
        runner = smoke.Smoke(Path('/sdk'), Path('/results'), 'emulator-5554', 10)
        runner.public_thread = Mock()
        runner.wait_ui = Mock(side_effect=RuntimeError('retained chat missing'))
        with self.assertRaisesRegex(RuntimeError, 'retained chat missing'):
            runner.retained_public_chat()
        predicate = runner.wait_ui.call_args.args[0]
        self.assertFalse(predicate('<hierarchy><node text="No messages yet"/></hierarchy>'))
        runner.public_thread.assert_called_once_with('second')

    def test_avd_requires_real_official_image_and_keeps_auth_defaults(self):
        with tempfile.TemporaryDirectory() as temporary:
            sdk = Path(temporary)
            with self.assertRaisesRegex(RuntimeError, 'official API 35'):
                smoke.avd_configuration(sdk)
            image = sdk / 'system-images/android-35/default/x86_64'
            image.mkdir(parents=True)
            (image / 'system.img').touch()
            config = smoke.avd_configuration(sdk)
            self.assertIn('abi.type=x86_64\n', config)
            self.assertNotIn('auth', config)
            self.assertNotIn('watchdog', config)


if __name__ == '__main__':
    unittest.main()
