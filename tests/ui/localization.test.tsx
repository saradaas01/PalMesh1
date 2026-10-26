import React from 'react';
import { describe, expect, jest, test } from '@jest/globals';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { I18nManager, Pressable, Text, View } from 'react-native';
import type { ChatSnapshot } from '../../src/features/chat/domain/types';
import type { ChatUiService } from '../../src/features/chat/ui/ChatProvider';
import { PalMeshChatApp } from '../../src/features/chat/ui/PalMeshChatApp';
import { ar, en, I18nProvider, reportAge, translate, useI18n, type Language, type LanguagePreferences, type TranslationKey } from '../../src/shared/i18n';

function LanguageProbe(): React.JSX.Element {
  const { language, direction, setLanguage, restartRequired, storageError, t } = useI18n();
  return <View testID="language-direction" style={{ direction }}>
    <Text testID="current-language">{language}</Text>
    <Text>{t('chat.messages')}</Text>
    <Pressable accessibilityRole="button" accessibilityLabel="Arabic" onPress={() => { void setLanguage('ar'); }}><Text>Arabic</Text></Pressable>
    <Pressable accessibilityRole="button" accessibilityLabel="English" onPress={() => { void setLanguage('en'); }}><Text>English</Text></Pressable>
    {restartRequired && <Text>{t('common.restartRtl')}</Text>}
    {storageError && <Text>{t('common.languageError')}</Text>}
  </View>;
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(reason: Error): void } {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  return { promise: new Promise<T>((yes, no) => { resolve = yes; reject = no; }), resolve: value => resolve(value), reject: error => reject(error) };
}

describe('offline English and Arabic language selection', () => {
  test('has a nonempty Arabic translation for every shipped key and resolves all declared interpolation parameters', () => {
    expect(Object.keys(ar).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en) as TranslationKey[]) {
      const parameters: Record<string, string> = {};
      for (const template of [en[key], ar[key]]) {
        for (const match of template.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/gu)) parameters[match[1]!] = '7';
      }
      for (const language of ['en', 'ar'] as const) {
        const text = translate(language, key, parameters);
        expect(text.trim().length).toBeGreaterThan(0);
        expect(text).not.toMatch(/\{[A-Za-z]/u);
      }
    }
    expect(translate('ar', 'maps.coordinates', { latitude: '31.50000', longitude: '34.47000' })).toContain('31.50000');
    expect(() => translate('ar', 'common.peerId')).toThrow('Missing translation parameter: id');
  });

  test('switches translated content and explicit RTL immediately, persists it locally, and reports native restart requirements', async () => {
    let saved: Language | null = null;
    const preferences: LanguagePreferences = { read: async () => saved, write: async value => { saved = value; } };
    const forceRtl = jest.spyOn(I18nManager, 'forceRTL');
    const view = await render(<I18nProvider preferences={preferences}><LanguageProbe /></I18nProvider>);
    await fireEvent.press(screen.getByRole('button', { name: 'Arabic' }));
    expect(saved).toBe('ar');
    expect(screen.getByText('الرسائل')).toBeOnTheScreen();
    expect(screen.getByTestId('language-direction')).toHaveStyle({ direction: 'rtl' });
    expect(forceRtl).toHaveBeenLastCalledWith(true);
    if (!I18nManager.isRTL) expect(screen.getByText(ar['common.restartRtl'])).toBeOnTheScreen();
    await view.unmount();
    await render(<I18nProvider preferences={preferences}><LanguageProbe /></I18nProvider>);
    expect(screen.getByTestId('current-language')).toHaveTextContent('ar');
  });

  test('does not let a slow startup preference read replace a deliberate new selection', async () => {
    const pending = deferred<Language | null>();
    const preferences: LanguagePreferences = { read: () => pending.promise, write: async () => {} };
    await render(<I18nProvider preferences={preferences}><LanguageProbe /></I18nProvider>);
    await fireEvent.press(screen.getByRole('button', { name: 'Arabic' }));
    await act(async () => { pending.resolve('en'); });
    expect(screen.getByTestId('current-language')).toHaveTextContent('ar');
  });

  test('keeps the last committed language active when a later preference write fails', async () => {
    const firstWrite = deferred<void>();
    const write = jest.fn<(language: Language) => Promise<void>>()
      .mockImplementationOnce(() => firstWrite.promise)
      .mockRejectedValueOnce(new Error('local storage unavailable'));
    const preferences: LanguagePreferences = { read: async () => 'en', write };
    await render(<I18nProvider preferences={preferences}><LanguageProbe /></I18nProvider>);
    await fireEvent.press(screen.getByRole('button', { name: 'Arabic' }));
    await fireEvent.press(screen.getByRole('button', { name: 'English' }));
    expect(write).toHaveBeenCalledTimes(1);
    await act(async () => { firstWrite.resolve(); });
    expect(write).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('current-language')).toHaveTextContent('ar');
    expect(screen.getByText(ar['common.languageError'])).toBeOnTheScreen();
  });

  test('renders Arabic report age independently from a peer connection claim', () => {
    const t = (key: TranslationKey, parameters?: Readonly<Record<string, string | number>>): string => translate('ar', key, parameters);
    expect(reportAge(1_000_000, 1_000_000, t)).toBe('الآن');
    expect(reportAge(1_000_000, 1_180_000, t)).toBe('قبل 3 دقائق');
    expect(reportAge(1_100_000, 1_000_000, t)).toBe('الآن');
  });

  test('keeps the Arabic SOS action within two taps from the recipient modal with an explicit screen reader label', async () => {
    const snapshot: ChatSnapshot = {
      status: 'ready', conversations: [], messages: [], selectedConversationId: null, connectedPeers: [],
      draft: '', pendingSend: false, pendingSos: false, hasOlderMessages: false, issue: null, notice: null, now: 1_800_000_000_000,
    };
    const sendSos = jest.fn<ChatUiService['sendSos']>().mockResolvedValue({ status: 'queued', messageId: 'sos' });
    const service: ChatUiService = {
      deviceId: 'device-local', getSnapshot: () => snapshot, subscribe: () => () => {}, start: async () => {}, stop: async () => {},
      setVisible: () => {}, openConversation: async () => {}, closeConversation: () => {}, setDraft: () => {},
      send: async () => ({ status: 'rejected', reason: 'empty' }), sendSos, loadOlder: async () => {}, refresh: async () => {},
      dismissIssue: () => {}, dismissNotice: () => {},
    };
    await render(<I18nProvider initialLanguage="ar"><PalMeshChatApp service={service} /></I18nProvider>);
    await fireEvent.press(screen.getByRole('button', { name: ar['chat.new'] }));
    await fireEvent.press(screen.getByRole('button', { name: ar['chat.closeNew'] }));
    const sos = screen.getByRole('button', { name: ar['common.sos'] });
    expect(sos).toHaveStyle({ minHeight: 68 });
    await fireEvent.press(sos);
    expect(sendSos).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(en['chat.emptyConversations'])).toBeNull();
  });
});
