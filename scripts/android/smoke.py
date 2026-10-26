#!/usr/bin/env python3
"""Cold-launch a bundled APK on an isolated, KVM-backed Android emulator.

This checks native startup, public chat/SOS persistence and identity reuse.
It never reads private app files and does not establish physical radio behavior.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import socket
import subprocess
import time
import xml.etree.ElementTree as ET

PACKAGE = 'org.palmesh'
SOS = 'I Need Help · SOS'
CONTACTS = 'Identity and contacts'
INBOX = 'SOS inbox'
QUEUED = 'SOS queued on this device. Receipt or assistance is not confirmed.'
PUBLIC_CHAT = 'Nearby broadcasts · Public'
PUBLIC_WARNING = ('Public and not encrypted: mesh participants can read and relay these messages '
                  'beyond nearby devices. Do not share private information.')
PUBLIC_TEXT = 'PalMesh-public-smoke-Hello'
CHAT_QUEUED = 'Message queued on this device. Delivery is not confirmed.'
FINGERPRINT = re.compile(r'pm1:[0-9a-f]{64}(?![0-9a-f])')
BOUNDS = re.compile(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]')


def nodes(xml: str) -> list[ET.Element]:
    return list(ET.fromstring(xml).iter('node'))


def find_control(xml: str, label: str) -> ET.Element | None:
    # Android can append accessibility state/hints to a control's label. Keep
    # exact text matching and the explicit label prefix, never a loose substring.
    matches = [node for node in nodes(xml) if (label in (node.get('text'), node.get('content-desc'))
               or node.get('content-desc', '').startswith(label + ', '))
               and node.get('enabled') == 'true']
    return next((node for node in matches if node.get('clickable') == 'true'), None)


def center(node: ET.Element) -> tuple[int, int]:
    match = BOUNDS.fullmatch(node.get('bounds', ''))
    if match is None:
        raise RuntimeError('The selected control has no usable screen bounds.')
    left, top, right, bottom = map(int, match.groups())
    if right <= left or bottom <= top:
        raise RuntimeError('The selected control is outside the visible screen.')
    return (left + right) // 2, (top + bottom) // 2


def fingerprint(xml: str) -> str | None:
    for node in nodes(xml):
        for field in ('text', 'content-desc'):
            match = FINGERPRINT.search(node.get(field, ''))
            if match:
                return match.group(0)
    return None


def has_text(xml: str, text: str) -> bool:
    return any(text in (node.get('text'), node.get('content-desc')) for node in nodes(xml))


def public_chat_visible(xml: str) -> bool:
    # The native metadata Text combines a locale-rendered time and custody.
    # Require the exact synthetic body and explicit local queue suffix.
    return has_text(xml, PUBLIC_TEXT) and any(
        node.get(field, '').endswith(' · Queued locally')
        for node in nodes(xml) for field in ('text', 'content-desc'))


def avd_configuration(sdk: Path) -> str:
    image = sdk / 'system-images/android-35/default/x86_64'
    if not (image / 'system.img').is_file():
        raise RuntimeError('Install the official API 35 AOSP x86_64 system image first.')
    return '\n'.join([
        'AvdId=PalMeshSmoke', 'avd.ini.encoding=UTF-8', 'abi.type=x86_64',
        'hw.cpu.arch=x86_64', 'hw.cpu.ncore=2', 'hw.ramSize=4096',
        'hw.lcd.width=720', 'hw.lcd.height=1280', 'hw.lcd.density=240',
        'hw.gpu.enabled=yes', 'hw.gpu.mode=swiftshader', 'hw.audioInput=no',
        'hw.audioOutput=no', 'hw.keyboard=yes', 'hw.mainKeys=no',
        'image.sysdir.1=' + str(image) + '/', 'disk.dataPartition.size=6442450944',
        'fastboot.forceColdBoot=yes', 'PlayStore.enabled=false',
        'tag.id=default', 'tag.display=Default Android System Image', '',
    ])


class Smoke:
    def __init__(self, sdk: Path, output: Path, serial: str, ui_timeout: int):
        if not re.fullmatch(r'emulator-[0-9]+', serial):
            raise ValueError('This synthetic SOS test accepts emulator serials only.')
        self.adb = sdk / 'platform-tools/adb'
        self.output = output
        self.serial = serial
        self.ui_timeout = ui_timeout
        self.last_xml = ''

    def command(self, *arguments: str, timeout: int = 30, check: bool = True) -> str:
        result = subprocess.run([str(self.adb), '-s', self.serial, *arguments],
                                capture_output=True, text=True, timeout=timeout, check=False)
        if check and result.returncode:
            # Do not copy arbitrary native output into public workflow annotations.
            raise RuntimeError('ADB command failed: ' + ' '.join(arguments[:3]))
        return result.stdout.strip()

    def wait_boot(self, timeout: int, process: subprocess.Popen) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise RuntimeError('The emulator process exited before Android completed boot.')
            try:
                if self.command('shell', 'getprop', 'sys.boot_completed', timeout=10) == '1':
                    emulated = any(self.command('shell', 'getprop', name) == '1'
                                   for name in ('ro.kernel.qemu', 'ro.boot.qemu'))
                    if not emulated:
                        raise RuntimeError('Refusing synthetic SOS on a non-emulator device.')
                    return
            except (RuntimeError, subprocess.TimeoutExpired):
                pass
            time.sleep(2)
        raise RuntimeError('The Android emulator did not complete boot within the test budget.')

    def isolate(self) -> None:
        self.command('shell', 'cmd', 'connectivity', 'airplane-mode', 'enable')
        for radio in ('wifi', 'data', 'bluetooth'):
            self.command('shell', 'svc', radio, 'disable')
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            connectivity = self.command('shell', 'dumpsys', 'connectivity')
            radios_off = all(self.command('shell', 'settings', 'get', 'global', name) == '0'
                             for name in ('wifi_on', 'bluetooth_on'))
            if radios_off and re.search(r'Active default network:\s*none\b', connectivity, re.IGNORECASE):
                self.output.joinpath('offline-network.txt').write_text('Active default network: none\n')
                return
            time.sleep(2)
        raise RuntimeError('The emulator still has a default network; refusing to queue a synthetic SOS.')

    def dump(self, name: str = 'last-ui.xml') -> str:
        self.command('shell', 'uiautomator', 'dump', '/data/local/tmp/palmesh-smoke-ui.xml', timeout=30)
        xml = self.command('exec-out', 'cat', '/data/local/tmp/palmesh-smoke-ui.xml')
        if not nodes(xml):
            raise RuntimeError('UI automation returned no native view hierarchy.')
        self.last_xml = xml
        self.output.joinpath(name).write_text(xml)
        return xml

    def wait_ui(self, predicate, description: str, name: str) -> str:
        deadline = time.monotonic() + self.ui_timeout
        while time.monotonic() < deadline:
            try:
                xml = self.dump(name)
            except (RuntimeError, ET.ParseError, subprocess.TimeoutExpired):
                time.sleep(2)
                continue
            if has_text(xml, 'Protect your saved data'):
                raise RuntimeError('PalMesh displayed startup recovery instead of becoming ready.')
            if predicate(xml):
                return xml
            time.sleep(2)
        raise RuntimeError('Timed out waiting for ' + description + '.')

    def launch(self, name: str) -> str:
        self.command('shell', 'am', 'force-stop', PACKAGE)
        self.command('logcat', '-c')
        self.command('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP')
        self.command('shell', 'wm', 'dismiss-keyguard')
        result = self.command('shell', 'am', 'start', '-W', '-n', PACKAGE + '/org.palmesh.MainActivity', timeout=60)
        self.output.joinpath(name + '-launch.txt').write_text(result + '\n')
        return self.wait_ui(lambda xml: find_control(xml, SOS) is not None
                            and find_control(xml, CONTACTS) is not None,
                            'enabled local messaging and SOS controls', name + '-ready.xml')

    def tap(self, label: str) -> None:
        control = find_control(self.dump(), label)
        if control is None:
            raise RuntimeError('The required enabled control is missing: ' + label)
        x, y = center(control)
        self.command('shell', 'input', 'tap', str(x), str(y))

    def public_thread(self, name: str) -> None:
        self.tap('Messages')
        self.tap(PUBLIC_CHAT)
        self.wait_ui(lambda xml: has_text(xml, PUBLIC_WARNING),
                     'the public chat privacy warning', name + '-public-warning.xml')

    def queue_public_chat(self) -> None:
        self.public_thread('first')
        self.tap('Message')
        # Fixed ASCII synthetic text only; never interpolate user input into ADB.
        self.command('shell', 'input', 'text', PUBLIC_TEXT)
        self.command('shell', 'input', 'keyevent', 'KEYCODE_BACK')
        self.tap('Send message')
        self.wait_ui(lambda xml: has_text(xml, CHAT_QUEUED),
                     'the durable local public chat queue notice', 'chat-queued.xml')
        self.tap('Dismiss notice')
        self.wait_ui(public_chat_visible,
                     'the outgoing public message with local custody status', 'chat-history.xml')

    def retained_public_chat(self) -> None:
        self.public_thread('second')
        self.wait_ui(public_chat_visible,
                     'retained public chat after restart', 'retained-chat.xml')

    def identity(self, name: str) -> str:
        self.tap(CONTACTS)
        for attempt in range(8):
            xml = self.dump(name)
            value = fingerprint(xml)
            if value is not None:
                return value
            # Swipe inside the content area, away from the persistent SOS footer.
            self.command('shell', 'input', 'swipe', '360', '840', '360', '430', '400')
            time.sleep(0.5)
        raise RuntimeError('The native contact screen did not expose its public identity fingerprint.')

    def diagnostics(self) -> None:
        result = self.command('logcat', '-d', '-t', '300', 'AndroidRuntime:E', 'ReactNativeJS:E', '*:S',
                              timeout=15, check=False)
        self.output.joinpath('native-errors.txt').write_text(result[-65536:] + '\n')
        try:
            self.dump('final-ui.xml')
        except (RuntimeError, ET.ParseError, subprocess.TimeoutExpired):
            pass


def main() -> None:
    global PACKAGE
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apk', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--state', type=Path, required=True, help='New private emulator state directory, outside uploaded diagnostics')
    parser.add_argument('--boot-timeout', type=int, default=480)
    parser.add_argument('--ui-timeout', type=int, default=180)
    parser.add_argument('--gpu', choices=('swiftshader', 'swangle'), default='swiftshader',
                        help='Official emulator software graphics backend; no host GPU required')
    parser.add_argument('--isolated-map-test', action='store_true', help='Launch only the separately identified PalMesh map-test app')
    args = parser.parse_args()
    PACKAGE = 'org.palmesh.maptest' if args.isolated_map_test else 'org.palmesh'
    if not 10 <= args.boot_timeout <= 900 or not 10 <= args.ui_timeout <= 300:
        parser.error('Boot/UI budgets must be bounded (10–900 / 10–300 seconds).')
    sdk_value = os.environ.get('ANDROID_HOME') or os.environ.get('ANDROID_SDK_ROOT')
    if not sdk_value:
        parser.error('ANDROID_HOME is required.')
    sdk = Path(sdk_value).resolve()
    apk = args.apk.resolve(strict=True)
    output = args.output.resolve()
    state = args.state.resolve()
    if state == output or state.is_relative_to(output) or output.is_relative_to(state):
        parser.error('Private emulator state and uploaded diagnostics must be separate directories.')
    if state.exists():
        parser.error('Refusing to overwrite existing emulator state; choose a new directory.')
    if not os.access('/dev/kvm', os.R_OK | os.W_OK):
        raise RuntimeError('Accessible KVM acceleration is required; software emulation is not accepted.')
    try:
        with socket.create_connection(('127.0.0.1', 8081), timeout=0.2):
            raise RuntimeError('Metro is listening; stop it before the offline cold-launch test.')
    except OSError:
        pass
    output.mkdir(parents=True, exist_ok=True)
    avd_home = state / 'avd'
    avd = avd_home / 'PalMeshSmoke.avd'
    avd.mkdir(parents=True)
    avd.joinpath('config.ini').write_text(avd_configuration(sdk))
    avd_home.joinpath('PalMeshSmoke.ini').write_text('avd.ini.encoding=UTF-8\npath=' + str(avd) + '\ntarget=android-35\n')
    environment = dict(os.environ, ANDROID_AVD_HOME=str(avd_home), ANDROID_EMULATOR_HOME=str(state / 'home'))
    Path(environment['ANDROID_EMULATOR_HOME']).mkdir()
    report = {'passed': False, 'physicalDeviceTested': False, 'radiosTested': False,
              'apkSha256': hashlib.sha256(apk.read_bytes()).hexdigest(), 'syntheticSos': True, 'syntheticPublicChat': True}
    smoke = Smoke(sdk, output, 'emulator-5554', args.ui_timeout)
    process = None
    with output.joinpath('emulator.log').open('w') as log:
        try:
            process = subprocess.Popen([
                str(sdk / 'emulator/emulator'), '-avd', 'PalMeshSmoke', '-accel', 'on',
                '-no-window', '-no-audio', '-gpu', args.gpu, '-no-snapshot',
                '-cores', '2', '-memory', '4096', '-port', '5554',
            ], env=environment, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            smoke.wait_boot(args.boot_timeout, process)
            smoke.isolate()
            installed = smoke.command('install', '-r', str(apk), timeout=120)
            if 'Success' not in installed:
                raise RuntimeError('Android did not confirm installation of the selected APK.')
            smoke.launch('first')
            before = smoke.identity('first-identity.xml')
            smoke.queue_public_chat()
            smoke.tap(SOS)
            smoke.wait_ui(lambda xml: has_text(xml, QUEUED), 'the durable local SOS queue notice', 'sos-queued.xml')
            smoke.tap('Dismiss SOS notice')
            smoke.tap(INBOX)
            smoke.wait_ui(lambda xml: has_text(xml, 'Your SOS'), 'the outgoing SOS history', 'sos-history.xml')
            smoke.launch('second')
            after = smoke.identity('second-identity.xml')
            if before != after:
                raise RuntimeError('The established identity changed after a cold restart.')
            smoke.retained_public_chat()
            smoke.tap(INBOX)
            smoke.wait_ui(lambda xml: has_text(xml, 'Your SOS'), 'retained SOS history after restart', 'retained-sos.xml')
            report.update(passed=True, offlineColdLaunch=True, localSosPersisted=True, localPublicChatPersisted=True,
                          identityStable=True, publicIdentitySha256=hashlib.sha256(before.encode()).hexdigest(),
                          api=smoke.command('shell', 'getprop', 'ro.build.version.sdk'),
                          abi=smoke.command('shell', 'getprop', 'ro.product.cpu.abi'))
            print('PASS: offline native cold launch, public chat/SOS persistence and stable identity after restart.')
        except Exception as error:
            report['failure'] = str(error)[:500]
            raise
        finally:
            try:
                smoke.diagnostics()
            except (RuntimeError, subprocess.TimeoutExpired):
                pass
            output.joinpath('smoke-report.json').write_text(json.dumps(report, indent=2) + '\n')
            if process is not None and process.poll() is None:
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                try:
                    process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=10)


if __name__ == '__main__':
    main()
