import { PermissionsAndroid, Platform } from 'react-native';
import {
  RadioPermissionController,
  type IosBluetoothAuthorizationBridge,
  type NativeRadioPermissionBridge,
} from './RadioPermissionController';

export interface ReactNativeRadioPermissionOptions {
  readonly iosBluetoothAuthorization?: IosBluetoothAuthorizationBridge;
}

/** Import from a linked React Native host. Merely constructing this adapter or
 * calling check never requests permissions or constructs a BLE manager. */
export function createReactNativeRadioPermissions(options: ReactNativeRadioPermissionOptions = {}): RadioPermissionController {
  if (Platform.OS === 'android') {
    const bridge: NativeRadioPermissionBridge = {
      check: permission => PermissionsAndroid.check(permission as Parameters<typeof PermissionsAndroid.check>[0]),
      requestMultiple: permissions => PermissionsAndroid.requestMultiple(
        [...permissions] as Parameters<typeof PermissionsAndroid.requestMultiple>[0],
      ),
    };
    return new RadioPermissionController({ platform: 'android', apiLevel: Platform.Version, bridge });
  }
  if (Platform.OS === 'ios') {
    return new RadioPermissionController({ platform: 'ios', ...options });
  }
  return new RadioPermissionController({ platform: 'unsupported' });
}
