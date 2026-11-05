"""Strong offline isolation for fresh, disposable official AOSP test guests.

No physical device or pre-existing AVD is accepted by smoke.main. Keep loopback
for the local authenticated tile server; reject all other IPv4/IPv6 egress.
"""
import json
import re
import subprocess
import time


def interface_names(output: str) -> list[str]:
    names = re.findall(r'^\d+: ([A-Za-z0-9_.-]+)(?:@[^:]+)?:', output, re.MULTILINE)
    if 'lo' not in names: raise RuntimeError('Cannot identify emulator loopback interface')
    return [name for name in names if name != 'lo']


def radio_is_off(value: str, hardware_present: bool) -> bool:
    # Absence is accepted only when Android does not advertise that radio.
    return value == '0' or (value == 'null' and not hardware_present)


def isolate_emulator_network(runner) -> None:
    if not re.fullmatch(r'emulator-[0-9]+', runner.serial):
        raise ValueError('Offline isolation accepts emulator serials only')
    if not any(runner.command('shell', 'getprop', key) == '1'
               for key in ('ro.kernel.qemu', 'ro.boot.qemu')):
        raise RuntimeError('Refusing offline isolation on a non-emulator device')
    # Disposable official AOSP guest only; preserve normal ADB authentication.
    # No physical serial or existing AVD can reach this point in smoke.main.
    root_attempts = []
    for _ in range(3):
        result = subprocess.run([str(runner.adb), '-s', runner.serial, 'root'], check=False, capture_output=True, text=True, timeout=30)
        root_attempts.append((result.stdout + result.stderr)[-1000:])
        runner.output.joinpath('emulator-root.txt').write_text('\n'.join(root_attempts))
        try:
            runner.command('wait-for-device', timeout=20)
            if runner.command('shell', 'id', '-u') == '0': break
        except (RuntimeError, subprocess.TimeoutExpired): pass
        time.sleep(2)
    else: raise RuntimeError('Disposable AOSP guest root unavailable; firewall isolation was not established')
    for tool in ('iptables', 'ip6tables'):
        runner.command('shell', tool, '-I', 'OUTPUT', '1', '!', '-o', 'lo', '-j', 'REJECT')
        rules = runner.command('shell', tool, '-S', 'OUTPUT')
        if '! -o lo -j REJECT' not in rules: raise RuntimeError('External network block was not installed')
        runner.output.joinpath(tool + '-output.txt').write_text(rules + '\n')
    runner.command('shell', 'cmd', 'connectivity', 'airplane-mode', 'enable')
    for radio in ('wifi', 'data', 'bluetooth'):
        runner.command('shell', 'svc', radio, 'disable')
    # New AOSP images may expose virtual Ethernet, which airplane mode does
    # not turn off. Disable every non-loopback interface in this fresh guest.
    interfaces = runner.command('shell', 'ip', '-o', 'link', 'show')
    runner.output.joinpath('network-interfaces-before.txt').write_text(interfaces + '\n')
    for interface in interface_names(interfaces):
        runner.command('shell', 'ip', 'link', 'set', 'dev', interface, 'down')
    features = set(runner.command('shell', 'pm', 'list', 'features').splitlines())
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        connectivity = runner.command('shell', 'dumpsys', 'connectivity')
        settings = {key: runner.command('shell', 'settings', 'get', 'global', key)
                    for key in ('wifi_on', 'bluetooth_on')}
        runner.output.joinpath('offline-connectivity.txt').write_text(connectivity + '\n')
        runner.output.joinpath('radio-settings.json').write_text(json.dumps({'settings': settings, 'features': sorted(features)}, indent=2) + '\n')
        radios_off = all(radio_is_off(settings[key], feature in features)
                         for key, feature in (('wifi_on', 'feature:android.hardware.wifi'),
                                              ('bluetooth_on', 'feature:android.hardware.bluetooth')))
        if radios_off and re.search(r'Active default network:\s*none\b', connectivity, re.IGNORECASE):
            runner.output.joinpath('offline-network.txt').write_text('Active default network: none\nNon-loopback IPv4/IPv6 egress rejected\n')
            return
        time.sleep(2)
    raise RuntimeError('Emulator offline isolation failed; inspect offline-connectivity.txt and radio-settings.json')

