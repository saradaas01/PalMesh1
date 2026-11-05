"""Every Android acceptance lane must actually isolate virtual Ethernet too."""
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import emulator_network
import map_smoke
import smoke


class Guest:
    def __init__(self, output):
        self.serial = 'emulator-5554'
        self.adb = Path('/sdk/platform-tools/adb')
        self.output = output
        self.calls = []
        self.down = set()
        self.blocked = set()
        self.interfaces = '1: lo: <LOOPBACK,UP>\n2: eth0@if9: <UP>\n3: wlan0: <UP>'
        self.emulated = True
        self.rooted = True
        self.valid_rules = True
        self.always_connected = False
        self.radio_values = {'wifi_on': '0', 'bluetooth_on': '0'}
        self.features = 'feature:android.hardware.wifi\nfeature:android.hardware.bluetooth'

    def command(self, *args, **_kwargs):
        self.calls.append(args)
        if args[:2] == ('shell', 'getprop'): return '1' if self.emulated else '0'
        if args == ('wait-for-device',): return ''
        if args == ('shell', 'id', '-u'): return '0' if self.rooted else '2000'
        if len(args) > 2 and args[1] in ('iptables', 'ip6tables'):
            if args[2] == '-I': self.blocked.add(args[1]); return ''
            return '-A OUTPUT ! -o lo -j REJECT' if self.valid_rules else '-P OUTPUT ACCEPT'
        if args == ('shell', 'ip', '-o', 'link', 'show'): return self.interfaces
        if args[:5] == ('shell', 'ip', 'link', 'set', 'dev'):
            self.down.add(args[5]); return ''
        if args == ('shell', 'pm', 'list', 'features'): return self.features
        if args[:4] == ('shell', 'settings', 'get', 'global'): return self.radio_values[args[4]]
        if args == ('shell', 'dumpsys', 'connectivity'):
            # Airplane mode alone leaves this virtual default network active.
            return 'Active default network: 100 (ETHERNET)' if self.always_connected or 'eth0' not in self.down else 'Active default network: none'
        return ''


class EmulatorNetworkTests(unittest.TestCase):
    def isolate(self, guest):
        with patch.object(emulator_network.subprocess, 'run', return_value=Mock(stdout='adbd restarted\n', stderr='')) as root:
            emulator_network.isolate_emulator_network(guest)
            return root

    def test_base_and_map_lanes_share_strong_isolation_with_compatible_helpers(self):
        self.assertIs(map_smoke.MapSmoke.isolate, smoke.Smoke.isolate)
        self.assertIs(map_smoke.interface_names, emulator_network.interface_names)
        self.assertIs(map_smoke.radio_is_off, emulator_network.radio_is_off)
        with tempfile.TemporaryDirectory() as temporary:
            guest = Guest(Path(temporary))
            root = self.isolate(guest)
            root.assert_called_once()
            self.assertEqual(guest.blocked, {'iptables', 'ip6tables'})
            self.assertEqual(guest.down, {'eth0', 'wlan0'})
            self.assertNotIn('lo', guest.down)
            self.assertIn('Non-loopback IPv4/IPv6 egress rejected', (guest.output/'offline-network.txt').read_text())
            for tool in ('iptables', 'ip6tables'):
                self.assertIn('! -o lo -j REJECT', (guest.output/(tool+'-output.txt')).read_text())

    def test_physical_serial_is_rejected_before_any_adb_or_root_command(self):
        guest = Guest(Path('/unused')); guest.serial = 'physical-phone'
        with patch.object(emulator_network.subprocess, 'run') as root:
            with self.assertRaisesRegex(ValueError, 'emulator serials only'):
                emulator_network.isolate_emulator_network(guest)
            root.assert_not_called()
        self.assertEqual(guest.calls, [])

    def test_emulator_shaped_serial_without_qemu_cannot_mutate_network(self):
        guest = Guest(Path('/unused')); guest.emulated = False
        with patch.object(emulator_network.subprocess, 'run') as root:
            with self.assertRaisesRegex(RuntimeError, 'non-emulator'):
                emulator_network.isolate_emulator_network(guest)
            root.assert_not_called()
        self.assertTrue(all(call[:2] == ('shell', 'getprop') for call in guest.calls))

    def test_missing_loopback_or_missing_firewall_rule_fails_closed(self):
        for missing in ('loopback', 'rule'):
            with self.subTest(missing=missing), tempfile.TemporaryDirectory() as temporary:
                guest = Guest(Path(temporary))
                if missing == 'loopback': guest.interfaces = '2: eth0: <UP>'
                else: guest.valid_rules = False
                with self.assertRaisesRegex(RuntimeError, 'loopback|block was not installed'):
                    self.isolate(guest)
                self.assertFalse((guest.output/'offline-network.txt').exists())

    def test_unavailable_root_never_claims_firewall_isolation(self):
        with tempfile.TemporaryDirectory() as temporary:
            guest = Guest(Path(temporary)); guest.rooted = False
            with patch.object(emulator_network.time, 'sleep'):
                with self.assertRaisesRegex(RuntimeError, 'root unavailable'):
                    self.isolate(guest)
            self.assertEqual(guest.blocked, set())
            self.assertFalse((guest.output/'offline-network.txt').exists())

    def test_a_default_network_or_enabled_radio_remains_a_failure_after_link_shutdown(self):
        for problem in ('network', 'radio'):
            with self.subTest(problem=problem), tempfile.TemporaryDirectory() as temporary:
                guest = Guest(Path(temporary))
                if problem == 'network': guest.always_connected = True
                else: guest.radio_values['wifi_on'] = '1'
                with patch.object(emulator_network.time, 'monotonic', side_effect=[0, 0, 46]), patch.object(emulator_network.time, 'sleep'):
                    with self.assertRaisesRegex(RuntimeError, 'offline isolation failed'):
                        self.isolate(guest)
                self.assertEqual(guest.down, {'eth0', 'wlan0'})
                self.assertFalse((guest.output/'offline-network.txt').exists())

    def test_null_radio_state_is_accepted_only_for_absent_hardware(self):
        for present in (False, True):
            with self.subTest(present=present), tempfile.TemporaryDirectory() as temporary:
                guest = Guest(Path(temporary)); guest.radio_values = {'wifi_on': 'null', 'bluetooth_on': 'null'}
                guest.features = 'feature:android.hardware.wifi' if present else ''
                with patch.object(emulator_network.time, 'monotonic', side_effect=[0, 0, 46]), patch.object(emulator_network.time, 'sleep'):
                    if present:
                        with self.assertRaisesRegex(RuntimeError, 'offline isolation failed'): self.isolate(guest)
                    else: self.isolate(guest)
                self.assertEqual((guest.output/'offline-network.txt').exists(), not present)


if __name__ == '__main__': unittest.main()
