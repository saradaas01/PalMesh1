import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, BackHandler, FlatList, KeyboardAvoidingView, Modal, Platform,
  Pressable, ScrollView, StyleSheet, TextInput, View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView, initialWindowMetrics } from 'react-native-safe-area-context';
import { LocalizedText as Text, useI18n, type TranslationKey } from '../../../shared/i18n';
import { isPeerId } from '../../dtn/domain/validation';
import { deliveryState } from '../domain/messages';
import type { ChatDeliveryState, ChatIssue, ChatMessage, Conversation } from '../domain/types';
import { ChatProvider, type ChatUiService, useChat } from './ChatProvider';

const deliveryLabels: Readonly<Record<ChatDeliveryState, TranslationKey>> = {
  received: 'chat.delivery.received',
  queued: 'chat.delivery.queued',
  'peer-stored': 'chat.delivery.peer-stored',
  'forwarding-ended': 'chat.delivery.forwarding-ended',
  'saved-here': 'chat.delivery.saved-here',
};

const issueLabels: Readonly<Record<ChatIssue, TranslationKey>> = {
  'history-unavailable': 'chat.issue.history-unavailable',
  'queue-full': 'chat.issue.queue-full',
  'send-unavailable': 'chat.issue.send-unavailable',
  'invalid-input': 'chat.issue.invalid-input',
  'routing-error': 'chat.issue.routing-error',
};

function Button({ label, onPress, disabled = false, primary = false }: {
  readonly label: string; readonly onPress: () => void; readonly disabled?: boolean; readonly primary?: boolean;
}): React.JSX.Element {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }}
      disabled={disabled} onPress={onPress}
      style={({ pressed }) => [styles.button, primary && styles.primaryButton, disabled && styles.disabled, pressed && styles.pressed]}>
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

