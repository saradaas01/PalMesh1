# Aqaba demo Android build and acceptance

[Aqaba demo APK and offline acceptance](../../.github/workflows/aqaba-demo.yml)
runs for pull requests targeting `feat/ai-message-priority`, and can be started
with `workflow_dispatch` on the reviewed demo branch. It checks out the exact
pull-request head commit or selected dispatch commit. TypeScript, core/UI/build
checks, Android harness tests and map-tool tests pass before its three Android
lanes start. Every lane runs the native runtime JVM tests.

All three APKs use `-PpalmeshAqabaDemo=true`, application ID
`org.palmesh.aqabademo` and launcher label **PalMesh Aqaba Demo**. This application
has separate Android storage and identity from PalMesh and the older test apps.
These are signed, debuggable test builds, not release builds or a migration of
an existing identity.

| Lane / artifact | Scope |
| --- | --- |
| `android-aqaba-demo-arm64-apk` | Human ARM64 demo APK using the ordinary entry point, with synthetic fixtures absent and map diagnostics disabled. This is the physical-phone artifact. |
| `android-aqaba-demo-emergency-fixture-x86_64-apk` | Disposable emulator-only entry point with signed simulated SOS reports and explicit synthetic OS GPS injection. Never install it for a human demonstration. |
| `android-aqaba-demo-map-interaction-x86_64-apk` | Ordinary entry point with acceptance-only map diagnostics. Runs the actual `MapSmoke` renderer, measured pan/zoom and offline cold-restart checks without the SOS fixture. |

Both x86 lanes require explicit `--allow-map-diagnostics` in APK verification.
The ARM64 lane has neither that allowance nor the alternate emergency entry
point. APK verification checks the intended application identity, label, ABI,
embedded JavaScript, genuine map/provenance, signature and 16 KiB packaging/native
library alignment. The independent map-mode check confirms the sealed APK's
diagnostics metadata. Each APK artifact includes its verification report,
`aqaba-coverage.json`, artifact provenance and the original Jordan manifest.
The two emulator lanes retain separate evidence artifacts even on test failure.
An APK retained after an emulator failure is a build artifact, not a passing
acceptance result; check the workflow conclusion and evidence reports.

## Original map and current packaging validation

The workflow downloads exact same-repository Actions artifact `13403170758`,
`palmesh-candidate-jordan-map`, from successful run `42001163336`. It checks the
producer commit `f8d89e8d8977625fb724f4c560197c92f9492e1d` and verifies the original
manifest and MBTiles digest
`4a291b601e85628eea7e0d51595c027044c078eee89ec5ff39866d49ec106ba2`.
The original OSM data time remains `2026-11-03T21:24:23Z`.

The current `scripts/maps/package.py --report dist/maps/aqaba-coverage.json`
checks the genuine bytes, coverage around Aqaba, streets, buildings, named
features and Arabic names, and all 256 bundled glyph pages before staging the
resources. It generates the runtime digest from the validated pack. The APK
contains these actual local resources; an online style or old Palestine pack
does not satisfy this build. If the pinned artifact expires or validation fails,
the workflow fails. Refreshing the map requires a new reviewed producer and
explicit provenance/digest updates; no fallback artifact is selected.

The older `emergency-map`, `offline-map-render`, `contacts-acceptance` and `ux-acceptance` jobs are
skipped only when the pull request targets `feat/ai-message-priority`. Their
historical Palestine fixtures do not validate this Jordan stack. Existing
general verification, iOS and Android smoke workflows remain enabled.

## Safe human installation and remaining physical checks

Download **only** `android-aqaba-demo-arm64-apk`, check that its workflow passed,
and inspect the accompanying packaging report. Confirm application ID
`org.palmesh.aqabademo`, ARM64 architecture, absent synthetic fixtures and disabled
map diagnostics before selecting a phone. The contained APK is
`palmesh-aqaba-demo-human-arm64.apk`.

```sh
adb -s DEVICE_SERIAL install -r palmesh-aqaba-demo-human-arm64.apk
```

This installs or updates the separate demo application. Keep the original
PalMesh and earlier test apps installed with their data intact. Do not run
uninstall, clear-data, identity rotation or database reset commands. If an
existing Aqaba demo has a different signing certificate and Android refuses an
update, stop and preserve that installation and its keys/data; use a compatible
signed update or another demonstration device. Do not bypass that refusal by
uninstalling it.

The emulator creates disposable private state and disables external connectivity
with radio/interface shutdown and non-loopback IPv4/IPv6 rejection. Its injected
GPS values and simulated SOS packets provide regression evidence only. They do
not establish physical GNSS acquisition, radio delivery or two-phone behavior.
Before the demonstration, follow the physical checklist in
[Aqaba offline map demonstration](aqaba-offline-map.md): offline Aqaba rendering,
pan/zoom/restart, real outdoor location acquisition, SOS while GPS is pending,
exact red markers and missing-location behavior on the receiving phone.
Also check delayed sender timestamps, Arabic/English priority context, radio
recovery, and voluntarily shared display names on two phones. Keep automated
results and physical observations separately identified.
