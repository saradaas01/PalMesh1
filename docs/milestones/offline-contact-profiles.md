# Offline profile and contact names

This milestone adds optional local profile names and local nicknames bound to
existing pinned `pm1:` fingerprints. It does not rename an identity, migrate a
vault, replace public keys, or change the message/security protocol.

The existing `identity-v1` and `peer-directory-v1` protected records and encrypted
SQLite database are preserved. A separate protected `contact-profile-v1` record
is bound to the local identity. Writes serialize and publish only after durable
vault success. A corrupt or foreign metadata record is never reset: private
messaging remains available and the UI offers an explicit retry. Legacy imported
keys appear without a nickname until the user names them.

Names accept Arabic and emoji, normalize NFC, and reject control/bidi spoofing
characters. Duplicate names are allowed and visibly flagged; fingerprints always
remain available. A different key pair produces a different contact and never
inherits a nickname or comparison. Re-importing existing keys preserves existing
annotations. Newly imported public keys are always marked not compared.
Comparison is an explicit local user statement after exposing the full fingerprint,
not a claim of independently verified personal identity.

Messages, headers and saved-recipient selection resolve names locally and route by
the full original fingerprint. The advanced manual recipient and JSON import flows
remain compatible. The contact screen offers a one-tap private conversation action.

## Public QR exchange

The displayed QR contains a versioned allowlist of public signing/encryption keys
and their derived fingerprint. It never contains private keys, seeds, vault records
or display names. Native SVG renders one path with an opaque quiet zone. Existing
raw two-public-key JSON remains shareable and importable by older applications.

Scanning uses a user-selected, locally available QR image, not a live camera.
Users can exchange screenshots over Bluetooth or another offline method. Android
uses the scoped document picker and bundled Apache-2.0 ZXing core 3.5.3; iOS uses
PhotosUI/CoreImage. No camera/storage permission, online model, phone number or
account is requested. The decoder rejects multiple/unreadable/oversized QR data;
JavaScript validates the exact public payload before displaying it. Scanning never
imports or trusts a contact automatically: review and Save remain separate actions.

The Android decoder bounds input at 8 MiB, downsamples images to at most 2048px,
uses one bounded worker, a 15-second decode timeout, cancellation and generation
checks. Error messages do not echo QR contents or image URIs.

## Test app and limitations

`-PpalmeshContactsTest=true` creates **PalMesh Contacts Test**, application ID
`org.palmesh.contacttest`, separately from the primary app, old Map Test and Map
Performance Test. It has new app-private storage and its own identity. It does not
copy or replace any installed identity. Never uninstall or clear the original app
to install this test. CI verifies the exact ID, debug signing, bundled JS, required
native libraries/16-KiB alignment and unchanged genuine map provenance.

The dedicated workflow tests scoped public QR image decoding, explicit save,
profile/nickname changes, private offline queueing and restart persistence on a
fresh API 35 Android emulator with guest external networking blocked. Existing
public chat/SOS/own-identity restart checks also run. Results are reported only
after the hosted job completes. Unit/UI tests cover restart, corrupt metadata,
duplicate names, malicious envelopes, failed writes, and nonautomatic comparison.

Physical image-picking behavior, screenshots on different screen sizes, Android
14 TECNO behavior, real iOS devices and actual multi-device encrypted exchange
remain acceptance tasks. A single-phone test cannot establish phone-to-phone
Bluetooth/Wi-Fi Direct delivery. No independent security audit is claimed.

This PR is stacked on PR #9 to keep its diff limited to contact changes. It should
be retargeted to `work` only after PR #9 is reviewed and merged; no auto merge.
