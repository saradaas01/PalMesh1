import React, { useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, TextInput, View } from 'react-native';
import { LocalizedText as Text, useI18n } from '../../shared/i18n';
import type { AppSnapshot } from '../domain/types';
import type { AppUiRuntime } from './PalMeshApp';

const MAX_CONTACT_TEXT = 2048;

/** Identity exchange is deliberately inline: opening the keyboard, importing
 * a contact or changing settings never covers the global emergency action. */
export function SecurityScreen({ runtime, snapshot }: {
  readonly runtime: AppUiRuntime;
  readonly snapshot: AppSnapshot;
}): React.JSX.Element {
  const { t, language, setLanguage, storageError, restartRequired, rowStyle, textStyle } = useI18n();
  const [contactText, setContactText] = useState('');
  const [importing, setImporting] = useState(false);
  const [importedId, setImportedId] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const importBusy = useRef(false);
  const security = snapshot.resources?.security;
  const saveContact = async (): Promise<void> => {
    if (importBusy.current || security === undefined) return;
    importBusy.current = true;
    setImporting(true); setFailed(false); setImportedId(null);
    try {
      if (contactText.length === 0 || contactText.length > MAX_CONTACT_TEXT) throw new Error('Contact text is oversized or empty');
      // Parsing only bounds allocation. The security service validates the
      // complete unmodified record, keys and resulting fingerprint before use.
      const candidate: unknown = JSON.parse(contactText);
      const id = await security.importPeer(candidate);
      setImportedId(id); setContactText('');
    } catch { setFailed(true); }
    finally { importBusy.current = false; setImporting(false); }
  };
  return <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
    <Text accessibilityRole="header" style={styles.title}>{t('app.security')}</Text>
    <Text style={styles.warning}>{t('app.securityLimitations')}</Text>
    <Text style={styles.body}>{t('app.verifyFingerprint')}</Text>
    {security !== undefined && <>
      <Text accessibilityRole="header" style={styles.label}>{t('app.myFingerprint')}</Text>
      <Text selectable accessibilityLabel={t('app.myFingerprint')} style={styles.identifier}>{security.deviceId}</Text>
      <Text accessibilityRole="header" style={styles.label}>{t('app.publicIdentity')}</Text>
      <Text selectable accessibilityLabel={t('app.publicIdentity')} style={styles.identifier}>{JSON.stringify(security.publicIdentity)}</Text>
      <Text accessibilityRole="header" style={styles.label}>{t('app.contactImport')}</Text>
      <TextInput accessibilityLabel={t('app.contactJson')} value={contactText}
        onChangeText={setContactText} multiline maxLength={MAX_CONTACT_TEXT} autoCapitalize="none" autoCorrect={false}
        editable={!importing} style={styles.input} textAlignVertical="top" />
      <Pressable accessibilityRole="button" accessibilityLabel={t('app.importContact')}
        accessibilityState={{ disabled: importing, busy: importing }} disabled={importing}
        onPress={() => { void saveContact(); }} style={[styles.button, importing && styles.disabled]}>
        <Text style={styles.buttonText}>{t('app.importContact')}</Text>
      </Pressable>
      {failed && <Text accessibilityRole="alert" style={styles.warning}>{t('app.invalidContact')}</Text>}
      {importedId !== null && <>
        <Text accessibilityLiveRegion="polite" style={styles.body}>{t('app.importedContact')}</Text>
        <Text selectable style={styles.identifier}>{importedId}</Text>
      </>}
    </>}
    <View style={styles.section}>
      <Text accessibilityRole="header" style={styles.label}>{t('common.language')}</Text>
      <View style={[styles.languages, rowStyle]}>
        {(['en', 'ar'] as const).map(choice => <Pressable key={choice} accessibilityRole="button"
          accessibilityState={{ selected: language === choice }} onPress={() => { void setLanguage(choice); }}
          style={[styles.button, styles.languageButton, language === choice && styles.selected]}>
          <Text style={styles.buttonText}>{t(choice === 'en' ? 'common.english' : 'common.arabic')}</Text>
        </Pressable>)}
      </View>
      {storageError && <Text accessibilityRole="alert" style={styles.warning}>{t('common.languageError')}</Text>}
      {restartRequired && <Text style={styles.body}>{t('common.restartRtl')}</Text>}
    </View>
    <View style={styles.section}>
      <Pressable accessibilityRole="button"
        accessibilityLabel={t(snapshot.alertsBusy ? 'app.alertsBusy' : snapshot.alertsEnabled ? 'app.alertsEnabled' : 'app.alertsEnable')}
        accessibilityState={{ disabled: snapshot.alertsBusy || snapshot.alertsEnabled === true || !snapshot.foreground, busy: snapshot.alertsBusy }}
        disabled={snapshot.alertsBusy || snapshot.alertsEnabled === true || !snapshot.foreground}
        onPress={() => { void runtime.requestAlerts(); }} style={styles.button}>
        <Text style={styles.buttonText}>{t(snapshot.alertsBusy ? 'app.alertsBusy' : snapshot.alertsEnabled ? 'app.alertsEnabled' : 'app.alertsEnable')}</Text>
      </Pressable>
      {snapshot.battery?.level !== null && snapshot.battery?.level !== undefined &&
        <Text style={styles.body}>{t('app.battery')}: {Math.round(snapshot.battery.level * 100)}%</Text>}
      <View style={[styles.setting, rowStyle]}>
        <Text style={[styles.settingLabel, textStyle]}>{t('app.autoPower')}</Text>
        <Switch accessibilityLabel={t('app.autoPower')} value={snapshot.automaticPowerMode}
          onValueChange={automatic => runtime.setAutomaticPowerMode(automatic)} />
      </View>
      <View style={[styles.setting, rowStyle]}>
        <Text style={styles.settingLabel}>{t('app.manualPower')}</Text>
        <Switch accessibilityLabel={t('app.manualPower')} value={snapshot.powerMode === 'conserve'}
          onValueChange={conserve => runtime.setPowerMode(conserve ? 'conserve' : 'normal')} />
      </View>
      {snapshot.backgroundSupported ? <>
        <Text style={styles.body}>{t('app.backgroundConsent')}</Text>
        <Pressable accessibilityRole="button"
          accessibilityLabel={t(snapshot.backgroundBusy ? 'app.backgroundBusy' : snapshot.backgroundEnabled ? 'app.backgroundDisable' : 'app.backgroundEnable')}
          accessibilityState={{ disabled: snapshot.backgroundBusy || !snapshot.foreground, busy: snapshot.backgroundBusy }}
          disabled={snapshot.backgroundBusy || !snapshot.foreground}
          onPress={() => { void runtime.setBackgroundEnabled(!snapshot.backgroundEnabled); }} style={styles.button}>
          <Text style={styles.buttonText}>{t(snapshot.backgroundBusy ? 'app.backgroundBusy' : snapshot.backgroundEnabled ? 'app.backgroundDisable' : 'app.backgroundEnable')}</Text>
        </Pressable>
      </> : <Text style={styles.body}>{t('app.backgroundUnavailable')}</Text>}
    </View>
  </ScrollView>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0a1118' },
  content: { padding: 16, gap: 12 },
  title: { color: '#ffffff', fontSize: 23, fontWeight: '800' },
  label: { color: '#ffffff', fontSize: 18, fontWeight: '700', marginTop: 6 },
  body: { color: '#d2dde8', fontSize: 16, lineHeight: 23 },
  warning: { color: '#ffe1a6', fontSize: 16, lineHeight: 23 },
  identifier: { color: '#cceaff', fontSize: 14, lineHeight: 21, writingDirection: 'ltr', textAlign: 'left' },
  input: { color: '#ffffff', backgroundColor: '#182b3d', minHeight: 110, padding: 12, borderWidth: 1, borderColor: '#80b6d6', borderRadius: 6, fontSize: 16, writingDirection: 'ltr', textAlign: 'left' },
  button: { backgroundColor: '#164c74', minHeight: 48, justifyContent: 'center', padding: 12, borderRadius: 6 },
  buttonText: { color: '#ffffff', fontSize: 16, fontWeight: '700', textAlign: 'center' },
  section: { borderTopWidth: 1, borderColor: '#405264', paddingTop: 16, gap: 12 },
  languages: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  languageButton: { flexGrow: 1 },
  selected: { borderWidth: 2, borderColor: '#87d8ff' },
  setting: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: 48 },
  settingLabel: { color: '#ffffff', fontSize: 16, flex: 1 },
  disabled: { opacity: 0.6 },
});
