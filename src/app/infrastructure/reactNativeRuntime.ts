import { NativeEventEmitter, NativeModules, PermissionsAndroid, Platform } from 'react-native';
import { NativeMeshRuntime, type NativeMeshRuntimeModule } from './NativeMeshRuntime';

interface IosRuntimeModule extends NativeMeshRuntimeModule { requestNotifications?(): Promise<boolean> }

/** Construction and read-only checks never display permission prompts. */
export function createReactNativeMeshRuntime(): NativeMeshRuntime {
  const bridge = NativeModules.PalMeshRuntime as IosRuntimeModule | undefined;
  const platform = Platform.OS === 'android' || Platform.OS === 'ios' ? Platform.OS : 'unsupported';
  return new NativeMeshRuntime({
    platform,
    ...(bridge ? { bridge, events: new NativeEventEmitter(bridge) } : {}),
    notifications: {
      async request() {
        if (platform === 'android' && Number(Platform.Version) >= 33) {
          await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
        } else if (platform === 'ios') await bridge?.requestNotifications?.();
      },
    },
  });
}
