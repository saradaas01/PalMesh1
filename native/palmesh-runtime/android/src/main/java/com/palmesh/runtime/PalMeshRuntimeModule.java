package com.palmesh.runtime;

import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.service.notification.StatusBarNotification;
import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.common.LifecycleState;
import com.facebook.react.modules.core.DeviceEventManagerModule;

public final class PalMeshRuntimeModule extends ReactContextBaseJavaModule {
    private final Handler main = new Handler(Looper.getMainLooper());
    private boolean registered;
    private volatile boolean invalidated;
    private volatile int listeners;
    private long lastAudibleEmergency = -10_000;

    private final BroadcastReceiver receiver = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            if (MeshForegroundService.ACTION_STATE.equals(intent.getAction())) {
                WritableMap event = Arguments.createMap();
                event.putString("type", "background");
                event.putBoolean("running", intent.getBooleanExtra("running", false));
                event.putString("reason", intent.getStringExtra("reason"));
                emit(event);
            } else {
                WritableMap event = Arguments.createMap();
                event.putString("type", "battery");
                event.putMap("battery", batteryState());
                emit(event);
            }
        }
    };
    private final BroadcastReceiver batteryReceiver = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            WritableMap event = Arguments.createMap();
            event.putString("type", "battery");
            event.putMap("battery", batteryState());
            emit(event);
        }
    };

    PalMeshRuntimeModule(ReactApplicationContext context) { super(context); }
    @Override public String getName() { return "PalMeshRuntime"; }

    @Override public void initialize() {
        super.initialize();
        IntentFilter filter = new IntentFilter(MeshForegroundService.ACTION_STATE);
        String internal = getReactApplicationContext().getPackageName() + ".permission.PALMESH_INTERNAL";
        IntentFilter batteryFilter = new IntentFilter(Intent.ACTION_BATTERY_CHANGED);
        batteryFilter.addAction(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED);
        if (Build.VERSION.SDK_INT >= 33) {
            getReactApplicationContext().registerReceiver(receiver, filter, internal, main, Context.RECEIVER_NOT_EXPORTED);
            getReactApplicationContext().registerReceiver(batteryReceiver, batteryFilter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            getReactApplicationContext().registerReceiver(receiver, filter, internal, main);
            getReactApplicationContext().registerReceiver(batteryReceiver, batteryFilter);
        }
        registered = true;
    }

    @ReactMethod public void addListener(String eventName) { listeners += 1; }
    @ReactMethod public void removeListeners(double count) { listeners = Math.max(0, listeners - (int) count); }

    @ReactMethod public void checkNotifications(Promise promise) {
        promise.resolve(RuntimeNotifications.allowed(getReactApplicationContext()));
    }

    @ReactMethod public void getBatteryState(Promise promise) { promise.resolve(batteryState()); }

    @ReactMethod public void startMeshService(Promise promise) {
        main.post(() -> {
            if (invalidated) { promise.reject("RUNTIME_CLOSED", "Runtime is closed"); return; }
            if (getReactApplicationContext().getLifecycleState() != LifecycleState.RESUMED) {
                promise.reject("FOREGROUND_REQUIRED", "Enable background connections from the open app"); return;
            }
            if (!RuntimeNotifications.allowed(getReactApplicationContext())) {
                promise.reject("NOTIFICATIONS_DISABLED", "Allow notifications before enabling background connections"); return;
            }
            if (MeshForegroundService.isRunning()) { promise.resolve(null); return; }
            try {
                Intent service = new Intent(getReactApplicationContext(), MeshForegroundService.class);
                if (Build.VERSION.SDK_INT >= 26) getReactApplicationContext().startForegroundService(service);
                else getReactApplicationContext().startService(service);
                awaitService(promise, 50);
            } catch (RuntimeException denied) {
                promise.reject("BACKGROUND_UNAVAILABLE", "Android did not allow the foreground service", denied);
            }
        });
    }

    private void awaitService(Promise promise, int remaining) {
        if (invalidated) { promise.reject("RUNTIME_CLOSED", "Runtime is closed"); return; }
        if (MeshForegroundService.isRunning()) { promise.resolve(null); return; }
        if (remaining == 0) { promise.reject("BACKGROUND_UNAVAILABLE", "Foreground service did not become ready"); return; }
        main.postDelayed(() -> awaitService(promise, remaining - 1), 100);
    }

    @ReactMethod public void stopMeshService(Promise promise) {
        main.post(() -> {
            getReactApplicationContext().stopService(new Intent(getReactApplicationContext(), MeshForegroundService.class));
            // stopService queues onDestroy. Do not resolve while the previous
            // session still reports running: a quick enable could otherwise
            // mistake that dying service for its newly started session.
            awaitServiceStopped(promise, 50);
        });
    }

    private void awaitServiceStopped(Promise promise, int remaining) {
        if (!MeshForegroundService.isRunning()) { promise.resolve(null); return; }
        if (remaining == 0) { promise.reject("BACKGROUND_STOP_TIMEOUT", "Foreground service did not stop"); return; }
        main.postDelayed(() -> awaitServiceStopped(promise, remaining - 1), 100);
    }

    @ReactMethod public synchronized void showEmergencyNotification(String id, Promise promise) {
        if (!validId(id)) { promise.reject("INVALID_ALERT", "Invalid alert identifier"); return; }
        if (!RuntimeNotifications.allowed(getReactApplicationContext())) {
            promise.reject("NOTIFICATIONS_DISABLED", "Emergency notification permission is unavailable"); return;
        }
        try {
            // Use an opaque UUID tag. Never place message content, source IDs or
            // coordinates into notifications, analytics or system logs.
            NotificationManager manager = getReactApplicationContext().getSystemService(NotificationManager.class);
            String tag = "palmesh-sos:" + id;
            java.util.List<StatusBarNotification> outstanding = new java.util.ArrayList<>();
            for (StatusBarNotification notification : manager.getActiveNotifications()) {
                if (notification.getTag() != null && notification.getTag().startsWith("palmesh-sos:")
                    && !tag.equals(notification.getTag())) outstanding.add(notification);
            }
            outstanding.sort(java.util.Comparator.comparingLong(StatusBarNotification::getPostTime));
            while (outstanding.size() >= 4) {
                StatusBarNotification oldest = outstanding.remove(0);
                manager.cancel(oldest.getTag(), oldest.getId());
            }
            long now = SystemClock.elapsedRealtime();
            boolean audible = now - lastAudibleEmergency >= 10_000;
            if (audible) lastAudibleEmergency = now;
            manager.notify(tag, 1, RuntimeNotifications.emergency(getReactApplicationContext(), audible));
            promise.resolve(null);
        } catch (RuntimeException denied) { promise.reject("ALERT_UNAVAILABLE", "Could not show emergency alert", denied); }
    }

    @ReactMethod public void cancelEmergencyNotification(String id, Promise promise) {
        if (!validId(id)) { promise.reject("INVALID_ALERT", "Invalid alert identifier"); return; }
        getReactApplicationContext().getSystemService(NotificationManager.class).cancel("palmesh-sos:" + id, 1);
        promise.resolve(null);
    }

    private static boolean validId(String id) { return id != null && id.matches("[A-Za-z0-9_-]{1,128}"); }

    private WritableMap batteryState() {
        Intent sticky = getReactApplicationContext().registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
        int level = sticky == null ? -1 : sticky.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
        int scale = sticky == null ? -1 : sticky.getIntExtra(BatteryManager.EXTRA_SCALE, -1);
        int status = sticky == null ? -1 : sticky.getIntExtra(BatteryManager.EXTRA_STATUS, -1);
        PowerManager power = getReactApplicationContext().getSystemService(PowerManager.class);
        WritableMap result = Arguments.createMap();
        if (level < 0 || scale <= 0) result.putNull("level");
        else result.putDouble("level", Math.min(1.0, Math.max(0.0, (double) level / scale)));
        result.putBoolean("charging", status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL);
        result.putBoolean("lowPower", power != null && power.isPowerSaveMode());
        return result;
    }

    private void emit(WritableMap event) {
        if (invalidated || listeners == 0 || !getReactApplicationContext().hasActiveReactInstance()) return;
        getReactApplicationContext().getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
            .emit("PalMeshRuntimeEvent", event);
    }

    @Override public void invalidate() {
        invalidated = true;
        if (registered) {
            getReactApplicationContext().unregisterReceiver(receiver);
            getReactApplicationContext().unregisterReceiver(batteryReceiver);
            registered = false;
        }
        getReactApplicationContext().stopService(new Intent(getReactApplicationContext(), MeshForegroundService.class));
        super.invalidate();
    }
}
