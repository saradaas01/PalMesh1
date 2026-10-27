#!/usr/bin/env python3
"""Actual offline native rendering: fresh isolated emulator, requests, features and pixels."""
from __future__ import annotations
import hashlib
import base64
import io
import os
import json
from pathlib import Path
import re
import subprocess
import sys
import time
import smoke


def interface_names(output: str) -> list[str]:
    names = re.findall(r'^\d+: ([A-Za-z0-9_.-]+)(?:@[^:]+)?:', output, re.MULTILINE)
    if 'lo' not in names: raise RuntimeError('Cannot identify emulator loopback interface')
    return [name for name in names if name != 'lo']


def radio_is_off(value: str, hardware_present: bool) -> bool:
    # Absence is accepted only when Android does not advertise that radio.
    return value == '0' or (value == 'null' and not hardware_present)


def render_records(log: str) -> list[dict]:
    records = []
    for line in log.splitlines():
        if 'render_evidence ' not in line: continue
        try: value = json.loads(line.split('render_evidence ', 1)[1])
        except (ValueError, IndexError): continue
        if isinstance(value, dict): records.append(value)
    return records


def rendered_offline(value: dict) -> bool:
    return (value.get('androidInternetConnected') is False and value.get('loopbackOnly') is True
            and all(type(value.get(key)) in (int, float) and value[key] > 0
                    for key in ('geometry', 'roads', 'labels', 'arabicLabels', 'tileHits', 'glyphHits')))


def baseline_observation(failure: str, records: list[dict]) -> dict | None:
    expected = ('Offline map renderer reported unavailable', 'No actual offline street/Arabic/glyph render evidence',
                'Zoom control did not produce a verified native zoom increase',
                'Swipe did not move the native map camera inside the surrounding list',
                'Map pixels did not change after pan/zoom')
    if failure not in expected or not records: return None
    last = records[-1]
    if not (last.get('androidInternetConnected') is False and last.get('loopbackOnly') is True
            and last.get('sdkConnected') is False): return None
    blank_failure = failure in expected[:2]
    stalled = blank_failure and len(records) >= 3 and all(
        value.get('geometry') == 0 and value.get('tileHits') == 0 and value.get('glyphHits') == 0
        for value in records[-3:])
    return {'reproducedBlankMap': stalled, 'observedFailure': failure,
            'renderedLocalFeatures': any(rendered_offline(value) for value in records), 'evidence': last}


