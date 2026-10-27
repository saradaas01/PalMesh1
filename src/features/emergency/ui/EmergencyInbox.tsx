import { Disclosure, ui } from '../../../shared/ui/design';
import { useContactNames } from '../../contacts/ContactNames';
import React, { useSyncExternalStore } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { LocalizedText, reportAge, useI18n } from '../../../shared/i18n';
import type { EmergencyService } from '../application/EmergencyService';
import type { EmergencyEntry } from '../domain/types';

export type EmergencyUiService = Pick<EmergencyService, 'getSnapshot' | 'subscribe' | 'refresh' | 'respond' | 'dismiss'>;

/** An inline route, rather than an interrupting modal. The application keeps
 * its global SOS action mounted while users review or respond to emergencies. */
export function EmergencyInbox({ service }: { readonly service: EmergencyUiService }): React.JSX.Element {
  const snapshot = useSyncExternalStore(service.subscribe, service.getSnapshot, service.getSnapshot);
  const { t, rowStyle } = useI18n();
  return <View style={[styles.container, rowStyle]}>
    <LocalizedText accessibilityRole="header" style={styles.title}>{t('emergency.title')}</LocalizedText>
    <LocalizedText style={styles.explanation}>{t('ui.sosHint')}</LocalizedText>
    <Disclosure title={t('ui.sosInfo')}><LocalizedText style={ui.muted}>{t('emergency.noGuarantee')}</LocalizedText></Disclosure>
    {snapshot.status === 'loading' && <LocalizedText accessibilityLiveRegion="polite" style={styles.text}>{t('emergency.loading')}</LocalizedText>}
    {snapshot.issue !== null && <View style={styles.issue}>
      <LocalizedText accessibilityRole="alert" style={styles.text}>{t('emergency.problem')}</LocalizedText>
      <Pressable accessibilityRole="button" onPress={() => { void service.refresh(); }} style={styles.button}>
        <LocalizedText style={styles.buttonText}>{t('emergency.retry')}</LocalizedText>
      </Pressable>
    </View>}
    <FlatList data={snapshot.entries} keyExtractor={entry => entry.id}
      ListEmptyComponent={snapshot.status === 'ready' ? <LocalizedText style={styles.text}>{t('emergency.empty')}</LocalizedText> : undefined}
      renderItem={({ item }) => <EmergencyCard entry={item} now={snapshot.now}
        pending={snapshot.pendingResponseIds.includes(item.id)} service={service} />} />
  </View>;
}

export function EmergencyBanner({ service, onOpen }: {
  readonly service: EmergencyUiService; readonly onOpen: () => void;
}): React.JSX.Element | null {
  const snapshot = useSyncExternalStore(service.subscribe, service.getSnapshot, service.getSnapshot);
  const { t, rowStyle } = useI18n();
  if (snapshot.urgent === null) return null;
  return <View style={[styles.banner, rowStyle]}>
    <LocalizedText accessibilityRole="alert" accessibilityLiveRegion="assertive" style={styles.bannerTitle}>{t('emergency.urgent')}</LocalizedText>
    <Pressable accessibilityRole="button" onPress={onOpen} style={styles.button}>
      <LocalizedText style={styles.buttonText}>{t('emergency.open')}</LocalizedText>
    </Pressable>
  </View>;
}

function EmergencyCard({ entry, now, pending, service }: {
  readonly entry: EmergencyEntry; readonly now: number; readonly pending: boolean; readonly service: EmergencyUiService;
}): React.JSX.Element {
  const { t } = useI18n();
  const names=useContactNames();
  const expired = entry.expiresAt <= now;
  return <View style={styles.card}>
    <LocalizedText accessibilityRole="header" style={styles.cardTitle}>{t(entry.outgoing ? 'emergency.outgoing' : 'emergency.incoming')}</LocalizedText>
    <LocalizedText selectable style={styles.text}>{t('emergency.from', { source: names.label(entry.source) })}</LocalizedText>
    <LocalizedText style={styles.dim}>{t('emergency.age', { age: reportAge(entry.receivedAt, now, t) })}</LocalizedText>
    <LocalizedText selectable style={styles.body}>{entry.text}</LocalizedText>
    {entry.location !== undefined && <LocalizedText style={styles.dim}>{t('emergency.location')}</LocalizedText>}
    {entry.responses.map(response => <LocalizedText key={response.id} style={styles.response}>
      {t('emergency.responding', { responder: names.label(response.responder) })}
    </LocalizedText>)}
    {entry.responseId !== null && <LocalizedText accessibilityLiveRegion="polite" style={styles.response}>{t('emergency.responseQueued')}</LocalizedText>}
    {expired && <LocalizedText style={styles.dim}>{t('emergency.expired')}</LocalizedText>}
    {!entry.outgoing && entry.responseId === null && !expired && <Pressable accessibilityRole="button"
      accessibilityHint={t('emergency.respondHint')} accessibilityState={{ disabled: pending, busy: pending }}
      disabled={pending} onPress={() => { void service.respond(entry.id); }} style={[styles.button, pending && styles.disabled]}>
      <LocalizedText style={styles.buttonText}>{t('emergency.respond')}</LocalizedText>
    </Pressable>}
    {!entry.outgoing && !entry.dismissed && <Pressable accessibilityRole="button" onPress={() => { void service.dismiss(entry.id); }} style={styles.review}>
      <LocalizedText style={styles.buttonText}>{t('emergency.review')}</LocalizedText>
    </Pressable>}
    {entry.dismissed && <LocalizedText style={styles.dim}>{t('emergency.reviewed')}</LocalizedText>}
  </View>;
}
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F4F7F8', padding: 16 },
  title: { color: '#18343D', fontSize: 26, fontWeight: '800', marginBottom: 8 },
  explanation: { color: '#725318', fontSize: 16, marginBottom: 16 },
  text: { color: '#18343D', fontSize: 16 }, dim: { color: '#536B75', fontSize: 14, marginTop: 6 },
  body: { color: '#18343D', fontSize: 19, marginVertical: 12 },
  card: { backgroundColor: '#18343D', padding: 16, borderWidth: 2, borderColor: '#D84747', borderRadius: 8, marginBottom: 16 },
  cardTitle: { color: '#18343D', fontSize: 21, fontWeight: '700' },
  button: { backgroundColor: '#087F82', minHeight: 52, paddingHorizontal: 14, paddingVertical: 12, justifyContent: 'center', borderRadius: 6, marginTop: 10 },
  buttonText: { color: '#FFFFFF', fontWeight: '700', fontSize: 17, textAlign: 'center' },
  review: { backgroundColor: '#087F82', minHeight: 48, justifyContent: 'center', borderRadius: 6, padding: 12, marginTop: 8 },
  response: { color: '#087F82', fontSize: 16, marginTop: 8 },
  banner: { backgroundColor: '#FCECEE', padding: 12, borderBottomColor: '#FF7373', borderBottomWidth: 2 },
  bannerTitle: { color: '#18343D', fontSize: 20, fontWeight: '800' },
  issue: { padding: 12, backgroundColor: '#55371A', marginBottom: 12 }, disabled: { opacity: 0.65 },
});
