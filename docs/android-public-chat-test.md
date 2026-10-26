# Public chat Android test build

The signed public-chat fix is commit `b7a20c5adbd8868f92c1ecaefd431f85be8e37fc`
on `fix/secure-nearby-broadcasts`; PR #2 targets `work`. Commit `59883c6` adds the
native offline public-chat persistence smoke runner without changing app source.

## Download

Sign into GitHub and open the [verified build artifact](https://github.com/saradaas01/PalMesh1/actions/runs/40342380170/artifacts/12659621810),
or the [passing workflow](https://github.com/saradaas01/PalMesh1/actions/runs/40342380170)
and select **android-development-apk** under Artifacts. Extract the ZIP and locate
`app-debug.apk` and `debug-verification.json`. Artifact retention ends November 9,
2026. This GitHub APK was built and verified separately from the local APK below.

The workspace also retains `dist/android/PalMesh-public-chat-arm64-debug.apk`:
66,057,326 bytes; SHA256
`3063a8c2e2c9c8ce71effab54abb6b4346ef26cf6fb525e96630591da0ef4cb1`.
Its signing certificate SHA256 is
`2dfc74e0d8f5e218dec73a6ce2ace62a1af044dedffe95d9f1024c4bd0bb3bd7`,
matching the earlier recorded local development APK. APKs/certificates generated
on a GitHub runner may differ. The local hash applies only to the local binary.
The local artifact could not be exported into this chat's designated output
folder because that folder is unavailable to the cloud executor; the GitHub
artifact above provides the verified downloadable alternative.

## Install while preserving existing data

Use an ARM64 Android phone, API 24 or newer. Transfer the APK to the phone and
open it, granting installation permission to that source when prompted. Or use:

```sh
adb install -r /path/to/app-debug.apk
```

An update requires the same signing certificate as the installed app. If Android
reports an incompatible signature/update, stop and preserve the current app.
Do not uninstall, clear storage, replace keys or reset data. Obtain the build
signed with the original installation's key, or use a separate consenting test
phone. A debug certificate match with an earlier recorded APK does not prove a
match with the APK installed on your particular phone.

This APK embeds JavaScript and needs no Metro or internet. It is a development
test artifact, not a production release, and includes no reviewed Palestine map.

## Physical test still required

With peers disconnected, open **Nearby broadcasts · Public**, read the public
privacy warning, type synthetic `Hello` and send. Expect **Queued locally** and
an empty draft. Force-stop/reopen and check the message remains. Update both
phones for public-chat exchange; older builds reject this packet policy.
Then test private messaging with known recipient keys and SOS, followed by the
Wi-Fi Direct/BLE/reconnect/relay matrix in [device acceptance](device-acceptance.md).
Record the APK hash, certificate, phone model and OS against each result.
Automated tests and verified APK packaging do not establish physical success.
