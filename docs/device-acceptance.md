# Physical-device acceptance

These are procedures to execute, not completed test results. No phones are
attached to the cloud workspace. Use consenting testers and synthetic messages
and coordinates; erase test material through your established device procedure.
Record pass/fail evidence and unresolved behavior against the exact Git commit,
APK SHA-256/signing certificate, OS build and hardware model.

## Automated emulator baseline

The `Android offline cold launch` workflow builds the bundled x86_64 development
APK and runs `scripts/android/smoke.py` on an official API 35 AOSP image with KVM.
It requires hardware acceleration, keeps normal ADB authentication, disables
emulated internet and radios, and verifies enabled native UI controls without
Metro. A signed synthetic public chat and a synthetic SOS must appear in local
history and survive a force-stop;
the public identity fingerprint must also remain unchanged after restart.

The test refuses physical-device serials and existing emulator state. It never
reads private app files or decrypts databases. Diagnostic artifacts contain only
fresh synthetic UI, bounded error logs and a result report; private emulator
state and developer authentication keys are outside the uploaded directory.
An enabled workflow or successful unit tests do not establish a completed
emulator run: retain the actual passing job/report before recording this gate.
The public-chat smoke extension has runner tests; an actual passing hosted
execution of that extension is still required. This baseline does not replace the physical radio, GPS, battery, iOS or
real-map acceptance checks below.

