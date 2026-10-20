package com.palmesh.runtime;

import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

/** Raises process priority while the user opts in. The durable DTN engine still
 * belongs to the React Native process; this service never claims delivery after
 * process death and deliberately does not resurrect a missing JavaScript owner. */
public final class MeshForegroundService extends Service {
    static final String ACTION_STOP = "com.palmesh.runtime.STOP_MESH";
    static final String ACTION_STATE = "com.palmesh.runtime.MESH_STATE";
    private static final String ACTION_STOP_RADIOS = "com.palmesh.runtime.STOP_RADIOS";
    private static volatile boolean running;

    static boolean isRunning() { return running; }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            running = false;
            stopRadios();
            broadcast(this, false, "user-stopped");
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
            return START_NOT_STICKY;
        }
        try {
            if (!RuntimeNotifications.allowed(this)) throw new SecurityException("Notifications are disabled");
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(RuntimeNotifications.MESH_ID, RuntimeNotifications.foreground(this),
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
            } else startForeground(RuntimeNotifications.MESH_ID, RuntimeNotifications.foreground(this));
            running = true;
            broadcast(this, true, "started");
        } catch (RuntimeException denied) {
            running = false;
            broadcast(this, false, "unavailable");
            stopSelf();
        }
        return START_NOT_STICKY;
    }

    @Override public void onDestroy() {
        boolean wasRunning = running;
        running = false;
        stopForeground(STOP_FOREGROUND_REMOVE);
        if (wasRunning) {
            stopRadios();
            broadcast(this, false, "stopped");
        }
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    private void stopRadios() {
        sendBroadcast(new Intent(ACTION_STOP_RADIOS).setPackage(getPackageName()),
            getPackageName() + ".permission.PALMESH_INTERNAL");
    }

    private static void broadcast(Context context, boolean active, String reason) {
        // Explicit package scoping plus a non-exported receiver prevents other
        // apps from impersonating runtime stop/start events.
        context.sendBroadcast(new Intent(ACTION_STATE).setPackage(context.getPackageName())
            .putExtra("running", active).putExtra("reason", reason),
            context.getPackageName() + ".permission.PALMESH_INTERNAL");
    }
}
