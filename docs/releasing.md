# Android releases and reproducible checks

Production releases require a real, reviewed Palestine map pack, an operator-owned
signing identity and completed device acceptance. The automation never creates a
production identity, uses a debug key for releases or publishes an application
store/GitHub Release entry.

## Build gates

Run `npm ci`, `npm run check`, both Python test suites and map/font validation.
Build a development APK with the embedded bundle and run the
[device acceptance procedure](device-acceptance.md) against the exact commit.
The previous build's test results do not establish correctness of later changes.

Supply the licensed MBTiles pack and provenance manifest through the
[map packaging pipeline](maps.md). `scripts/android/release.py` verifies and
stages map/font assets before building. It runs the application checks unless
`--skip-checks` is explicitly selected after the exact sources already passed.
The release still requires map, APK, identity and packaging checks with that flag.

## Operator signing

Generate and back up a signing identity using your organization's established
secure procedure. The same identity is required for in-place Android updates;
a different signer cannot update an installed application. Keep the private key,
passwords and backups outside the repository and access logs. Do not paste them
into chat or commit them as example configuration.

Set these environment variables through a secure local secret manager or CI
secret store:

| Variable | Required value |
| --- | --- |
| `PALMESH_RELEASE_STORE_FILE` | Absolute path to the operator's keystore. |
| `PALMESH_RELEASE_STORE_PASSWORD` | Keystore password. |
| `PALMESH_RELEASE_KEY_ALIAS` | Signing key alias. |
| `PALMESH_RELEASE_KEY_PASSWORD` | Key password. |
| `PALMESH_RELEASE_CERT_SHA256` | Independently recorded signing certificate fingerprint; hex with optional colons. |
| `PALMESH_VERSION_NAME` | Semantic version, for example `0.1.0`. |
| `PALMESH_VERSION_CODE` | Positive monotonically increasing Android code, for example `1`. |

```sh
python3 scripts/android/release.py --architectures arm64-v8a
# For the supported React Native source fallback:
python3 scripts/android/release.py --source-build --architectures arm64-v8a
```

Configure `PALMESH_SOURCE_CACHE` or `REACT_NATIVE_BOOST_PATH` before selecting
`--source-build`; see [Android prerequisites](android-app.md). The source-built
Hermes compiler remains paired with the source-built VM.

The script verifies application ID, launcher, requested ABI set, version,
embedded JavaScript, bundled map digest/provenance, nondebuggable manifest,
operator certificate fingerprint, APK signature and 16 KiB ZIP page alignment.
It copies only a successfully verified signed artifact into `dist/android/`,
with a JSON report and SHA-256 sidecar. ZIP page alignment does not replace ELF
or real-device 16 KiB validation. The report explicitly records that it does not
establish device installation/testing.

Without credentials, a plain Gradle `:app:assembleRelease` produces an unsigned
build for compilation review. `release.py` refuses to distribute it. An unsigned
APK is not installable as an ordinary application and is not a deployable release.
The current missing map and signing credentials must not be replaced by dummy
production resources to make a release gate pass.

## GitHub Actions

`verify.yml` checks application code, map/release tooling and local fonts, builds
the production JavaScript bundle, and builds a bundled development APK through
the normal official AAR path. GitHub-hosted runners use their Android SDK; they
do not depend on a retained cloud filesystem. An artifact-download outage is a
build failure, not permission to use an untrusted mirror or skip native checks.

`verify-ios.yml` is a manual macOS simulator compile gate with code signing
disabled. It installs CocoaPods and compiles the actual iOS host; it does not
validate iPhone BLE or produce a distribution IPA.

`release-android.yml` is manually dispatched and uses the `android-release`
GitHub environment. Configure required reviewers in repository settings if that
is your release policy. Configure the four signing secrets (using
`PALMESH_RELEASE_KEYSTORE_BASE64` instead of a filesystem path) and the
`PALMESH_RELEASE_CERT_SHA256` environment variable. Materialized keys are mode
0600 in the runner's temporary directory and removed even after failure. Supply
the reviewed map through your controlled artifact provisioning before running
this workflow; it deliberately fails while no map exists in the checkout.

Workflow artifacts inherit repository and workflow access rules; public
repositories can expose artifacts. The workflows upload build artifacts for
review and do not publish to stores or create release announcements. Triggering
or configuring those workflows is an operator action. Regular source backups
use ordinary non-force Git pushes; APKs, maps, caches, databases and credentials
remain outside source commits.

## Offline installation and updates

Distribute the APK and its certificate fingerprint/checksum through a trusted
channel independent of the mesh. Verify the signature and compare the pinned
certificate before installation; a checksum received with an untrusted APK alone
does not authenticate the sender. Android may require a user-approved setting
for the particular offline installer. Install on a test phone first, including
a cold launch without internet, Metro or a developer computer.

Test an update over the previously installed APK using the same signing identity
and an increased version code. Confirm queued traffic, keys, conversations,
responses and preferences survive. Schema migration and captured-device policy
need explicit release review. No automatic updater, key recovery, silent
migration from old plaintext development databases or remote revocation service
is provided.

Record the Git commit, APK SHA-256, signing certificate, versions, map data date,
map/font digests, test evidence and known device restrictions with each release.
