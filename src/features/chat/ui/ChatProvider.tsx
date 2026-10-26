import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import type { ChatService } from '../application/ChatService';

/** The UI depends only on the application's public contract, never a radio or database. */
export type ChatUiService = Pick<ChatService,
  'deviceId' | 'start' | 'stop' | 'setVisible' | 'subscribe' | 'getSnapshot' | 'openConversation' |
  'closeConversation' | 'setDraft' | 'send' | 'sendSos' | 'loadOlder' | 'refresh' |
  'dismissIssue' | 'dismissNotice'>;

const ChatContext = createContext<ChatUiService | null>(null);

export interface ChatProviderProps {
  readonly service: ChatUiService;
  readonly children: React.ReactNode;
  /** The host navigation route must also be visible before messages become read. */
  readonly visible?: boolean;
  /** Set false when a containing runtime owns feature startup/shutdown. */
  readonly manageLifecycle?: boolean;
  /** Set false when that runtime already applies foreground and route focus. */
  readonly manageVisibility?: boolean;
}

export function ChatProvider({ service, children, visible = true, manageLifecycle = true, manageVisibility = true }: ChatProviderProps): React.JSX.Element {
  const routeVisible = useRef(visible);
  const appActive = useRef(AppState.currentState === 'active');
  useEffect(() => {
    routeVisible.current = visible;
    if (manageVisibility) service.setVisible(visible && appActive.current);
  }, [service, visible, manageVisibility]);
  useEffect(() => {
    const subscription = manageVisibility ? AppState.addEventListener('change', state => {
      appActive.current = state === 'active';
      service.setVisible(routeVisible.current && appActive.current);
    }) : null;
    // Unknown initial native state is conservative: archive in the background,
    // but do not consume unread messages until the screen is known to be active.
    appActive.current = AppState.currentState === 'active';
    if (manageVisibility) service.setVisible(routeVisible.current && appActive.current);
    // start/stop own chat subscriptions; the composition root owns the mesh engine.
    if (manageLifecycle) void service.start();
    return () => {
      subscription?.remove();
      if (manageLifecycle) void service.stop();
    };
  }, [service, manageLifecycle, manageVisibility]);
  return <ChatContext.Provider value={service}>{children}</ChatContext.Provider>;
}

export function useChat() {
  const service = useContext(ChatContext);
  if (service === null) throw new Error('useChat must be used inside ChatProvider.');
  const subscribe = useCallback((listener: () => void) => service.subscribe(listener), [service]);
  const getSnapshot = useCallback(() => service.getSnapshot(), [service]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const actions = useMemo(() => ({
    openConversation: (id: string) => service.openConversation(id),
    closeConversation: () => service.closeConversation(),
    setDraft: (text: string) => service.setDraft(text),
    send: () => service.send(),
    sendSos: () => service.sendSos(),
    loadOlder: () => service.loadOlder(),
    refresh: () => service.refresh(),
    dismissIssue: () => service.dismissIssue(),
    dismissNotice: () => service.dismissNotice(),
  }), [service]);
  return { snapshot, deviceId: service.deviceId, ...actions };
}