def map_pixels(image, bounds: tuple[int, int, int, int]) -> dict:
    left, top, right, bottom = bounds
    if not 0 <= left < right <= image.width or not 0 <= top < bottom <= image.height:
        raise RuntimeError('Map screenshot bounds are invalid')
    # Exclude the status overlay and the surrounding app UI/attribution.
    crop = image.convert('RGB').crop((left + 8, top + max(36, (bottom-top)//8), right - 8, bottom - 8))
    colors = crop.getcolors(crop.width * crop.height) or []
    roads = sum(count for count, (r, g, b) in colors if r >= 150 and g >= 130 and b <= 195 and r >= b + 25 and g >= b + 15)
    if roads < 40 or len(colors) < 16: raise RuntimeError('Map pixels lack rendered street detail')
    return {'roadPixels': roads, 'distinctColors': len(colors), 'mapPixelsSha256': hashlib.sha256(crop.tobytes()).hexdigest()}


class MapSmoke(smoke.Smoke):
    system_baseline = False
    def isolate(self) -> None:
        # Disposable official AOSP guest only; preserve normal ADB authentication.
        # No physical serial or existing AVD can reach this point in smoke.main.
        root_attempts = []
        for _ in range(3):
            result = subprocess.run([str(self.adb), '-s', self.serial, 'root'], check=False, capture_output=True, text=True, timeout=30)
            root_attempts.append((result.stdout + result.stderr)[-1000:])
            self.output.joinpath('emulator-root.txt').write_text('\n'.join(root_attempts))
            try:
                self.command('wait-for-device', timeout=20)
                if self.command('shell', 'id', '-u') == '0': break
            except (RuntimeError, subprocess.TimeoutExpired): pass
            time.sleep(2)
        else: raise RuntimeError('Disposable AOSP guest root unavailable; firewall isolation was not established')
        for tool in ('iptables', 'ip6tables'):
            self.command('shell', tool, '-I', 'OUTPUT', '1', '!', '-o', 'lo', '-j', 'REJECT')
            rules = self.command('shell', tool, '-S', 'OUTPUT')
            if '! -o lo -j REJECT' not in rules: raise RuntimeError('External network block was not installed')
            self.output.joinpath(tool + '-output.txt').write_text(rules + '\n')
        self.command('shell', 'cmd', 'connectivity', 'airplane-mode', 'enable')
        for radio in ('wifi', 'data', 'bluetooth'):
            self.command('shell', 'svc', radio, 'disable')
        # New AOSP images may expose virtual Ethernet, which airplane mode does
        # not turn off. Disable every non-loopback interface in this fresh guest.
        interfaces = self.command('shell', 'ip', '-o', 'link', 'show')
        self.output.joinpath('network-interfaces-before.txt').write_text(interfaces + '\n')
        for interface in interface_names(interfaces):
            self.command('shell', 'ip', 'link', 'set', 'dev', interface, 'down')
        features = set(self.command('shell', 'pm', 'list', 'features').splitlines())
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            connectivity = self.command('shell', 'dumpsys', 'connectivity')
            settings = {key: self.command('shell', 'settings', 'get', 'global', key)
                        for key in ('wifi_on', 'bluetooth_on')}
            self.output.joinpath('offline-connectivity.txt').write_text(connectivity + '\n')
            self.output.joinpath('radio-settings.json').write_text(json.dumps({'settings': settings, 'features': sorted(features)}, indent=2) + '\n')
            radios_off = all(radio_is_off(settings[key], feature in features)
                             for key, feature in (('wifi_on', 'feature:android.hardware.wifi'),
                                                  ('bluetooth_on', 'feature:android.hardware.bluetooth')))
            if radios_off and re.search(r'Active default network:\s*none\b', connectivity, re.IGNORECASE):
                self.output.joinpath('offline-network.txt').write_text('Active default network: none\nNon-loopback IPv4/IPv6 egress rejected\n')
                return
            time.sleep(2)
        raise RuntimeError('Emulator offline isolation failed; inspect offline-connectivity.txt and radio-settings.json')

    def evidence(self) -> list[dict]:
        log = self.command('logcat', '-d', '-t', '2000', 'PalMeshOfflineMap:I', '*:S')
        self.output.joinpath('map-network.txt').write_text(log + '\n')
        errors = self.command('logcat', '-d', '-t', '1000', 'Mbgl-HttpRequest:V', 'Mbgl-ConnectivityReceiver:V', 'Mbgl:W', 'Mbgl-Map:E', 'MapLibre:E', 'MLRNMapView:E', 'EGL_emulation:E', 'libEGL:E', 'AndroidRuntime:E', 'ReactNativeJS:E', '*:S')
        errors = re.sub(r'/[a-f0-9]{32,64}/', '/[session]/', errors)
        self.output.joinpath('map-runtime-errors.txt').write_text(errors[-65536:] + '\n')
        return render_records(log)

    def screenshot(self, name: str) -> dict:
        from PIL import Image
        xml = self.dump(name + '.xml')
        frame = next((node for node in smoke.nodes(xml) if node.get('content-desc') == 'Offline map of bundled coverage'), None)
        if frame is None: raise RuntimeError('Native map viewport is absent')
        bounds = smoke.BOUNDS.fullmatch(frame.get('bounds', ''))
        if bounds is None: raise RuntimeError('Native map viewport has no bounds')
        data = subprocess.check_output([str(self.adb), '-s', self.serial, 'exec-out', 'screencap', '-p'], timeout=30)
        path = self.output / (name + '.png'); path.write_bytes(data)
        with Image.open(path) as image:
            area = tuple(map(int, bounds.groups()))
            summary = map_pixels(image, area)
            if name.startswith('first-'):
                # A bounded map-only thumbnail in logs permits independent review
                # without exposing app identity text or relying on artifact APIs.
                thumb = image.crop(area).convert('RGB'); thumb.thumbnail((1024, 768))
                stream = io.BytesIO(); thumb.save(stream, format='PNG')
                encoded = base64.b64encode(stream.getvalue()).decode('ascii')
                if len(encoded) > 350000: raise RuntimeError('Map evidence thumbnail exceeds bound')
                for index in range(0, len(encoded), 4000):
                    print('MAP_IMAGE_CHUNK ' + name + ' ' + encoded[index:index+4000], flush=True)
            return summary

    def launch(self, name: str) -> str:
        xml = super().launch(name)
        self.tap('Map')
        deadline = time.monotonic() + min(self.ui_timeout, 90)
        records = []
        while time.monotonic() < deadline:
            self.dump(name + '-map.xml')
            records = self.evidence()
            if any(rendered_offline(value) and (self.system_baseline or value.get('sdkConnected') is True) for value in records): break
            if smoke.has_text(self.last_xml, 'Offline map could not render. Check the bundled tiles and native map setup. Stored locations and SOS remain available.'):
                raise RuntimeError('Offline map renderer reported unavailable')
            time.sleep(2)
        else: raise RuntimeError('No actual offline street/Arabic/glyph render evidence')
        before = self.screenshot(name + '-map-rendered')
        initial_zoom = next(value['zoom'] for value in reversed(records) if rendered_offline(value))
        frame = next(node for node in smoke.nodes(self.last_xml) if node.get('content-desc') == 'Offline map of bundled coverage')
        left, top, right, bottom = map(int, smoke.BOUNDS.fullmatch(frame.get('bounds', '')).groups())
        x, y = (left+right)//2, (top+bottom)//2
        # The accessible product control avoids timing-sensitive ADB double taps.
        self.tap('Zoom in')
        zoom_deadline = time.monotonic() + 20
        while time.monotonic() < zoom_deadline:
            zoom_records = self.evidence()
            if any(rendered_offline(value) and value.get('zoom', 0) > initial_zoom + 0.5 for value in zoom_records): break
            time.sleep(1)
        else: raise RuntimeError('Zoom control did not produce a verified native zoom increase')
        zoomed = self.screenshot(name + '-map-zoomed')
        pan_baseline = next(value.get('cameraMoves', 0) for value in reversed(self.evidence()) if rendered_offline(value))
        # Re-read the visible viewport after zoom/focus/layout changes. A vertical
        # drag also exercises interception by the surrounding vertical list.
        frame = next(node for node in smoke.nodes(self.last_xml) if node.get('content-desc') == 'Offline map of bundled coverage')
        left, top, right, bottom = map(int, smoke.BOUNDS.fullmatch(frame.get('bounds', '')).groups())
        x, y = (left+right)//2, (top+bottom)//2
        distance = min(80, (bottom-top)//4)
        self.command('shell', 'input', 'swipe', str(x), str(y+distance), str(x), str(y-distance), '500')
        pan_deadline = time.monotonic() + 15
        while time.monotonic() < pan_deadline:
            pan_records = self.evidence()
            if any(rendered_offline(value) and value.get('cameraMoves', 0) > pan_baseline for value in pan_records): break
            time.sleep(1)
        else: raise RuntimeError('Swipe did not move the native map camera inside the surrounding list')
        time.sleep(2)
        after = self.screenshot(name + '-map-pan-zoom')
        if zoomed['mapPixelsSha256'] == after['mapPixelsSha256']:
            raise RuntimeError('Map pixels did not change after pan/zoom')
        report = {'sourceCommit': os.environ.get('PALMESH_TEST_SOURCE_SHA'), 'passed': True, 'physicalDeviceTested': False, 'freshEmulatorExternalNetworkBlocked': True,
                  'applicationId': smoke.PACKAGE,
                  'emulatorGpu': sys.argv[sys.argv.index('--gpu') + 1] if '--gpu' in sys.argv else 'swiftshader',
                  'variant': 'system-baseline' if self.system_baseline else 'local-resources',
                  'rendered': next(value for value in reversed(self.evidence()) if rendered_offline(value)),
                  'before': before, 'afterZoom': zoomed, 'initialZoom': initial_zoom,
                  'zoomAfterControl': next(value['zoom'] for value in reversed(zoom_records) if rendered_offline(value)), 'afterPanZoom': after}
        print('MAP_RENDER_EVIDENCE ' + json.dumps(report), flush=True)
        self.output.joinpath(name + '-map-report.json').write_text(json.dumps(report, indent=2) + '\n')
        errors = self.output.joinpath('map-runtime-errors.txt').read_text()
        print('MAP_RUNTIME_LOG ' + json.dumps(errors[-6000:]), flush=True)
        if self.system_baseline:
            self.output.joinpath('baseline-reproduction.json').write_text(json.dumps({
                'reproduced': False, 'reason': 'Original scheduler behavior rendered in this emulator; physical-phone failure not reproduced.',
                'evidence': report['rendered']}, indent=2) + '\n')
        return xml


def main():
    baseline = '--observe-system-baseline' in sys.argv
    if baseline: sys.argv.remove('--observe-system-baseline')
    MapSmoke.system_baseline = baseline
    smoke.Smoke = MapSmoke
    try: smoke.main()
    except Exception as error:
        if not baseline: raise
        output = Path(sys.argv[sys.argv.index('--output') + 1])
        records = render_records((output / 'map-network.txt').read_text()) if (output / 'map-network.txt').exists() else []
        observation = baseline_observation(str(error), records)
        if observation is None: raise
        output.joinpath('baseline-observation.json').write_text(json.dumps(observation, indent=2) + '\n')
        print('BASELINE_OBSERVATION ' + json.dumps(observation), flush=True)
        print('Baseline observation recorded; this is not a passing map-acceptance result or proof of the physical-phone cause.')
        return
    if baseline:
        print('BASELINE_OBSERVATION: Original system reachability rendered offline in this emulator. Physical-phone failure and exact cause are NOT reproduced.')
        return
    print('PASS: two offline cold starts rendered streets and Arabic-labelled features with local glyph hits, measured zoom and pan pixels; chat/SOS/identity persisted. Text legibility requires image review.')


if __name__ == '__main__': main()
