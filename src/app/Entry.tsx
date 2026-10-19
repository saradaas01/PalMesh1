import React from 'react';
import { NativeModules } from 'react-native';
import { NativeSecurityVault } from '../features/security';
import { I18nProvider, type LanguagePreferences } from '../shared/i18n';
import { AppRuntime } from './application/AppRuntime';
import { createReactNativeRadioPermissions } from './infrastructure/reactNativePermissions';
import { createReactNativeMeshRuntime } from './infrastructure/reactNativeRuntime';
import { PalMeshApp } from './ui/PalMeshApp';

const permissions = createReactNativeRadioPermissions({
  ...(NativeModules.PalMeshBluetoothAuthorization ? { iosBluetoothAuthorization: NativeModules.PalMeshBluetoothAuthorization } : {}),
});
const platformRuntime = createReactNativeMeshRuntime();
// Delay vault construction until the provider's asynchronous boundary. An
// absent native module becomes a recoverable preference/startup error.
const languagePreferences: LanguagePreferences = {
  async read() {
    const value = await new NativeSecurityVault(NativeModules.PalMeshSecurity).read('language-v1');
    if (value === null || value === 'en' || value === 'ar') return value;
    throw new Error('Unsupported saved language');
  },
  async write(language) { await new NativeSecurityVault(NativeModules.PalMeshSecurity).write('language-v1', language); },
};
const runtime = new AppRuntime({
  permissions,
  platformRuntime,
  initiallyForeground: false,
  createResources: async () => {
    // Native storage initialization errors reach the startup screen instead of
    // crashing before the user can retry. Secure entropy is loaded by index.js.
    const { createNativeResources } = await import('./infrastructure/createNativeResources');
    return createNativeResources({ permissions, alerts: platformRuntime });
  },
});

export default function Entry(): React.JSX.Element {
  return <I18nProvider preferences={languagePreferences}><PalMeshApp runtime={runtime} /></I18nProvider>;
}
