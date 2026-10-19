// Pure API: UI/native bindings are explicit imports, keeping routing tests free
// of React Native, MapLibre and geolocation module initialization.
export { LocationService } from './application/LocationService';
export type { LocationServiceOptions } from './application/LocationService';
export { SqliteLocationRepository } from './infrastructure/SqliteLocationRepository';
export { GeolocationSource } from './infrastructure/GeolocationSource';
export type { GeolocationBridge, GeolocationSourceOptions } from './infrastructure/GeolocationSource';
export { NativeOfflineMapSource } from './infrastructure/NativeOfflineMapSource';
export type { NativeOfflineMapOptions, NativeOfflineMapsBridge } from './infrastructure/NativeOfflineMapSource';
export { lastSeenLabel, projectPeerLocation, validLocationFix } from './domain/locations';
export { buildOfflineStyle } from './domain/offlineStyle';
export { validateOfflineMapDescriptor } from './domain/offlineMap';
export type { LocationEngine, LocationRepository, LocationSource, OfflineMapSource } from './domain/ports';
export type {
  GpsResult, LocationActionResult, LocationArchive, LocationIssue, MapsSnapshot,
  OfflineMapDescriptor, PeerLocation,
} from './domain/types';
