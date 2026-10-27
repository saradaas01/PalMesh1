# Simple offline experience

This branch is stacked on PR #10 (which is stacked on PR #9). Neither parent is
merged automatically. Routing, cryptographic identity records, pinned public keys,
message persistence and protocols remain unchanged.

The design uses a shared light surface/teal palette, 48-point minimum actions,
consistent typography/spacing/cards, four primary destinations, a compact persistent
SOS action, and focused Profile/Settings/SOS inbox pages inside More. The keyboard
hides bottom navigation while retaining the emergency action. Large font settings
use a two-column navigation layout. All new labels have English/Arabic versions.

Profile names stay optional local annotations. Full fingerprints and public JSON
are available in Advanced identity details; copying validates a full public pm1
fingerprint natively. Contacts can be searched, tapped to chat, renamed, or opened
for explicit fingerprint comparison. Scanning never verifies a person's identity.
Existing raw public JSON import remains under optional details.

The main Scan QR action opens a camera viewfinder. Android requests CAMERA only
from that action, uses a bounded native NV21 decoder (one worker, maximum 1280x720,
350ms sampling, rotation recovery), releases the camera on pause/destroy, and never
saves frames. iOS uses AVFoundation after an explicit permission request. Gallery
import remains a secondary action. All decoded data passes the existing strict
public-key/fingerprint validation before preview and explicit Save. Private keys
are never shared, shown or used as QR data.

Skippable onboarding explains offline waiting, optional names, QR contacts, messaging
and SOS limitations. Its own protected ux-onboarding-v1 preference is bound to the
existing identity and does not migrate or reset identity/contact/database records.
Corrupt or failed preference writes preserve the original record.

Public broadcasts remain clearly public; private messages stay encrypted. Accurate
custody states use friendly wording and delivery explanations live under Details.
Map/GPS/sharing controls and long explanations are collapsed; the genuine offline
map and required attribution are preserved. SOS results still warn when receipt or
assistance is not confirmed, and responder statements are not rescue confirmations.

## Verification

The dedicated UX workflow builds org.palmesh.uxtest / PalMesh UX Test, independently
of every previous PalMesh installation. A new test identity is created in its own
storage; no original identity/history is copied or replaced. It verifies signature,
bundled JS, map provenance, native library/ZIP alignment and diagnostics disabled.

A hosted API 35 AOSP emulator receives an explicit synthetic public QR through its
image-backed camera. It tests on-demand permission denial, live native preview and
QR decode, strict preview/explicit contact save, private offline queue/restart,
profile/onboarding persistence, SOS/public chat/identity recovery, Arabic and small
screens. Guest external networking is blocked. Screenshots and native camera stage
logs are retained. JVM tests exercise the same live decoder with rotated frames;
UI tests cover camera denial/cancellation/invalid private payloads and advanced
identity visibility. Only completed workflow results count as verification.

Physical TECNO camera/autofocus, touch/keyboard comfort, font settings and multi-device
radio delivery require user acceptance. iOS camera capture requires real hardware;
simulator compilation is not physical camera acceptance. No independent security
audit or field readiness is claimed.