function ConversationRow({ item, onOpen }: {
  readonly item: Conversation; readonly onOpen: (id: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const title = item.id === '*' ? t('chat.broadcasts') : item.id;
  const unread = item.unreadCount > 0 ? `, ${t('chat.unread', { count: item.unreadCount })}` : '';
  return (
    <Pressable accessibilityRole="button"
      accessibilityLabel={`${t('chat.openConversation', { title })}${unread}`}
      onPress={() => onOpen(item.id)} style={({ pressed }) => [styles.conversation, pressed && styles.pressed]}>
      <View style={styles.row}>
        <Text style={[styles.peer, styles.grow]} numberOfLines={2}>{title}</Text>
        {item.unreadCount > 0 && <Text style={styles.badge}>{t('chat.unread', { count: item.unreadCount })}</Text>}
      </View>
      <Text style={styles.secondary} numberOfLines={2}>{item.lastMessage.kind === 'sos' ? 'SOS · ' : ''}{item.lastMessage.text}</Text>
    </Pressable>
  );
}

function MessageBubble({ message, deviceId, now }: {
  readonly message: ChatMessage; readonly deviceId: string; readonly now: number;
}): React.JSX.Element {
  const { t, language } = useI18n();
  const status = t(deliveryLabels[deliveryState(message, deviceId, now)]);
  const time = new Date(message.receivedAt).toLocaleTimeString(language === 'ar' ? 'ar-PS' : 'en', { hour: '2-digit', minute: '2-digit' });
  const sender = message.outgoing ? t('chat.you') : message.source;
  return (
    <View style={[styles.message, message.outgoing ? styles.outgoing : styles.incoming, message.kind === 'sos' && styles.emergencyMessage]}>
      <Text style={styles.messageSender}>{message.kind === 'sos' ? 'SOS · ' : ''}{sender}</Text>
      <Text selectable style={styles.messageText}>{message.text}</Text>
      <Text style={styles.messageMeta}>{time} · {status}</Text>
    </View>
  );
}

function NewConversation({ visible, onClose, savedRecipients }: {
  readonly visible: boolean; readonly onClose: () => void;
  readonly savedRecipients: readonly string[];
}): React.JSX.Element {
  const { t, direction } = useI18n();
  const { openConversation } = useChat();
  const [peerId, setPeerId] = useState('');
  const [invalid, setInvalid] = useState(false);
  const open = (): void => {
    const id = peerId.trim();
    if (!isPeerId(id)) { setInvalid(true); return; }
    void openConversation(id);
    setPeerId('');
    setInvalid(false);
    onClose();
  };
  return (
    <Modal visible={visible} animationType="none" onRequestClose={onClose}>
      <SafeAreaProvider>
        <SafeAreaView style={[styles.safeArea, { direction }]} accessibilityViewIsModal>
          <View style={styles.dialogClose}><Button label={t('chat.closeNew')} onPress={onClose} /></View>
          <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.dialog}>
          <Text accessibilityRole="header" style={styles.title}>{t('chat.new')}</Text>
          <Text style={styles.secondary}>{t('chat.recipientHelp')}</Text>
          <Text style={styles.secondary}>{t('chat.privateSetup')}</Text>
          {savedRecipients.length > 0 && <>
            <Text accessibilityRole="header" style={styles.label}>{t('chat.savedContacts')}</Text>
            <Text style={styles.secondary}>{t('chat.contactTrust')}</Text>
            {savedRecipients.map(id => <Button key={id} label={t('chat.chooseContact', { id })}
              onPress={() => { setPeerId(id); setInvalid(false); }} />)}
          </>}
          <Text style={styles.label}>{t('chat.peerIdLabel')}</Text>
          <TextInput accessibilityLabel={t('chat.recipientId')} autoCapitalize="none" autoCorrect={false}
            maxLength={128} value={peerId} onChangeText={(value) => { setPeerId(value); setInvalid(false); }}
            onSubmitEditing={open} returnKeyType="go" style={[styles.input, styles.peerInput]} />
          {invalid && <Text accessibilityRole="alert" style={styles.errorText}>{t('chat.invalidId')}</Text>}
          <Button label={t('chat.open')} onPress={open} primary />
          <Text style={styles.secondary}>{t('chat.modalSos')}</Text>
            </ScrollView>
          </KeyboardAvoidingView>
        </SafeAreaView>
      </SafeAreaProvider>
    </Modal>
  );
}

export interface ChatScreenProps {
  readonly embedded?: boolean;
  readonly showSos?: boolean;
  readonly savedRecipients?: readonly string[];
}

export function ChatScreen({ embedded = false, showSos = true, savedRecipients = [] }: ChatScreenProps): React.JSX.Element {
  const { t, direction, textStyle } = useI18n();
  const {
    snapshot, deviceId, openConversation, closeConversation, setDraft, send, sendSos,
    loadOlder, refresh, dismissIssue, dismissNotice,
  } = useChat();
  const [newConversation, setNewConversation] = useState(false);
  // Prevent two native presses in the same render before the service publishes pendingSos.
  const sosInFlight = useRef(false);
  const messageList = useRef<FlatList<ChatMessage>>(null);
  const followLatest = useRef(true);
  const selectedId = snapshot.selectedConversationId;
  const isBroadcast = selectedId === '*';
  const directConversations = snapshot.conversations.filter((item) => item.id !== '*');
  const broadcast = snapshot.conversations.find((item) => item.id === '*');
  const broadcastUnread = broadcast?.unreadCount ?? 0;
  useEffect(() => { followLatest.current = true; }, [selectedId]);
  useEffect(() => {
    // BackHandler is a no-op on iOS. Android Modals route back to onRequestClose
    // directly, so this listener only handles the underlying inbox/thread.
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (selectedId === null) return false;
      closeConversation();
      return true;
    });
    return () => subscription.remove();
  }, [selectedId, closeConversation]);
  const requestSos = (): void => {
    if (sosInFlight.current || snapshot.pendingSos) return;
    sosInFlight.current = true;
    void sendSos().finally(() => { sosInFlight.current = false; });
  };
  // A bounded, scrollable feedback panel stays visible after sending while the
  // SOS bar keeps its own layout space, including with large accessibility text.
  const feedback = <>
    {snapshot.issue !== null && <View style={styles.issue}>
      <Text accessibilityRole="alert" accessibilityLiveRegion="assertive" style={styles.bodyText}>{t(issueLabels[snapshot.issue])}</Text>
      <View style={[styles.row, styles.wrap]}>
        {(snapshot.issue === 'history-unavailable' || snapshot.status === 'error') &&
          <Button label={t('chat.retry')} onPress={() => { void refresh(); }} />}
        <Button label={t('chat.dismissError')} onPress={dismissIssue} />
      </View>
    </View>}
    {snapshot.notice !== null && <View style={styles.notice}>
      <Text accessibilityLiveRegion="polite" style={styles.bodyText}>
        {snapshot.notice.kind === 'sos-queued'
          ? t('chat.sosQueued')
          : t('chat.messageQueued')}
      </Text>
      <Button label={t('chat.dismissNotice')} onPress={dismissNotice} />
    </View>}
  </>;

  const Container = embedded ? View : SafeAreaView;
  return (
    <Container style={[styles.safeArea, { direction }]}>
      <KeyboardAvoidingView style={styles.screen} behavior={!embedded && Platform.OS === 'ios' ? 'padding' : undefined}>
        {!embedded && <View style={styles.header}>
          <Text accessibilityRole="header" style={styles.brand}>PalMesh</Text>
          <Text style={styles.secondary}>{t(snapshot.connectedPeers.length === 1 ? 'common.connectedPeer' : 'common.connectedPeers', { count: snapshot.connectedPeers.length })}</Text>
          <Text style={styles.explanation}>{t('common.securityNotice')}</Text>
        </View>}

        {selectedId === null ? <View style={styles.content}>
          <FlatList data={directConversations} keyExtractor={(item) => item.id}
            renderItem={({ item }) => <ConversationRow item={item} onOpen={(id) => { void openConversation(id); }} />}
            keyboardShouldPersistTaps="handled" contentContainerStyle={styles.listContent}
            ListHeaderComponent={<>
              <View style={[styles.sectionHeader, styles.wrap]}>
                <Text accessibilityRole="header" style={styles.title}>{t('chat.messages')}</Text>
                <Button label={t('chat.new')} onPress={() => setNewConversation(true)} primary />
              </View>
              <Text selectable style={styles.deviceId}>{t('common.peerId', { id: deviceId })}</Text>
              <Text style={styles.explanation}>{t('chat.relayDisclaimer')}</Text>
              <Button label={`${t('chat.broadcasts')}${broadcastUnread > 0 ? `, ${t('chat.unread', { count: broadcastUnread })}` : ''}`}
                onPress={() => { void openConversation('*'); }} />
              {snapshot.status === 'loading' && <View style={styles.loading}>
                <ActivityIndicator color="#ffffff" accessibilityLabel={t('chat.loading')} />
                <Text style={styles.secondary}>{t('chat.loadingProgress')}</Text>
              </View>}
              {snapshot.status === 'error' && snapshot.issue === null &&
                <Button label={t('chat.retry')} onPress={() => { void refresh(); }} />}
            </>}
            ListEmptyComponent={snapshot.status === 'ready' ? <Text style={styles.empty}>{t('chat.emptyConversations')}</Text> : undefined} />
        </View> : <View style={styles.content}>
          <View style={styles.sectionHeader}>
            <Button label={t('chat.back')} onPress={closeConversation} />
            <Text accessibilityRole="header" style={[styles.threadTitle, styles.grow]} numberOfLines={2}>{isBroadcast ? t('chat.broadcasts') : selectedId}</Text>
          </View>
          <FlatList ref={messageList} data={snapshot.messages} keyExtractor={(message) => message.id}
            renderItem={({ item }) => <MessageBubble message={item} deviceId={deviceId} now={snapshot.now} />}
            keyboardShouldPersistTaps="handled" contentContainerStyle={styles.listContent}
            maintainVisibleContentPosition={{ minIndexForVisible: 0, autoscrollToTopThreshold: 24 }}
            onScroll={({ nativeEvent }) => {
              followLatest.current = nativeEvent.contentSize.height - nativeEvent.layoutMeasurement.height - nativeEvent.contentOffset.y < 80;
            }}
            scrollEventThrottle={100}
            onContentSizeChange={() => {
              if (followLatest.current) messageList.current?.scrollToEnd({ animated: false });
            }}
            ListHeaderComponent={<>
              <Text style={styles.explanation}>{t('chat.relayDisclaimer')}</Text>
              {snapshot.hasOlderMessages && <Button label={t('chat.older')} onPress={() => { followLatest.current = false; void loadOlder(); }} />}
            </>}
            ListEmptyComponent={<Text style={styles.empty}>{t(isBroadcast ? 'chat.emptyBroadcasts' : 'chat.emptyMessages')}</Text>} />
          <View style={styles.composer}>
            {isBroadcast && <Text style={styles.explanation}>{t('chat.broadcastPrivacy')}</Text>}
            <Text accessibilityLabel={t('chat.length')} style={styles.composerCount}>{snapshot.draft.length}/4096</Text>
            <View style={[styles.row, styles.wrap]}>
              <TextInput accessibilityLabel={t('chat.message')} accessibilityHint={t(isBroadcast ? 'chat.broadcastPrivacy' : 'chat.composeHint')}
                placeholder={t(isBroadcast ? 'chat.broadcastPlaceholder' : 'chat.directPlaceholder')} placeholderTextColor="#b9c5cf" multiline maxLength={4096}
                value={snapshot.draft} onChangeText={setDraft} editable={!snapshot.pendingSend}
                style={[styles.input, textStyle, styles.messageInput]} />
              <Button label={t(snapshot.pendingSend ? 'chat.queueing' : 'chat.send')}
                onPress={() => { void send(); }} disabled={snapshot.pendingSend || snapshot.draft.trim().length === 0} primary />
            </View>
          </View>
        </View>}

        {(snapshot.issue !== null || snapshot.notice !== null) &&
          <ScrollView style={styles.feedback} keyboardShouldPersistTaps="handled">{feedback}</ScrollView>}
        {showSos && <View style={styles.sosContainer}>
          <Pressable accessibilityRole="button" accessibilityLabel={t('common.sos')}
            accessibilityHint={t('common.sosHint')}
            accessibilityState={{ disabled: snapshot.pendingSos, busy: snapshot.pendingSos }}
            disabled={snapshot.pendingSos} onPress={requestSos}
            style={({ pressed }) => [styles.sos, snapshot.pendingSos && styles.disabled, pressed && styles.pressed]}>
            <Text style={styles.sosText}>{t(snapshot.pendingSos ? 'common.queueingSos' : 'common.sos')}</Text>
          </Pressable>
          <Text style={styles.sosHint}>{t('common.sosDisclaimer')}</Text>
        </View>}
      </KeyboardAvoidingView>
      <NewConversation savedRecipients={savedRecipients} visible={newConversation} onClose={() => setNewConversation(false)} />
    </Container>
  );
}

