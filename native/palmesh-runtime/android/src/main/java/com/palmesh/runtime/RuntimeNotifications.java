package com.palmesh.runtime;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

final class RuntimeNotifications {
    static final String MESH_CHANNEL = "palmesh-mesh-v1";
    static final String EMERGENCY_CHANNEL = "palmesh-emergency-v1";
    static final int MESH_ID = 27001;

    private RuntimeNotifications() {}

    static boolean allowed(Context context) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        return manager != null && manager.areNotificationsEnabled()
            && (Build.VERSION.SDK_INT < 33 || context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED);
    }

    static void createChannels(Context context) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        NotificationChannel mesh = new NotificationChannel(MESH_CHANNEL,
            context.getString(R.string.palmesh_mesh_channel), NotificationManager.IMPORTANCE_LOW);
        mesh.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
        mesh.setShowBadge(false);
        manager.createNotificationChannel(mesh);
        NotificationChannel emergency = new NotificationChannel(EMERGENCY_CHANNEL,
            context.getString(R.string.palmesh_emergency_channel), NotificationManager.IMPORTANCE_HIGH);
        emergency.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
        manager.createNotificationChannel(emergency);
    }

    static Notification foreground(Context context) {
        createChannels(context);
        Intent stop = new Intent(context, MeshForegroundService.class).setAction(MeshForegroundService.ACTION_STOP);
        PendingIntent stopIntent = PendingIntent.getService(context, 27002, stop,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return builder(context, MESH_CHANNEL)
            .setContentTitle(context.getString(R.string.palmesh_mesh_title))
            .setContentText(context.getString(R.string.palmesh_mesh_body))
            .setCategory(Notification.CATEGORY_SERVICE)
            .setContentIntent(openApp(context, false))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .addAction(new Notification.Action.Builder(null, context.getString(R.string.palmesh_mesh_stop), stopIntent).build())
            .build();
    }

    static Notification emergency(Context context, boolean audible) {
        createChannels(context);
        Notification.Builder notification = builder(context, EMERGENCY_CHANNEL)
            .setContentTitle(context.getString(R.string.palmesh_emergency_title))
            .setContentText(context.getString(R.string.palmesh_emergency_body))
            .setCategory(Notification.CATEGORY_ALARM)
            .setPriority(Notification.PRIORITY_HIGH)
            .setDefaults(audible ? Notification.DEFAULT_ALL : 0)
            .setOnlyAlertOnce(true)
            .setGroup("palmesh-emergencies")
            .setContentIntent(openApp(context, true))
            .setAutoCancel(true);
        // Channel settings control sound on Android 8+. A suppressed child
        // group alert prevents a burst of new UUIDs from repeatedly sounding.
        if (Build.VERSION.SDK_INT >= 26) notification.setGroupAlertBehavior(
            audible ? Notification.GROUP_ALERT_CHILDREN : Notification.GROUP_ALERT_SUMMARY);
        return notification.build();
    }

    private static Notification.Builder builder(Context context, String channel) {
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26
            ? new Notification.Builder(context, channel) : new Notification.Builder(context);
        return builder.setSmallIcon(R.drawable.ic_palmesh_notification)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setShowWhen(true);
    }

    private static PendingIntent openApp(Context context, boolean emergency) {
        Intent launch = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        if (launch == null) throw new IllegalStateException("No launcher activity is registered");
        if (emergency) launch.setData(android.net.Uri.parse("palmesh://emergencies"));
        launch.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(context, emergency ? 27004 : 27003, launch,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}
