import React from 'react';
import { AppRuntime } from './application/AppRuntime';
import { createReactNativeRadioPermissions } from './infrastructure/reactNativePermissions';
import { PalMeshApp } from './ui/PalMeshApp';

const permissions = createReactNativeRadioPermissions();
const runtime = new AppRuntime({
  permissions,
  initiallyForeground: false,
  createResources: async () => {
    // Native storage initialization errors reach the startup screen instead of
    // crashing before the user can retry. Secure entropy is loaded by index.js.
    const { createNativeResources } = await import('./infrastructure/createNativeResources');
    return createNativeResources({ permissions });
  },
});

export default function Entry(): React.JSX.Element {
  return <PalMeshApp runtime={runtime} />;
}
