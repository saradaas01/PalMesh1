# PalMesh native runtime

Autolinks the Android `PalMeshRuntime` and `PalMeshSecurity` modules. Importing
the package starts no service and requests no permissions.

The connected-device foreground service starts only through the app's explicit
background-connections action, while its activity is resumed and notifications
are authorized. The ongoing notification opens the app and includes a Stop
action. Stopping it emits `user-stopped`; the application must stop discovery and
remove its current opt-in. Owned Wi-Fi Direct links and BLE peripheral advertising
also stop natively, without waiting for JavaScript. The BLE-PLX central adapter
finishes its cleanup when JavaScript is runnable; vendor process suspension can
delay that cleanup. Service state is not persisted across process death.
The service does not restart itself, take ownership of the JavaScript DTN queue,
override Doze, or guarantee delivery after Android kills the process. Validate
screen-off and vendor battery-management behavior on physical phones.

Battery and power-saver changes emit `PalMeshRuntimeEvent` battery snapshots.
Emergency notifications contain only a generic localized label and open the
app. They never include a sender, message, coordinates, or location timestamp.
Notification permission requests belong to explicit UI actions; receipt of a
message cannot open a permission prompt. There are at most four active native
SOS notifications and at most one audible alert per ten seconds; the durable
emergency inbox retains the remaining requests for review.

`PalMeshSecurity.read(key)`, `write(key,value)`, and `randomBytes(count)` use the
Android Keystore and SecureRandom. `randomBytes` returns standard Base64. Vault
names allow letters, digits, dot, dash, underscore and colon, with a 128-character
limit. Values are limited to 1 MiB. A nonexportable AES-256-GCM wrapping key is
generated in StrongBox when supported, otherwise AndroidKeyStore (which may use
the device TEE). No hardware-backed guarantee is made for unsupported hardware.
Encrypted, atomic records are kept under the app's no-backup private directory.
Record names are SHA-256 hashes; GCM authenticates each logical key name.
Corruption, lost master keys and Keystore invalidation fail closed. There is no
plaintext fallback, silent identity reset, exported vault or debug-key bypass.

## iOS

The iOS pod provides nonsynchronizing device-bound Keychain records, secure random bytes, battery/Low Power Mode events and generic local SOS notifications. Notification permission requests are explicit foreground actions. `startMeshService` rejects as unsupported: iOS has no Android-style foreground service, and its Bluetooth background modes do not guarantee JavaScript forwarding while suspended. See [iOS host setup and limits](../../docs/ios-app.md). Keychain records remain inaccessible until first unlock after reboot and may survive app uninstall.
