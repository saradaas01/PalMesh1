import React, { useEffect, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { Camera, GeoJSONSource, Layer, Map, type StyleSpecification } from '@maplibre/maplibre-react-native';
import type { FeatureCollection, Point } from 'geojson';
import type { LocationFix, PowerMode } from '../../dtn/domain/types';
import { buildOfflineStyle } from '../domain/offlineStyle';
import type { OfflineMapDescriptor, PeerLocation } from '../domain/types';

export interface OfflineMapViewProps {
  readonly descriptor: OfflineMapDescriptor;
  readonly localLocation: LocationFix | null;
  readonly peers: readonly PeerLocation[];
  readonly powerMode: PowerMode;
  readonly onUnavailable: () => void;
}

/** The native renderer is a replaceable UI boundary. It never requests GPS,
 * starts discovery, downloads maps, or selects a default remote map style. */
export function OfflineMapView({ descriptor, localLocation, peers, powerMode, onUnavailable }: OfflineMapViewProps): React.JSX.Element {
  const mapStyle = useMemo<StyleSpecification | null>(() => {
    try { return buildOfflineStyle(descriptor); }
    catch { return null; }
  }, [descriptor]);
  useEffect(() => { if (mapStyle === null) onUnavailable(); }, [mapStyle, onUnavailable]);
  const points = useMemo<FeatureCollection<Point>>(() => ({
    type: 'FeatureCollection',
    features: [
      ...peers.map(peer => ({
        type: 'Feature' as const, id: peer.deviceId,
        geometry: { type: 'Point' as const, coordinates: [peer.location.longitude, peer.location.latitude] },
        properties: { origin: peer.origin },
      })),
      ...(localLocation === null ? [] : [{
        type: 'Feature' as const, id: 'palmesh-local-location',
        geometry: { type: 'Point' as const, coordinates: [localLocation.longitude, localLocation.latitude] },
        properties: { origin: 'local' },
      }]),
    ],
  }), [peers, localLocation]);
  const bounds: [number, number, number, number] = [...descriptor.bounds];
  if (mapStyle === null) return <View style={styles.map} />;
  return (
    <Map style={styles.map} mapStyle={mapStyle} attribution={false} logo={false}
      compass={false} touchRotate={false} touchPitch={false}
      preferredFramesPerSecond={powerMode === 'conserve' ? 15 : 30}
      onDidFailLoadingMap={onUnavailable}>
      <Camera initialViewState={{ bounds, padding: { top: 24, right: 24, bottom: 24, left: 24 } }} maxBounds={bounds}
        minZoom={descriptor.minZoom} maxZoom={Math.min(22, descriptor.maxZoom + 4)} />
      <GeoJSONSource id="palmesh-location-reports" data={points}>
        <Layer id="palmesh-location-markers" type="circle" paint={{
          'circle-radius': 7,
          'circle-color': ['match', ['get', 'origin'], 'local', '#55c9ff', 'sos', '#ff6675', '#ffe071'],
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
        }} />
      </GeoJSONSource>
    </Map>
  );
}

const styles = StyleSheet.create({ map: { flex: 1, backgroundColor: '#172430' } });