Checkpoint `2040e8358b20bd6c38a87deeb430de7ceeaeb555` passed the real
[KVM smoke job](https://github.com/saradaas01/PalMesh1/actions/runs/39386162427/job/118506946714),
including native startup, a local queued SOS, retained emergency history and
the same public identity after force-stop/relaunch. The test used the official
API 35 AOSP x86_64 image. Later application changes need their own run.

## Equipment and baseline

Use at least three physical Android phones A, B and C, including a recent API
33+ phone and an older supported device. Add a physical iPhone and an Android
peer for the separate iOS BLE matrix. Include a 16 KiB-page Android model or
supported emulator for native-library validation. Record battery percentage,
power-saving settings, permission grants and foreground/background state.

Install the bundled development or operator-signed candidate APK on every test
phone. Verify the signing fingerprint and ABI compatibility. Force-stop the app,
disconnect USB/Metro, turn off mobile data and internet access, then cold-launch.
Use airplane mode with Wi-Fi/Bluetooth explicitly re-enabled where supported,
or remove SIMs and disable all internet uplinks. Confirm packet exchange still
works without an access point or cell service. A USB-connected development
session does not establish this baseline.

## Transport and durable routing

| Scenario | Required observation |
| --- | --- |
| A and B permit nearby radios | Devices discover, authenticate and exchange a direct message; sender shows local queuing then peer custody. |
| Wi-Fi Direct unavailable, BLE enabled | Both directions work through BLE; no internet fallback occurs. |
| BLE unavailable, Wi-Fi Direct enabled | Both directions work through Wi-Fi Direct, subject to Android group limits. |
| A meets B, then B meets C with A out of range | A's queued packet reaches C through B; C's reply returns after later contact. |
| Repeated disconnect/reconnect and duplicate radio discovery | One logical peer identity and one visible message; retry traffic is bounded. |
| Receiver drops before/after durable ACK | Retry recovers without losing a committed packet or duplicating the archive. |
| Force-stop/restart after queuing and after custody | Queued packets, custody, peer keys and history survive; background delivery is not claimed during force-stop. |
| Ordinary queue loaded, followed by SOS | SOS is the next eligible work item after any current send; UI remains responsive. |
| Test harness exceeds hop budgets | Normal packets stop after 10 hops; SOS/response stop after 15; relays cannot raise a signed TTL. |
| Dense peer/message burst | Bounded memory, retry queues and notification rates; no frozen SOS control or app crash. |

Use the engine's simulation tests for long hop chains; three phones alone cannot
prove a physical 15-hop path. Record actual Wi-Fi Direct group roles and test
moving the group owner out of range. Exercise BLE chunk boundaries, negotiated
MTU, concurrent central/peripheral roles and notification backpressure.

## Public chat regression on a physical phone

Use the APK built from the public-chat feature branch and record its commit and hash.
With no connected peers and no internet, open **Nearby broadcasts · Public**,
confirm the public/not-encrypted warning, type a synthetic `Hello` and send.
Expect **Queued locally**, an empty composer and no queue error. Force-stop and
reopen: `Hello` must remain in that thread with the same identity. Enable nearby
connections on a second updated phone and confirm receipt without duplicates.
Repeat over Wi-Fi Direct and BLE, then relay through a third phone. Older builds
reject signed public chat and must be updated for this scenario.

Separately exchange private messages with known/imported recipient keys while
disconnected, reconnect and confirm delivery. An unrelated relay must not show
private message bodies. Unknown recipient keys must still fail and preserve the
draft. Queue an SOS from the public thread and verify normal emergency priority
and persistence. Repeat the public warning and send flow in Arabic/RTL.
These are required physical checks, not claims of completed device testing.

## SOS, receipt meaning and controls

Trigger SOS from Messages, Map, Emergency inbox and every modal/settings panel.
At most two taps must reach the large red action, including with the keyboard
open and maximum system font size. Repeated presses while queuing must not
create overlapping requests. Missing GPS must not delay queuing; any attached
fix must show its real timestamp and last-known status.

On B, verify the incoming urgent banner/inbox and generic native notification.
The lock screen must not display sender, message contents or coordinates.
Notification denial must leave the durable SOS visible in the app. Review a
burst of SOS messages and verify bounded alerts rather than an audible storm.

Have B choose **responding**. A must receive a response tied to that SOS and B's
cryptographic identity, surviving restart. Relayed traffic and transport custody
ACKs must not appear as human responses. Check wording in both languages: a
person's statement does not promise assistance or establish responder training.
Expiry/review must not say an emergency has been resolved.

## Lifecycle, power and permissions

Deny each permission independently, then grant it in Settings and resume. Check
Android 12 approximate-only location, Android 13+ Nearby Wi-Fi, Bluetooth grants,
notification denial, disabled Bluetooth/Wi-Fi and revoked permissions mid-send.
Denied startup must still permit local queuing and must never silently request
GPS or notifications.

Without background opt-in, lock the screen/background the app and confirm
owned radios stop. Enable background connections explicitly while foregrounded;
confirm the ongoing notification, screen-off behavior and return to foreground.
Use its Stop action while JavaScript is busy/suspended, verify native peripheral
and Wi-Fi cleanup, then reopen and check that the opt-in is removed. Test Doze,
OEM battery management, process kill, force-stop and reboot separately. Never
record a foreground-service notification as proof of successful forwarding.

Exercise automatic low-battery and OS power-saver transitions, charging recovery
and manual override. Ordinary forwarding/location sharing should pause in
conserve mode while SOS remains eligible. Measure actual drain and latency over
a representative screen-off contact cycle; do not infer power savings from a
state toggle. GPS must remain foreground/when-in-use and sharing must start off.

## Storage, keys and offline maps

On a controlled test device, inspect application database files after shutdown:
no readable SQLite header or plaintext message/coordinate strings may appear in
the encrypted databases. This does not prove resistance to a compromised
unlocked phone. Test first unlock after reboot, key invalidation, corrupted key
record, wrong database key, full disk and interrupted writes. Each must fail
visibly without creating replacement identities or plaintext stores. Confirm
backup/cloud synchronization does not export private records.

Exchange direct encrypted chat and verify an unrelated relay cannot display its
body. Unknown recipient keys must produce an actionable failure and retain the
draft. Compare identity fingerprints through an independent trusted channel;
nearby discovery does not prove the person's identity. Test invalid signatures,
modified ciphertext, replay, TTL changes and wrong-destination response packets
with the security tests/harness. Record clock-skew behavior with incorrect phone
clocks; authentication expiration relies on timestamps.

With a real reviewed map installed, cold-launch offline and pan/zoom across Gaza
and the West Bank, including streets/buildings and Arabic labels. Verify local
fonts, no online tile/glyph requests, map attribution/date and stale GPS labels.
Test missing/corrupt/wrong-checksum tiles: show unavailable instead of an online
fallback or fabricated coverage. GPS coordinates/SOS must remain usable. Map
features cannot imply a safe route or current conditions on the ground.

## Arabic and accessibility

Switch English/Arabic and restart. Check persistence, RTL layout, mixed Latin
identities/numbers, text entry and timestamps. With TalkBack (and VoiceOver on
iOS), verify focus order, selected tabs, alert announcements and actionable
labels. Test large fonts, display scaling, contrast, landscape, a small screen,
keyboard overlap and scroll behavior. No urgent control or responder action may
be clipped or require precision tapping.

## iOS and release acceptance

Run the macOS simulator compile workflow before physical iPhone tests. Validate
CoreBluetooth authorization denial/recovery, Android/iPhone traffic in both
roles, MTU/backpressure, reconnect/cancel, first-unlock Keychain access, SQLCipher,
MapLibre glyph rendering and notifications/Focus settings. Background Bluetooth
modes do not guarantee JavaScript forwarding after suspension/force quit; record
the actual limitation. No Android-style Wi-Fi Direct service exists on iOS.

Finally install the signed release candidate without Metro, verify the pinned
certificate, then update from the previous signed version with a higher version
code. Confirm durable queues/keys/history and repeat the offline baseline. Save
results, logs without sensitive payloads, measured limits and remaining failures
with the release record. Any unexecuted or failed scenario stays open.
