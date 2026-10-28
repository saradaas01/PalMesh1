"""Synthetic GPS must remain emulator-only and empty until explicit injection."""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from emergency_gps_provider import EmulatorGpsProvider, require_empty_provider


def empty_dump():
    return ''.join(
        f'{provider} provider [mock]:\n'
        '  last location=null\n'
        '  enabled=true\n'
        '  allowed=true\n'
        '  last mock location=null\n'
        for provider in ('gps', 'network')
    )


class Runner:
    def __init__(self, output, serial='emulator-5554', qemu='1', sdk='35', uids=('2000',), dump=None):
        self.output = output
        self.serial = serial
        self.qemu = qemu
        self.sdk = sdk
        self.uids = iter(uids)
        self.dump = empty_dump() if dump is None else dump
        self.calls = []

    def command(self, *args):
        self.calls.append(args)
        if args[:2] == ('shell', 'getprop'):
            return self.sdk if args[2] == 'ro.build.version.sdk' else self.qemu
        if args == ('shell', 'id', '-u'):
            return next(self.uids)
        if args == ('shell', 'dumpsys', 'location'):
            return self.dump
        return ''


class EmergencyGpsProviderTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.output = Path(temporary.name)

    def test_physical_serial_is_refused_before_any_command(self):
        runner = Runner(self.output, serial='TECNO-physical')
        with self.assertRaisesRegex(RuntimeError, 'emulator serials only'):
            EmulatorGpsProvider(runner).install()
        self.assertEqual(runner.calls, [])
        self.assertEqual(list(self.output.iterdir()), [])

    def test_emulator_serial_without_qemu_property_cannot_mutate_device(self):
        runner = Runner(self.output, qemu='0')
        with self.assertRaisesRegex(RuntimeError, 'non-emulator'):
            EmulatorGpsProvider(runner).install()
        self.assertEqual(runner.calls, [
            ('shell', 'getprop', 'ro.kernel.qemu'),
            ('shell', 'getprop', 'ro.boot.qemu'),
        ])

    def test_other_api_levels_are_refused_before_mutation(self):
        runner = Runner(self.output, sdk='34')
        with self.assertRaisesRegex(RuntimeError, 'pinned API 35'):
            EmulatorGpsProvider(runner).install()
        self.assertEqual(runner.calls, [
            ('shell', 'getprop', 'ro.kernel.qemu'),
            ('shell', 'getprop', 'ro.build.version.sdk'),
        ])

    def test_install_uses_shell_appops_and_two_empty_os_providers(self):
        runner = Runner(self.output)
        provider = EmulatorGpsProvider(runner)
        provider.install()
        expected = [
            ('shell', 'getprop', 'ro.kernel.qemu'),
            ('shell', 'getprop', 'ro.build.version.sdk'),
            ('shell', 'id', '-u'),
            ('shell', 'appops', 'set', '2000', 'android:mock_location', 'allow'),
            ('shell', 'cmd', 'location', 'set-location-enabled', 'true'),
        ]
        for name in ('gps', 'network'):
            expected.extend([
                ('shell', 'cmd', 'location', 'providers', 'add-test-provider', name),
                ('shell', 'cmd', 'location', 'providers', 'set-test-provider-enabled', name, 'false'),
                ('shell', 'cmd', 'location', 'providers', 'set-test-provider-enabled', name, 'true'),
            ])
        expected.append(('shell', 'dumpsys', 'location'))
        self.assertEqual(runner.calls, expected)
        self.assertTrue(provider.installed)
        self.assertEqual(provider.injections, 0)
        evidence = json.loads(self.output.joinpath('emulated-gps-provider.json').read_text())
        self.assertEqual(evidence['explicitInjections'], 0)
        self.assertFalse(evidence['physicalGpsTested'])
        self.assertEqual(evidence['controlledProviders'], ['gps', 'network'])

    def test_fix_injection_is_explicit_and_uses_fresh_parser_timestamps(self):
        runner = Runner(self.output)
        provider = EmulatorGpsProvider(runner)
        provider.install()
        runner.calls.clear()
        provider.inject_fix()
        self.assertEqual(runner.calls, [
            ('shell', 'getprop', 'ro.kernel.qemu'),
            ('shell', 'getprop', 'ro.build.version.sdk'),
            ('shell', 'cmd', 'location', 'providers', 'set-test-provider-location',
             'gps', '--location', '31.5,34.47', '--accuracy', '8'),
        ])
        self.assertEqual(provider.injections, 1)
        evidence = json.loads(self.output.joinpath('emulated-gps-provider.json').read_text())
        self.assertEqual(evidence['explicitInjections'], 1)

    def test_injection_before_install_is_refused_without_commands(self):
        runner = Runner(self.output)
        with self.assertRaisesRegex(RuntimeError, 'before injecting'):
            EmulatorGpsProvider(runner).inject_fix()
        self.assertEqual(runner.calls, [])

    def test_root_adb_is_unrooted_then_waited_and_rechecked(self):
        runner = Runner(self.output, uids=('0', '2000'))
        EmulatorGpsProvider(runner).install()
        self.assertEqual(runner.calls[2:9], [
            ('shell', 'id', '-u'),
            ('unroot',),
            ('wait-for-device',),
            ('shell', 'getprop', 'ro.kernel.qemu'),
            ('shell', 'getprop', 'ro.build.version.sdk'),
            ('shell', 'id', '-u'),
            ('shell', 'appops', 'set', '2000', 'android:mock_location', 'allow'),
        ])
        self.assertEqual([call for call in runner.calls if call[:2] == ('shell', 'appops')], [
            ('shell', 'appops', 'set', '2000', 'android:mock_location', 'allow'),
        ])

    def test_failed_unroot_cannot_grant_mock_appops_or_install_providers(self):
        runner = Runner(self.output, uids=('0', '0'))
        with self.assertRaisesRegex(RuntimeError, 'Android shell UID'):
            EmulatorGpsProvider(runner).install()
        self.assertFalse(any(call[:2] == ('shell', 'appops') for call in runner.calls))
        self.assertFalse(any(call[:2] == ('shell', 'cmd') for call in runner.calls))

    def test_missing_mock_provider_or_retained_cache_cannot_mark_install_complete(self):
        for dump in (
            empty_dump().replace('gps provider [mock]:', 'gps provider:'),
            empty_dump().replace('last location=null', 'last location=Location[gps 1,2]', 1),
            empty_dump().replace('last mock location=null', 'last mock location=Location[gps 1,2]', 1),
        ):
            with self.subTest(dump=dump):
                runner = Runner(self.output, dump=dump)
                provider = EmulatorGpsProvider(runner)
                with self.assertRaises(RuntimeError):
                    provider.install()
                self.assertFalse(provider.installed)
                with self.assertRaisesRegex(RuntimeError, 'before injecting'):
                    provider.inject_fix()
                self.assertFalse(self.output.joinpath('emulated-gps-provider.json').exists())

    def test_empty_check_requires_its_own_provider_and_all_user_locations(self):
        with self.assertRaisesRegex(RuntimeError, 'gps provider was not installed'):
            require_empty_provider(empty_dump().split('network provider')[0].replace('gps', 'other'), 'gps')
        dump = empty_dump().replace('  last location=null',
                                    '  last location=null\n  last location=Location[gps 1,2]', 1)
        with self.assertRaisesRegex(RuntimeError, 'retained a location'):
            require_empty_provider(dump, 'gps')
        require_empty_provider(dump, 'network')


if __name__ == '__main__':
    unittest.main()
