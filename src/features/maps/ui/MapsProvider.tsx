import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import type { PowerMode } from '../../dtn/domain/types';
import type { LocationService } from '../application/LocationService';

export type MapsUiService = Pick<LocationService,
  'deviceId' | 'getSnapshot' | 'subscribe' | 'start' | 'stop' | 'setVisible' | 'refresh' |
  'refreshLocal' | 'shareOnce' | 'setSharing' | 'setPowerMode' | 'sendSos' | 'dismissIssue' | 'dismissNotice'>;

const MapsContext = createContext<{ readonly service: MapsUiService; readonly visible: boolean } | null>(null);

export interface MapsProviderProps {
  readonly service: MapsUiService;
  readonly children: React.ReactNode;
  readonly visible?: boolean;
  readonly manageLifecycle?: boolean;
  readonly manageVisibility?: boolean;
}

export function MapsProvider({ service, children, visible = true, manageLifecycle = true, manageVisibility = true }: MapsProviderProps): React.JSX.Element {
  const routeVisible = useRef(visible);
  const appActive = useRef(AppState.currentState === 'active');
  const [active, setActive] = useState(appActive.current);
  useEffect(() => {
    routeVisible.current = visible;
    if (manageVisibility) service.setVisible(visible && appActive.current);
  }, [service, visible, manageVisibility]);
  useEffect(() => {
    const subscription = manageVisibility ? AppState.addEventListener('change', state => {
      appActive.current = state === 'active';
      setActive(appActive.current);
      service.setVisible(routeVisible.current && appActive.current);
    }) : null;
    appActive.current = AppState.currentState === 'active';
    setActive(appActive.current);
    if (manageVisibility) service.setVisible(routeVisible.current && appActive.current);
    if (manageLifecycle) void service.start();
    return () => {
      subscription?.remove();
      if (manageLifecycle) void service.stop();
    };
  }, [service, manageLifecycle, manageVisibility]);
  const context = useMemo(() => ({ service, visible: visible && (!manageVisibility || active) }), [service, visible, active, manageVisibility]);
  return <MapsContext.Provider value={context}>{children}</MapsContext.Provider>;
}

export function useMaps() {
  const context = useContext(MapsContext);
  if (context === null) throw new Error('useMaps must be used inside MapsProvider.');
  const { service, visible } = context;
  const subscribe = useCallback((listener: () => void) => service.subscribe(listener), [service]);
  const getSnapshot = useCallback(() => service.getSnapshot(), [service]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const actions = useMemo(() => ({
    refresh: (options?: Parameters<LocationService['refresh']>[0]) => service.refresh(options),
    refreshLocal: () => service.refreshLocal(),
    shareOnce: () => service.shareOnce(),
    setSharing: (sharing: boolean) => service.setSharing(sharing),
    setPowerMode: (mode: PowerMode) => service.setPowerMode(mode),
    sendSos: () => service.sendSos(),
    dismissIssue: () => service.dismissIssue(),
    dismissNotice: () => service.dismissNotice(),
  }), [service]);
  return { snapshot, deviceId: service.deviceId, visible, ...actions };
}