export interface PalMeshChatAppProps {
  readonly service: ChatUiService;
  readonly visible?: boolean;
}

export function PalMeshChatApp({ service, visible = true }: PalMeshChatAppProps): React.JSX.Element {
  return <SafeAreaProvider initialMetrics={initialWindowMetrics}>
    <ChatProvider service={service} visible={visible}><ChatScreen /></ChatProvider>
  </SafeAreaProvider>;
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#0a1118' },
  screen: { flex: 1 },
  content: { flex: 1, minHeight: 0, paddingHorizontal: 16 },
  header: { padding: 16, borderBottomWidth: 1, borderBottomColor: '#405264', flexShrink: 0 },
  brand: { color: '#ffffff', fontSize: 25, fontWeight: '800', writingDirection: 'auto' },
  title: { color: '#ffffff', fontSize: 23, fontWeight: '700', writingDirection: 'auto' },
  threadTitle: { color: '#ffffff', fontSize: 19, fontWeight: '700', writingDirection: 'auto' },
  secondary: { color: '#d2dde8', fontSize: 15, lineHeight: 23, writingDirection: 'auto' },
  explanation: { color: '#b9c5cf', fontSize: 13, marginTop: 4, writingDirection: 'auto' },
  deviceId: { color: '#d2dde8', fontSize: 14, marginBottom: 12, writingDirection: 'auto' },
  // Yoga mirrors logical start/end from the root direction; reversing rows again would undo RTL.
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  wrap: { flexWrap: 'wrap' },
  grow: { flex: 1 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
  button: { minHeight: 48, minWidth: 48, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 12, borderRadius: 8, backgroundColor: '#253545', marginVertical: 3 },
  primaryButton: { backgroundColor: '#124b76' },
  buttonText: { color: '#ffffff', fontSize: 16, fontWeight: '700', textAlign: 'center', writingDirection: 'auto' },
  disabled: { opacity: 0.55 },
  pressed: { opacity: 0.75 },
  conversation: { paddingVertical: 18, borderBottomWidth: 1, borderBottomColor: '#405264', minHeight: 80 },
  peer: { color: '#ffffff', fontSize: 17, fontWeight: '700', writingDirection: 'auto' },
  badge: { color: '#ffffff', backgroundColor: '#124b76', fontSize: 13, padding: 6, borderRadius: 6 },
  listContent: { paddingVertical: 10, gap: 10 },
  empty: { color: '#d2dde8', fontSize: 17, lineHeight: 25, paddingVertical: 22, writingDirection: 'auto' },
  loading: { alignItems: 'center', paddingVertical: 12, gap: 8 },
  message: { maxWidth: '94%', padding: 12, borderRadius: 10, gap: 6 },
  outgoing: { alignSelf: 'flex-end', backgroundColor: '#123c58' },
  incoming: { alignSelf: 'flex-start', backgroundColor: '#253545' },
  emergencyMessage: { borderWidth: 2, borderColor: '#ff6a6a' },
  messageSender: { color: '#e2edf7', fontSize: 13, fontWeight: '700', writingDirection: 'auto' },
  messageText: { color: '#ffffff', fontSize: 18, lineHeight: 27, writingDirection: 'auto' },
  messageMeta: { color: '#d2dde8', fontSize: 12, writingDirection: 'auto' },
  composer: { borderTopWidth: 1, borderTopColor: '#405264', paddingVertical: 8 },
  composerCount: { color: '#b9c5cf', fontSize: 12, textAlign: 'right', marginBottom: 4 },
  input: { minHeight: 48, color: '#ffffff', backgroundColor: '#172430', borderWidth: 1, borderColor: '#8b9eaf', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 12, fontSize: 17, writingDirection: 'auto' },
  messageInput: { flexGrow: 1, flexShrink: 1, flexBasis: 180, minWidth: 100, maxHeight: 144 },
  peerInput: { writingDirection: 'ltr', textAlign: 'left' },
  feedback: { flexGrow: 0, flexShrink: 1, maxHeight: 160 },
  issue: { backgroundColor: '#4a201a', paddingHorizontal: 16, paddingVertical: 8 },
  notice: { backgroundColor: '#183b2a', paddingHorizontal: 16, paddingVertical: 8 },
  bodyText: { color: '#ffffff', fontSize: 15, lineHeight: 23, writingDirection: 'auto' },
  sosContainer: { padding: 12, borderTopWidth: 1, borderTopColor: '#405264', backgroundColor: '#0a1118', flexShrink: 0, zIndex: 1 },
  sos: { backgroundColor: '#b91525', minHeight: 68, justifyContent: 'center', alignItems: 'center', padding: 14, borderRadius: 10, borderWidth: 2, borderColor: '#ff919c' },
  sosText: { color: '#ffffff', fontSize: 23, fontWeight: '800', textAlign: 'center', writingDirection: 'auto' },
  sosHint: { color: '#d2dde8', fontSize: 12, textAlign: 'center', paddingTop: 6, writingDirection: 'auto' },
  dialog: { padding: 20, gap: 14 },
  dialogClose: { paddingHorizontal: 20, paddingTop: 8, flexShrink: 0 },
  label: { color: '#ffffff', fontSize: 17, fontWeight: '700', writingDirection: 'auto' },
  errorText: { color: '#ffb5b5', fontSize: 16, lineHeight: 24, writingDirection: 'auto' },
});
