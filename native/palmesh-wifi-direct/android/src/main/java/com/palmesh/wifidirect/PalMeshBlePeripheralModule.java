package com.palmesh.wifidirect;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattServer;
import android.bluetooth.BluetoothGattServerCallback;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.le.AdvertiseCallback;
import android.bluetooth.le.AdvertiseData;
import android.bluetooth.le.AdvertiseSettings;
import android.bluetooth.le.BluetoothLeAdvertiser;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelUuid;
import android.os.SystemClock;
import android.util.Base64;
import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.LifecycleEventListener;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.modules.core.DeviceEventManagerModule;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Android's BLE peripheral half of the PalMesh radio. react-native-ble-plx
 * provides the central half. GATT callbacks are serialized on main; protocol
 * framing, DTN identity, persistence acknowledgments and encryption remain JS
 * responsibilities. A GATT response/notification completion is not a DTN ACK.
 */
public final class PalMeshBlePeripheralModule extends ReactContextBaseJavaModule
        implements LifecycleEventListener {
    private static final String EVENT = "PalMeshBlePeripheralEvent";
    private static final UUID SERVICE = UUID.fromString("c62d6a00-7e41-4cc2-9d31-c7a81ef11310");
    private static final UUID WRITE = UUID.fromString("c62d6a01-7e41-4cc2-9d31-c7a81ef11310");
    private static final UUID NOTIFY = UUID.fromString("c62d6a02-7e41-4cc2-9d31-c7a81ef11310");
    private static final UUID CCC = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");
    private static final int MAX_LINKS = 8;
    private static final int MAX_OPERATIONS = 64;
    private static final int MAX_CHUNK = 512;

    private final ReactApplicationContext context;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final BluetoothManager manager;
    private final Map<String, Peer> devices = new LinkedHashMap<>();
    private final Map<String, Peer> links = new LinkedHashMap<>();
    private final Map<String, Operation> operations = new HashMap<>();
    private final Map<String, Long> closingAddresses = new HashMap<>();
    private final Set<String> notificationTombstones = new HashSet<>();
    private final ArrayDeque<Operation> notifications = new ArrayDeque<>();
    private BluetoothGattServer server;
    private BluetoothLeAdvertiser advertiser;
    private BluetoothGattCharacteristic notifyCharacteristic;
    private AdvertiseCallback advertisingCallback;
    private BroadcastReceiver receiver;
    private Operation starting;
    private Operation notifying;
    private boolean running;
    private boolean stopping;
    private boolean destroyed;
    private int generation;
    private int listeners;
    private boolean runtimeReceiverRegistered;
    private final BroadcastReceiver runtimeStopReceiver = new BroadcastReceiver() {
        @Override public void onReceive(Context receiverContext, Intent intent) { teardown(null); }
    };

    public PalMeshBlePeripheralModule(ReactApplicationContext context) {
        super(context);
        this.context = context;
        manager = (BluetoothManager) context.getSystemService(Context.BLUETOOTH_SERVICE);
        context.addLifecycleEventListener(this);
    }

    @Override public String getName() { return "PalMeshBlePeripheral"; }

    @Override public void initialize() {
        super.initialize();
        IntentFilter filter = new IntentFilter("com.palmesh.runtime.STOP_RADIOS");
        String permission = context.getPackageName() + ".permission.PALMESH_INTERNAL";
        if (Build.VERSION.SDK_INT >= 33) context.registerReceiver(runtimeStopReceiver, filter, permission, main, Context.RECEIVER_NOT_EXPORTED);
        else context.registerReceiver(runtimeStopReceiver, filter, permission, main);
        runtimeReceiverRegistered = true;
    }

    @ReactMethod public void addListener(String name) { main.post(() -> listeners++); }
    @ReactMethod public void removeListeners(double count) {
        main.post(() -> listeners = Math.max(0, listeners - (int) count));
    }

    private String unavailableReason() {
        if (destroyed || manager == null || !context.getPackageManager()
                .hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE)) return "unsupported";
        if (Build.VERSION.SDK_INT >= 31 &&
                (context.checkSelfPermission("android.permission.BLUETOOTH_ADVERTISE") != PackageManager.PERMISSION_GRANTED
                || context.checkSelfPermission("android.permission.BLUETOOTH_CONNECT") != PackageManager.PERMISSION_GRANTED))
            return "permission-denied";
        try {
            BluetoothAdapter adapter = manager.getAdapter();
            if (adapter == null) return "unsupported";
            if (!adapter.isEnabled()) return "powered-off";
            if (!adapter.isMultipleAdvertisementSupported()) return "unsupported";
            if (adapter.getBluetoothLeAdvertiser() == null) return "unavailable";
            return null;
        } catch (SecurityException error) { return "permission-denied"; }
    }

    @ReactMethod public void getStatus(Promise promise) { main.post(() -> promise.resolve(status())); }

    private WritableMap status() {
        WritableMap value = Arguments.createMap();
        String reason = unavailableReason();
        value.putBoolean("available", reason == null);
        if (reason != null) value.putString("reason", reason);
        return value;
    }

    @ReactMethod public void start(String operationId, Promise promise) {
        main.post(() -> {
            if (stopping) { promise.reject("E_STOPPING", "BLE peripheral is stopping"); return; }
            if (starting != null) { promise.reject("E_STARTING", "BLE peripheral startup is pending"); return; }
            if (running) { promise.resolve(null); return; }
            String reason = unavailableReason();
            if (reason != null) { promise.reject("E_UNAVAILABLE", reason); return; }
            generation++;
            running = true;
            final int epoch = generation;
            Operation op = begin(operationId, promise, 20_000);
            if (op == null) { running = false; return; }
            starting = op;
            try {
                advertiser = manager.getAdapter().getBluetoothLeAdvertiser();
                server = manager.openGattServer(context, callback(epoch));
                if (server == null || advertiser == null) throw new IllegalStateException("BLE GATT hosting unavailable");
                BluetoothGattService service = new BluetoothGattService(SERVICE, BluetoothGattService.SERVICE_TYPE_PRIMARY);
                service.addCharacteristic(new BluetoothGattCharacteristic(WRITE,
                    BluetoothGattCharacteristic.PROPERTY_WRITE, BluetoothGattCharacteristic.PERMISSION_WRITE));
                notifyCharacteristic = new BluetoothGattCharacteristic(NOTIFY,
                    BluetoothGattCharacteristic.PROPERTY_READ | BluetoothGattCharacteristic.PROPERTY_NOTIFY,
                    BluetoothGattCharacteristic.PERMISSION_READ);
                notifyCharacteristic.addDescriptor(new BluetoothGattDescriptor(CCC,
                    BluetoothGattDescriptor.PERMISSION_READ | BluetoothGattDescriptor.PERMISSION_WRITE));
                service.addCharacteristic(notifyCharacteristic);
                registerReceiver(epoch);
                if (!server.addService(service)) throw new IllegalStateException("Cannot publish PalMesh GATT service");
                // Advertising begins in onServiceAdded, after GATT publication.
            } catch (RuntimeException error) {
                fail(op, "E_START", error.getMessage());
                teardown(null);
            }
        });
    }

    private void advertise(int epoch) {
        if (!current(epoch) || starting == null) return;
        advertisingCallback = new AdvertiseCallback() {
            @Override public void onStartSuccess(AdvertiseSettings settings) {
                main.post(() -> { if (current(epoch) && starting != null) succeed(starting, null); });
            }
            @Override public void onStartFailure(int code) {
                main.post(() -> {
                    if (!current(epoch)) return;
                    if (starting != null) fail(starting, "E_ADVERTISE_" + code, "BLE advertising failed (" + code + ")");
                    emitError("BLE advertising failed (" + code + ")");
                    teardown(null);
                });
            }
        };
        try {
            AdvertiseSettings settings = new AdvertiseSettings.Builder()
                .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_BALANCED)
                .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM)
                .setConnectable(true).setTimeout(0).build();
            AdvertiseData data = new AdvertiseData.Builder()
                .addServiceUuid(new ParcelUuid(SERVICE)).setIncludeDeviceName(false)
                .setIncludeTxPowerLevel(false).build();
            advertiser.startAdvertising(settings, data, advertisingCallback);
        } catch (RuntimeException error) {
            if (starting != null) fail(starting, "E_ADVERTISE", error.getMessage());
            teardown(null);
        }
    }

    private BluetoothGattServerCallback callback(int epoch) {
        return new BluetoothGattServerCallback() {
            @Override public void onServiceAdded(int code, BluetoothGattService service) {
                main.post(() -> {
                    if (!current(epoch) || !SERVICE.equals(service.getUuid())) return;
                    if (code == BluetoothGatt.GATT_SUCCESS) advertise(epoch);
                    else {
                        if (starting != null) fail(starting, "E_GATT_SERVICE", "GATT service publication failed");
                        teardown(null);
                    }
                });
            }

            @Override public void onConnectionStateChange(BluetoothDevice device, int code, int state) {
                main.post(() -> {
                    if (!current(epoch)) return;
                    String address = address(device);
                    if (address == null) return;
                    if (state == BluetoothProfile.STATE_CONNECTED && code == BluetoothGatt.GATT_SUCCESS) {
                        Long blockedUntil = closingAddresses.get(address);
                        if (devices.size() >= MAX_LINKS || notificationTombstones.size() >= 64
                                || notificationTombstones.contains(address)
                                || (blockedUntil != null && blockedUntil > SystemClock.elapsedRealtime())) {
                            cancelConnection(device); return;
                        }
                        if (!devices.containsKey(address)) {
                            Peer peer = new Peer(device, address, epoch);
                            devices.put(address, peer);
                            peer.subscriptionTimeout = () -> {
                                if (current(epoch) && !peer.closed && !peer.subscribed) closePeer(peer, true);
                            };
                            main.postDelayed(peer.subscriptionTimeout, 20_000);
                        }
                    } else if (state == BluetoothProfile.STATE_DISCONNECTED) {
                        Peer peer = devices.get(address);
                        if (peer != null) closePeer(peer, false);
                        // A brief quarantine also prevents a delayed notification
                        // callback being mistaken for a fast reconnect's write.
                        closingAddresses.put(address, SystemClock.elapsedRealtime() + 2000);
                        pruneClosingAddresses();
                    }
                });
            }

            @Override public void onMtuChanged(BluetoothDevice device, int mtu) {
                main.post(() -> {
                    if (!current(epoch)) return;
                    Peer peer = peer(device);
                    if (peer == null || mtu < 23 || mtu > 517) return;
                    peer.mtu = mtu;
                    if (peer.subscribed && chunk(peer) < peer.exposedChunk) closePeer(peer, true);
                });
            }

            @Override public void onCharacteristicReadRequest(BluetoothDevice device, int requestId,
                    int offset, BluetoothGattCharacteristic characteristic) {
                main.post(() -> {
                    if (!current(epoch)) return;
                    int code = !NOTIFY.equals(characteristic.getUuid()) ? BluetoothGatt.GATT_READ_NOT_PERMITTED
                        : offset != 0 ? BluetoothGatt.GATT_INVALID_OFFSET : BluetoothGatt.GATT_SUCCESS;
                    // Never expose an old peer's packet via characteristic reads.
                    respond(device, requestId, code, offset, new byte[0]);
                });
            }

            @Override public void onCharacteristicWriteRequest(BluetoothDevice device, int requestId,
                    BluetoothGattCharacteristic characteristic, boolean preparedWrite,
                    boolean responseNeeded, int offset, byte[] value) {
                final byte[] bytes = value == null ? null : Arrays.copyOf(value, value.length);
                main.post(() -> {
                    if (!current(epoch)) return;
                    Peer peer = peer(device);
                    int code = !WRITE.equals(characteristic.getUuid()) ? BluetoothGatt.GATT_WRITE_NOT_PERMITTED
                        : preparedWrite ? BluetoothGatt.GATT_REQUEST_NOT_SUPPORTED
                        : offset != 0 ? BluetoothGatt.GATT_INVALID_OFFSET
                        : peer == null ? BluetoothGatt.GATT_FAILURE
                        : bytes == null || bytes.length == 0 || bytes.length > chunk(peer)
                            ? BluetoothGatt.GATT_INVALID_ATTRIBUTE_LENGTH : BluetoothGatt.GATT_SUCCESS;
                    if (!responseNeeded) {
                        // The service exposes WRITE, never WRITE_NO_RESPONSE:
                        // one ATT request/response bounds incoming delivery.
                        if (peer != null) closePeer(peer, true);
                        return;
                    }
                    if (code == BluetoothGatt.GATT_SUCCESS) {
                        if (!peer.subscribed) {
                            // BLE central monitor setup can return before its
                            // CCC write completes. Retain the first handshake
                            // chunks without exposing data before connected.
                            if (peer.earlyChunks.size() >= 8 || peer.earlyBytes + bytes.length > 4096) {
                                respond(device, requestId, BluetoothGatt.GATT_FAILURE, offset, null);
                                closePeer(peer, true);
                                return;
                            }
                            peer.earlyChunks.addLast(bytes); peer.earlyBytes += bytes.length;
                        } else emitData(peer, bytes);
                    }
                    // This only accepts a byte chunk into the local protocol
                    // stream. JS separately emits an ACK after durable storage.
                    respond(device, requestId, code, offset, null);
                });
            }

            @Override public void onDescriptorReadRequest(BluetoothDevice device, int requestId,
                    int offset, BluetoothGattDescriptor descriptor) {
                main.post(() -> {
                    if (!current(epoch)) return;
                    Peer peer = peer(device);
                    int code = !isCcc(descriptor) ? BluetoothGatt.GATT_READ_NOT_PERMITTED
                        : offset != 0 ? BluetoothGatt.GATT_INVALID_OFFSET : BluetoothGatt.GATT_SUCCESS;
                    byte[] value = peer != null && peer.subscribed
                        ? BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE : BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE;
                    respond(device, requestId, code, offset, code == BluetoothGatt.GATT_SUCCESS ? value : null);
                });
            }

            @Override public void onDescriptorWriteRequest(BluetoothDevice device, int requestId,
                    BluetoothGattDescriptor descriptor, boolean preparedWrite,
                    boolean responseNeeded, int offset, byte[] value) {
                final byte[] bytes = value == null ? null : Arrays.copyOf(value, value.length);
                main.post(() -> {
                    if (!current(epoch)) return;
                    Peer peer = peer(device);
                    boolean enable = Arrays.equals(bytes, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
                    boolean disable = Arrays.equals(bytes, BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE);
                    int code = !isCcc(descriptor) ? BluetoothGatt.GATT_WRITE_NOT_PERMITTED
                        : preparedWrite ? BluetoothGatt.GATT_REQUEST_NOT_SUPPORTED
                        : offset != 0 ? BluetoothGatt.GATT_INVALID_OFFSET
                        : peer == null ? BluetoothGatt.GATT_FAILURE
                        : !enable && !disable ? BluetoothGatt.GATT_REQUEST_NOT_SUPPORTED : BluetoothGatt.GATT_SUCCESS;
                    if (responseNeeded) respond(device, requestId, code, offset, null);
                    if (code != BluetoothGatt.GATT_SUCCESS || !responseNeeded || !current(epoch) || peer.closed) return;
                    if (enable && !peer.subscribed) {
                        main.removeCallbacks(peer.subscriptionTimeout);
                        peer.subscribed = true;
                        peer.exposedChunk = chunk(peer);
                        links.put(peer.id, peer);
                        WritableMap event = event("connected"); event.putMap("link", linkMap(peer)); emit(event);
                        while (!peer.earlyChunks.isEmpty()) emitData(peer, peer.earlyChunks.removeFirst());
                        peer.earlyBytes = 0;
                    } else if (disable && peer.subscribed) closePeer(peer, true);
                });
            }

            @Override public void onExecuteWrite(BluetoothDevice device, int requestId, boolean execute) {
                main.post(() -> {
                    if (current(epoch)) respond(device, requestId, BluetoothGatt.GATT_REQUEST_NOT_SUPPORTED, 0, null);
                });
            }

            @Override public void onNotificationSent(BluetoothDevice device, int code) {
                main.post(() -> {
                    if (!current(epoch)) return;
                    String address = address(device);
                    // Android's callback has no operation token. A cancelled
                    // notification must drain before this address can reconnect;
                    // otherwise an old callback could resolve a new write.
                    if (address != null && notificationTombstones.remove(address)) return;
                    if (notifying == null) return;
                    Peer peer = peer(device);
                    Operation op = notifying;
                    if (peer == null || op.peer != peer) return;
                    notifying = null;
                    if (code == BluetoothGatt.GATT_SUCCESS) succeed(op, null);
                    else { fail(op, "E_NOTIFY", "GATT notification failed (" + code + ")"); closePeer(peer, true); }
                    nextNotification();
                });
            }
        };
    }

    @ReactMethod public void connect(String endpointId, String operationId, Promise promise) {
        promise.reject("E_UNSUPPORTED", "BLE peripheral accepts central connections; use the BLE central adapter to dial");
    }

    @ReactMethod public void write(String linkId, String base64, String operationId, Promise promise) {
        main.post(() -> {
            Peer peer = links.get(linkId);
            if (!running || peer == null || peer.closed || !peer.subscribed) {
                promise.reject("E_DISCONNECTED", "BLE peripheral link is closed"); return;
            }
            byte[] bytes;
            try {
                if (base64 == null || base64.length() > 4 * ((MAX_CHUNK + 2) / 3))
                    throw new IllegalArgumentException("BLE chunk exceeds native limit");
                bytes = Base64.decode(base64, Base64.NO_WRAP);
                if (bytes.length == 0 || bytes.length > Math.min(peer.exposedChunk, chunk(peer)))
                    throw new IllegalArgumentException("BLE chunk exceeds negotiated ATT payload");
            } catch (IllegalArgumentException error) { promise.reject("E_CHUNK", error.getMessage()); return; }
            Operation op = begin(operationId, promise, 10_000);
            if (op == null) return;
            op.peer = peer; op.bytes = bytes;
            notifications.addLast(op);
            nextNotification();
        });
    }

    @SuppressWarnings("deprecation")
    private void nextNotification() {
        if (!running || stopping || notifying != null || server == null) return;
        while (!notifications.isEmpty()) {
            Operation op = notifications.removeFirst();
            if (op.done.get()) continue;
            if (op.peer.closed || !op.peer.subscribed) { fail(op, "E_DISCONNECTED", "BLE peripheral link closed"); continue; }
            notifying = op;
            boolean accepted;
            try {
                if (Build.VERSION.SDK_INT >= 33) {
                    accepted = server.notifyCharacteristicChanged(op.peer.device, notifyCharacteristic, false, op.bytes) == 0;
                } else {
                    // Android's old API reads mutable characteristic.value.
                    // Globally serialize notifications until onNotificationSent
                    // so writes to different devices cannot overwrite it.
                    notifyCharacteristic.setValue(op.bytes);
                    accepted = server.notifyCharacteristicChanged(op.peer.device, notifyCharacteristic, false);
                }
            } catch (RuntimeException error) { accepted = false; }
            if (accepted) return;
            notifying = null;
            fail(op, "E_NOTIFY", "Android rejected the BLE notification");
            closePeer(op.peer, true);
            return; // closePeer schedules the next eligible notification
        }
    }

    @ReactMethod public void disconnect(String linkId, Promise promise) {
        main.post(() -> {
            Peer peer = links.get(linkId);
            if (peer != null) closePeer(peer, true);
            promise.resolve(null);
        });
    }

    @ReactMethod public void cancel(String operationId) {
        main.post(() -> {
            Operation op = operations.get(operationId);
            if (op == null) return;
            boolean wasStart = starting == op;
            boolean wasActiveWrite = notifying == op;
            fail(op, "E_CANCELLED", "BLE peripheral operation cancelled");
            notifications.remove(op);
            if (wasActiveWrite) closePeer(op.peer, true);
            if (wasStart) teardown(null); else nextNotification();
        });
    }

    @ReactMethod public void stop(Promise promise) { main.post(() -> teardown(promise)); }

    private void teardown(Promise promise) {
        if (stopping) { if (promise != null) promise.resolve(null); return; }
        for (Peer peer : links.values()) {
            WritableMap value = event("disconnected"); value.putString("linkId", peer.id); emit(value);
        }
        if (running) {
            WritableMap value = event("status"); WritableMap unavailable = Arguments.createMap();
            unavailable.putBoolean("available", false);
            String reason = unavailableReason(); unavailable.putString("reason", reason == null ? "unavailable" : reason);
            value.putMap("status", unavailable); emit(value);
        }
        stopping = true; running = false; generation++;
        for (Operation op : new ArrayList<>(operations.values())) fail(op, "E_STOPPED", "BLE peripheral stopped");
        notifications.clear(); notifying = null;
        String error = null;
        try {
            if (advertiser != null && advertisingCallback != null) advertiser.stopAdvertising(advertisingCallback);
        } catch (RuntimeException failure) { error = "Cannot stop BLE advertising after permission/state change"; }
        advertisingCallback = null; advertiser = null;
        for (Peer peer : new ArrayList<>(devices.values())) closePeer(peer, true);
        devices.clear(); links.clear(); closingAddresses.clear(); notificationTombstones.clear();
        if (server != null) {
            try { server.clearServices(); } catch (RuntimeException ignored) { }
            try { server.close(); } catch (RuntimeException failure) { error = "Cannot close the BLE GATT server"; }
            server = null;
        }
        notifyCharacteristic = null;
        if (receiver != null) {
            try { context.unregisterReceiver(receiver); } catch (IllegalArgumentException ignored) { }
            receiver = null;
        }
        stopping = false;
        if (promise != null) {
            if (error == null) promise.resolve(null); else promise.reject("E_STOP", error);
        }
    }

    private void closePeer(Peer peer, boolean cancelPhysical) {
        if (peer == null || peer.closed) return;
        peer.closed = true;
        main.removeCallbacks(peer.subscriptionTimeout);
        peer.earlyChunks.clear(); peer.earlyBytes = 0;
        devices.remove(peer.address); links.remove(peer.id);
        closingAddresses.put(peer.address, SystemClock.elapsedRealtime() + 2000);
        pruneClosingAddresses();
        if (cancelPhysical) cancelConnection(peer.device);
        for (Operation op : new ArrayList<>(operations.values()))
            if (op.peer == peer) { notifications.remove(op); fail(op, "E_DISCONNECTED", "BLE peripheral link disconnected"); }
        if (notifying != null && notifying.peer == peer) {
            notificationTombstones.add(peer.address);
            notifying = null;
        }
        if (peer.subscribed && current(peer.epoch)) {
            WritableMap event = event("disconnected"); event.putString("linkId", peer.id); emit(event);
        }
        nextNotification();
    }

    private void cancelConnection(BluetoothDevice device) {
        if (server == null) return;
        try { server.cancelConnection(device); }
        catch (RuntimeException error) { if (running) emitError("Cannot close BLE connection after permission/state change"); }
    }

    private void pruneClosingAddresses() {
        long now = SystemClock.elapsedRealtime();
        closingAddresses.entrySet().removeIf(entry -> entry.getValue() <= now);
        // Connections are bounded to eight, and a short quarantine is bounded
        // separately to avoid retaining addresses during hostile connect churn.
        while (closingAddresses.size() > 64) closingAddresses.remove(closingAddresses.keySet().iterator().next());
    }

    private String address(BluetoothDevice device) {
        try { return device.getAddress(); }
        catch (SecurityException error) { return null; }
    }

    private Peer peer(BluetoothDevice device) {
        String address = address(device);
        return address == null ? null : devices.get(address);
    }

    private static int chunk(Peer peer) { return Math.min(MAX_CHUNK, peer.mtu - 3); }
    private static boolean isCcc(BluetoothGattDescriptor descriptor) {
        return CCC.equals(descriptor.getUuid()) && NOTIFY.equals(descriptor.getCharacteristic().getUuid());
    }

    private void respond(BluetoothDevice device, int id, int code, int offset, byte[] bytes) {
        if (server == null) return;
        try {
            if (!server.sendResponse(device, id, code, offset, bytes)) {
                Peer peer = peer(device);
                if (peer != null) closePeer(peer, true);
            }
        } catch (RuntimeException error) {
            emitError("Cannot respond to GATT request after permission/state change");
            teardown(null);
        }
    }

    private void registerReceiver(int epoch) {
        receiver = new BroadcastReceiver() {
            @Override public void onReceive(Context ignored, Intent intent) {
                if (!current(epoch)) return;
                WritableMap event = event("status"); event.putMap("status", status()); emit(event);
                if (intent.getIntExtra(BluetoothAdapter.EXTRA_STATE, -1) != BluetoothAdapter.STATE_ON) teardown(null);
            }
        };
        IntentFilter filter = new IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED);
        if (Build.VERSION.SDK_INT >= 33) context.registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED);
        else context.registerReceiver(receiver, filter);
    }

    private Operation begin(String id, Promise promise, long timeoutMs) {
        if (id == null || id.isEmpty() || id.length() > 256 || !id.equals(id.trim())
                || operations.containsKey(id) || operations.size() >= MAX_OPERATIONS) {
            promise.reject("E_OPERATION", "Expected a unique operation ID within the pending-operation limit"); return null;
        }
        Operation op = new Operation(id, promise, generation);
        operations.put(id, op);
        op.timeout = () -> {
            if (!current(op.epoch) || op.done.get()) return;
            boolean wasStart = starting == op;
            boolean wasActiveWrite = notifying == op;
            fail(op, "E_TIMEOUT", "BLE peripheral operation timed out"); notifications.remove(op);
            if (wasActiveWrite) closePeer(op.peer, true);
            if (wasStart) teardown(null); else nextNotification();
        };
        main.postDelayed(op.timeout, timeoutMs);
        return op;
    }

    private void succeed(Operation op, Object value) {
        if (!op.done.compareAndSet(false, true)) return;
        operations.remove(op.id); main.removeCallbacks(op.timeout);
        if (starting == op) starting = null;
        op.promise.resolve(value);
    }

    private void fail(Operation op, String code, String message) {
        if (!op.done.compareAndSet(false, true)) return;
        operations.remove(op.id); main.removeCallbacks(op.timeout);
        if (starting == op) starting = null;
        op.promise.reject(code, message == null ? code : message);
    }

    private boolean current(int epoch) { return generation == epoch && running && !stopping && !destroyed; }
    private WritableMap event(String type) {
        WritableMap value = Arguments.createMap(); value.putString("type", type); return value;
    }
    private WritableMap linkMap(Peer peer) {
        WritableMap value = Arguments.createMap(); value.putString("id", peer.id);
        value.putString("endpointId", peer.endpoint); value.putInt("maxChunkBytes", peer.exposedChunk); return value;
    }
    private void emitData(Peer peer, byte[] bytes) {
        // MTU may increase after CCC exposed a conservative link limit. ATT
        // boundaries have no application meaning; keep every event within the
        // immutable JS link limit while preserving the exact byte stream.
        for (int offset = 0; offset < bytes.length; offset += peer.exposedChunk) {
            byte[] part = Arrays.copyOfRange(bytes, offset, Math.min(bytes.length, offset + peer.exposedChunk));
            WritableMap value = event("data"); value.putString("linkId", peer.id);
            value.putString("base64", Base64.encodeToString(part, Base64.NO_WRAP)); emit(value);
        }
    }
    private void emitError(String message) {
        WritableMap value = event("error"); value.putString("message", message); emit(value);
    }
    private void emit(WritableMap value) {
        if (!destroyed && listeners > 0 && context.hasActiveReactInstance())
            context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class).emit(EVENT, value);
    }

    @Override public void onHostResume() { }
    @Override public void onHostPause() { }
    @Override public void onHostDestroy() { main.post(() -> teardown(null)); }
    @Override public void invalidate() {
        main.post(() -> {
            destroyed = true; teardown(null); context.removeLifecycleEventListener(this);
            if (runtimeReceiverRegistered) { context.unregisterReceiver(runtimeStopReceiver); runtimeReceiverRegistered = false; }
        });
        super.invalidate();
    }

    private static final class Peer {
        final BluetoothDevice device;
        final String address;
        final String id = UUID.randomUUID().toString();
        final String endpoint = "ble-inbound:" + UUID.randomUUID();
        final int epoch;
        int mtu = 23;
        int exposedChunk = 20;
        boolean subscribed;
        boolean closed;
        final ArrayDeque<byte[]> earlyChunks = new ArrayDeque<>();
        int earlyBytes;
        Runnable subscriptionTimeout;
        Peer(BluetoothDevice device, String address, int epoch) {
            this.device = device; this.address = address; this.epoch = epoch;
        }
    }

    private static final class Operation {
        final String id;
        final Promise promise;
        final int epoch;
        final AtomicBoolean done = new AtomicBoolean();
        Runnable timeout;
        Peer peer;
        byte[] bytes;
        Operation(String id, Promise promise, int epoch) { this.id = id; this.promise = promise; this.epoch = epoch; }
    }
}
