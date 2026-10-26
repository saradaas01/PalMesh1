import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { I18nManager, Text, type TextProps, type TextStyle, type ViewStyle } from 'react-native';
import { en, type TranslationKey } from './en';
import { ar } from './ar';

export type Language = 'en' | 'ar';
export type TranslationParameters = Readonly<Record<string, string | number>>;
export type Translate = (key: TranslationKey, parameters?: TranslationParameters) => string;

/** Preferences are an injected local port. The UI does not open a database or
 * depend on a network service; a native preferences/vault adapter owns storage. */
export interface LanguagePreferences {
  read(): Promise<Language | null>;
  write(language: Language): Promise<void>;
}

export function translate(language: Language, key: TranslationKey, parameters: TranslationParameters = {}): string {
  const template: string = (language === 'ar' ? ar : en)[key];
  return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/gu, (_match, name: string) => {
    const value = parameters[name];
    if (value === undefined) throw new TypeError(`Missing translation parameter: ${name}`);
    return String(value);
  });
}

export interface I18nValue {
  readonly language: Language;
  readonly direction: 'ltr' | 'rtl';
  readonly textStyle: TextStyle;
  readonly rowStyle: ViewStyle;
  readonly restartRequired: boolean;
  readonly storageError: boolean;
  readonly loading: boolean;
  readonly t: Translate;
  /** A failed persistence write leaves the previously saved language active. */
  readonly setLanguage: (language: Language) => Promise<boolean>;
}

const defaultValue: I18nValue = {
  language: 'en', direction: 'ltr', textStyle: { writingDirection: 'ltr', textAlign: 'left' },
  rowStyle: { direction: 'ltr' }, restartRequired: false, storageError: false, loading: false,
  t: (key, parameters) => translate('en', key, parameters), setLanguage: async () => false,
};
const I18nContext = createContext<I18nValue>(defaultValue);

export function I18nProvider({ children, preferences, initialLanguage = 'en' }: {
  readonly children: React.ReactNode;
  readonly preferences?: LanguagePreferences;
  readonly initialLanguage?: Language;
}): React.JSX.Element {
  const [language, setLanguageState] = useState<Language>(initialLanguage);
  const [storageError, setStorageError] = useState(false);
  const [loading, setLoading] = useState(preferences !== undefined);
  const mounted = useRef(true);
  const selection = useRef(0);
  // Persist choices serially. Two fast taps cannot commit in reverse order and
  // silently restore an older language on the next offline launch.
  const pendingWrite = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => {
    mounted.current = true;
    const version = selection.current;
    let active = true;
    if (preferences !== undefined) {
      void preferences.read().then(saved => {
        if (active && mounted.current && selection.current === version && (saved === 'en' || saved === 'ar')) setLanguageState(saved);
      }).catch(() => { if (active && mounted.current) setStorageError(true); })
        .finally(() => { if (active && mounted.current) setLoading(false); });
    } else setLoading(false);
    return () => { active = false; mounted.current = false; };
  }, [preferences]);
  const setLanguage = useCallback((next: Language): Promise<boolean> => {
    if (next !== 'en' && next !== 'ar') return Promise.resolve(false);
    const version = ++selection.current;
    const write = pendingWrite.current.catch(() => undefined).then(async (): Promise<boolean> => {
      try {
        await preferences?.write(next);
        if (mounted.current) {
          setLanguageState(next);
          if (selection.current === version) setStorageError(false);
        }
        return true;
      } catch {
        if (mounted.current && selection.current === version) setStorageError(true);
        return false;
      }
    });
    pendingWrite.current = write;
    return write;
  }, [preferences]);
  const direction = language === 'ar' ? 'rtl' : 'ltr';
  useEffect(() => {
    if (loading) return;
    // RN's global native layout setting applies on the next process launch.
    // Current screens also receive an explicit Yoga direction immediately.
    I18nManager.allowRTL(true);
    I18nManager.forceRTL(direction === 'rtl');
  }, [direction, loading]);
  const value = useMemo<I18nValue>(() => ({
    language, direction, textStyle: { writingDirection: direction, textAlign: direction === 'rtl' ? 'right' : 'left' },
    rowStyle: { direction }, restartRequired: !loading && I18nManager.isRTL !== (direction === 'rtl'),
    storageError, loading, t: (key, parameters) => translate(language, key, parameters), setLanguage,
  }), [language, direction, loading, storageError, setLanguage]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue { return useContext(I18nContext); }

/** Dynamic font scaling stays enabled. Caller styles may center labels or keep
 * device identifiers left-to-right; translated body text follows the language. */
export function LocalizedText({ style, ...props }: TextProps): React.JSX.Element {
  const { textStyle, language } = useI18n();
  return <Text {...props} accessibilityLanguage={language === 'ar' ? 'ar-PS' : 'en'} style={[textStyle, style]} />;
}

/** Describe report age without treating it as connection or delivery evidence. */
export function reportAge(timestamp: number, now: number, t: Translate): string {
  const age = Math.max(0, now - timestamp);
  if (age < 60_000) return t('age.now');
  const [count, unit] = age < 3_600_000 ? [Math.floor(age / 60_000), 'minute'] as const
    : age < 86_400_000 ? [Math.floor(age / 3_600_000), 'hour'] as const
      : [Math.floor(age / 86_400_000), 'day'] as const;
  return t(count === 1 ? `age.${unit}` : `age.${unit}s`, { count });
}
