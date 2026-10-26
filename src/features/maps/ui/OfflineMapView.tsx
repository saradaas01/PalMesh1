import React, { useEffect, useMemo, useRef, useState } from 'react';
import { NativeModules, Platform, Pressable, StyleSheet, View } from 'react-native';
import { Camera, GeoJSONSource, Layer, Map, NetworkManager, type CameraRef, type MapRef, type StyleSpecification } from '@maplibre/maplibre-react-native';
import { LocalizedText as Text, useI18n } from '../../../shared/i18n';
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
  const { t } = useI18n();
  const map = useRef<MapRef>(null);
  const camera = useRef<CameraRef>(null);
  const zoomBusy = useRef<number | null>(null);
  const lastCenter = useRef<readonly [number, number] | null>(null);
  const cameraMoves = useRef(0);
  const [prepared, setPrepared] = useState(false);
  const [rendered, setRendered] = useState(false);
  const ready = useRef(false);
  const generation = useRef(0);
  const busy = useRef<number | null>(null);
  const settled = useRef(false);
  const alive = useRef(false);
  const lastProbe = useRef(0);
  useEffect(() => {
    generation.current += 1;
    alive.current = true;
    settled.current = false;
    lastCenter.current = null; cameraMoves.current = 0;
    ready.current = false;
    setRendered(false);
    setPrepared(false);
    try {
      // Android's internet reachability otherwise suppresses even loopback HTTP.
      // This is only the SDK scheduler hint, never a device/network setting.
      // buildOfflineStyle admits exclusively tokenized 127.0.0.1 resources.
      buildOfflineStyle(descriptor); // Fail closed before enabling local resource scheduling.
      if (Platform.OS === 'android') NetworkManager.setConnected(true);
      setPrepared(true);
    } catch { onUnavailable(); }
    const timeout = setTimeout(() => { if (!ready.current) onUnavailable(); }, 30_000);
    return () => { alive.current = false; generation.current += 1; clearTimeout(timeout); };
  }, [descriptor, onUnavailable]);
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
  const inspectRendering = async (): Promise<void> => {
    const diagnostics = NativeModules.PalMeshOfflineMaps?.renderDiagnosticsEnabled === true;
    if (settled.current && !diagnostics) return;
    const cycle = generation.current;
    if (!map.current || !mapStyle || busy.current === cycle || Date.now() - lastProbe.current < 1_000) return;
    busy.current = cycle;
    lastProbe.current = Date.now();
    try {
      const geometryLayers = mapStyle.layers.filter(layer => ['fill', 'line', 'circle'].includes(layer.type)).map(layer => layer.id);
      const roadLayers = mapStyle.layers.filter(layer => layer.type === 'line' && /road|transport|street/i.test(layer['source-layer'] ?? '')).map(layer => layer.id);
      const labelLayers = mapStyle.layers.filter(layer => layer.type === 'symbol').map(layer => layer.id);
      const geometry = await map.current.queryRenderedFeatures({ layers: geometryLayers });
      const roads = diagnostics && roadLayers.length ? await map.current.queryRenderedFeatures({ layers: roadLayers }) : [];
      const labels = diagnostics && labelLayers.length ? await map.current.queryRenderedFeatures({ layers: labelLayers }) : [];
      const zoom = diagnostics ? await map.current.getZoom() : 0;
      const center = diagnostics ? await map.current.getCenter() : null;
      if (!alive.current || cycle !== generation.current) return;
      if (center !== null) {
        const previous = lastCenter.current;
        if (previous && (Math.abs(previous[0] - center[0]) > 1e-7 || Math.abs(previous[1] - center[1]) > 1e-7)) cameraMoves.current += 1;
        lastCenter.current = center;
      }
      if (geometry.length > 0) { ready.current = true; setRendered(true); }
      settled.current = ready.current && (!diagnostics || labelLayers.length === 0 || labels.length > 0);
      const arabic = labels.filter(feature => typeof feature.properties?.['name:ar'] === 'string'
        && /[\u0600-\u06ff]/.test(feature.properties['name:ar'])).length;
      // Native debug builds emit bounded counts, never URLs/tokens, coordinates,
      // feature text or contact identifiers. Release builds make this a no-op.
      if (diagnostics) await NativeModules.PalMeshOfflineMaps?.recordRenderEvidence?.(geometry.length, roads.length, labels.length, arabic, zoom, cameraMoves.current);
    } catch { /* Startup races may precede a style; the deadline still fails honestly. */ }
    finally { if (busy.current === cycle) busy.current = null; }
  };
  useEffect(() => {
    const diagnostics = NativeModules.PalMeshOfflineMaps?.renderDiagnosticsEnabled === true;
    const timer = setInterval(() => { if (!settled.current || diagnostics) void inspectRendering(); }, 1_000);
    const stop = setTimeout(() => clearInterval(timer), diagnostics ? 60_000 : 30_000);
    return () => { clearInterval(timer); clearTimeout(stop); };
  }, [mapStyle]);
  // Stable props keep unrelated report-clock updates from reapplying native
  // camera constraints while the user is interacting with the map.
  const bounds = useMemo<[number, number, number, number]>(() => [...descriptor.bounds], [descriptor]);
  const initialViewState = useMemo(() => ({ bounds, padding: { top: 24, right: 24, bottom: 24, left: 24 } }), [bounds]);
  const maxZoom = Math.min(22, descriptor.maxZoom + 4);
  const changeZoom = async (delta: number): Promise<void> => {
    const cycle = generation.current;
    if (!map.current || !camera.current || zoomBusy.current === cycle) return;
    zoomBusy.current = cycle;
    try {
      const current = await map.current.getZoom();
      if (!Number.isFinite(current)) throw new Error('Invalid native zoom');
      if (alive.current && cycle === generation.current) {
        camera.current?.zoomTo(Math.max(descriptor.minZoom, Math.min(maxZoom, current + delta)), { duration: 200 });
      }
    } catch { if (alive.current && cycle === generation.current) onUnavailable(); }
    finally { if (zoomBusy.current === cycle) zoomBusy.current = null; }
  };
  if (mapStyle === null || !prepared) return <View style={styles.map} />;
  return (
    <View style={styles.map}>
    <Map key={descriptor.tileUrlTemplate} ref={map} style={styles.map} mapStyle={mapStyle} attribution={false} logo={false}
      compass={false} dragPan={true} touchZoom={true} doubleTapZoom={true} touchRotate={false} touchPitch={false}
      preferredFramesPerSecond={powerMode === 'conserve' ? 15 : 30}
      onDidFailLoadingMap={onUnavailable} onDidFinishRenderingMapFully={() => { void inspectRendering(); }}
      onRegionDidChange={() => { void inspectRendering(); }}>
      <Camera ref={camera} initialViewState={initialViewState} maxBounds={bounds}
        minZoom={descriptor.minZoom} maxZoom={maxZoom} />
      <GeoJSONSource id="palmesh-location-reports" data={points}>
        <Layer id="palmesh-location-markers" type="circle" paint={{
          'circle-radius': 7,
          'circle-color': ['match', ['get', 'origin'], 'local', '#55c9ff', 'sos', '#ff6675', '#ffe071'],
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
        }} />
      </GeoJSONSource>
    </Map>
    <Text pointerEvents="none" style={styles.status}>{t(rendered ? 'maps.offlineReady' : 'maps.offlineLoading')}</Text>
    <View style={styles.zoomControls} pointerEvents="box-none">
      {([1, -1] as const).map(delta => <Pressable key={delta} accessibilityRole="button"
        accessibilityLabel={t(delta === 1 ? 'maps.zoomIn' : 'maps.zoomOut')}
        accessibilityState={{ disabled: !rendered }} disabled={!rendered}
        onPress={() => { void changeZoom(delta); }} style={styles.zoomButton}>
        <Text style={styles.zoomText}>{delta === 1 ? '+' : '−'}</Text>
      </Pressable>)}
    </View>
    </View>
  );
}

const styles = StyleSheet.create({ map: { flex: 1, backgroundColor: '#172430' },
  status: { position: 'absolute', top: 4, left: 4, right: 4, color: '#ffffff', backgroundColor: '#172430', fontSize: 12 },
  zoomControls: { position: 'absolute', right: 8, bottom: 8, gap: 4 },
  zoomButton: { minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 6, backgroundColor: '#164c74', borderWidth: 1, borderColor: '#ffffff' },
  zoomText: { color: '#ffffff', fontSize: 24, fontWeight: '700' } });
