import Geolocation from '@react-native-community/geolocation';
import { NativeModules, PermissionsAndroid, Platform } from 'react-native';
import { GeolocationSource, type GeolocationBridge } from './GeolocationSource';
import { NativeOfflineMapSource, type NativeOfflineMapsBridge, type NativeOfflineMapOptions } from './NativeOfflineMapSource';

/** Import only in a linked native host, never from the core feature index.
 * The Android system provider avoids a Google Play Services dependency and
 * never enables background location. GNSS fixes may take longer without AGPS. */
export function createReactNativeLocationSource(): GeolocationSource {
  Geolocation.setRNConfiguration({
    skipPermissionRequests: true, authorizationLevel: 'whenInUse',
    enableBackgroundLocationUpdates: false, locationProvider: 'android',
  });
  return new GeolocationSource({
    bridge: Platform.OS === 'android' ? androidGpsBridge() : Geolocation,
    requestPermission: async () => {
      if (Platform.OS === 'android') {
        if (await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION) || await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION)) return 'granted';
        const granted = await PermissionsAndroid.requestMultiple([
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
          PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION,
        ]);
        return granted[PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION] === PermissionsAndroid.RESULTS.GRANTED
          || granted[PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION] === PermissionsAndroid.RESULTS.GRANTED ? 'granted' : 'denied';
      }
      if (Platform.OS === 'ios') {
        return new Promise<'granted' | 'denied'>(resolve => {
          Geolocation.requestAuthorization(() => resolve('granted'), () => resolve('denied'));
        });
      }
      return 'denied';
    },
  });
}

export function createReactNativeOfflineMapSource(options: NativeOfflineMapOptions = {}): NativeOfflineMapSource {
  // Both native hosts are supplied by native/palmesh-offline-maps. Missing
  // bridges or dataset assets produce an explicit empty state.
  const bridge = NativeModules.PalMeshOfflineMaps as NativeOfflineMapsBridge | undefined;
  return new NativeOfflineMapSource(bridge, options);
}

/** Promise-scoped native requests avoid the library's global watched-provider selection. */
function androidGpsBridge(): GeolocationBridge {
 let serial=0;
 return {watchPosition(success,error,options){const id=++serial;const native=NativeModules.PalMeshLocation;
  if(!native){queueMicrotask(()=>error({code:2}));return id;}
  void native.read(id,Math.max(1,options.timeout-250),options.maximumAge).then(success,(failure:{code?:string})=>error({code:failure.code==='GPS_DENIED'?1:failure.code==='GPS_DISABLED'?4:failure.code==='GPS_TIMEOUT'?3:failure.code==='GPS_CANCELLED'?5:2}));return id;
 },clearWatch(id){NativeModules.PalMeshLocation?.cancel(id);}};
}
