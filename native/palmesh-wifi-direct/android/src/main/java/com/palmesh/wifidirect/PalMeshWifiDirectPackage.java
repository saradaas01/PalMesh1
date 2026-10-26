package com.palmesh.wifidirect;

import com.facebook.react.ReactPackage;
import com.facebook.react.bridge.NativeModule;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.uimanager.ViewManager;
import java.util.Collections;
import java.util.Arrays;
import java.util.List;

/** Uses React Native's legacy-module interoperability on the New Architecture. */
public final class PalMeshWifiDirectPackage implements ReactPackage {
    @Override public List<NativeModule> createNativeModules(ReactApplicationContext context) {
        return Arrays.asList(new PalMeshWifiDirectModule(context), new PalMeshBlePeripheralModule(context));
    }

    @Override public List<ViewManager> createViewManagers(ReactApplicationContext context) {
        return Collections.emptyList();
    }
}
