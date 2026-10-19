package com.palmesh.wifidirect;

import android.Manifest;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.location.LocationManager;
import android.net.wifi.WifiManager;
import android.net.wifi.WpsInfo;
import android.net.wifi.p2p.WifiP2pConfig;
import android.net.wifi.p2p.WifiP2pDevice;
import android.net.wifi.p2p.WifiP2pGroup;
import android.net.wifi.p2p.WifiP2pInfo;
import android.net.wifi.p2p.WifiP2pManager;
import android.net.wifi.p2p.nsd.WifiP2pDnsSdServiceInfo;
import android.net.wifi.p2p.nsd.WifiP2pDnsSdServiceRequest;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
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
import java.io.Closeable;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Future;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.Semaphore;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * DNS-SD discovers only PalMesh services. Wi-Fi P2P negotiates one Android group;
 * a TCP stream over that group's local interface carries the JS mesh protocol.
 * All P2P state and Promise completion is serialized on the Android main thread.
 * Socket IO never runs on that thread. No Internet endpoint is contacted.
 */
public final class PalMeshWifiDirectModule extends ReactContextBaseJavaModule
        implements LifecycleEventListener {
    private static final String EVENT = "PalMeshWifiDirectEvent";
    private static final String SERVICE_TYPE = "_palmesh._tcp";
    private static final int PORT = 45459;
    private static final int CHUNK = 8192;
    private static final int MAX_LINKS = 4;
    private static final int MAX_PEERS = 128;
    private static final int MAX_OPERATIONS = 64;
    private static final long PEER_MAX_AGE_MS = 120_000;
    private static final byte[] MAGIC = "PALMESH1".getBytes(StandardCharsets.US_ASCII);

    private final ReactApplicationContext context;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final WifiP2pManager manager;
    private final String instanceId = UUID.randomUUID().toString();
    // A bounded pool prevents stalled radios or dense peer discovery from creating
    // unbounded threads/tasks. Four blocking readers leave capacity for IO setup.
    private final ThreadPoolExecutor io = new ThreadPoolExecutor(8, 8, 30,
        TimeUnit.SECONDS, new ArrayBlockingQueue<>(32));
    // A single FIFO writer preserves call order even if multiple JS callers
    // submit chunks concurrently. A timed-out write closes its socket.
    private final ThreadPoolExecutor writes = new ThreadPoolExecutor(1, 1, 30,
        TimeUnit.SECONDS, new ArrayBlockingQueue<>(32));
    private final Map<String, Operation> operations = new HashMap<>();
    private final Map<String, Peer> peers = new LinkedHashMap<>();
    private final Map<String, Link> links = new LinkedHashMap<>();
    private final Set<Socket> handshakes = ConcurrentHashMap.newKeySet();
    private final Set<String> dialing = new HashSet<>();
    private final Set<String> attemptedInGroup = new HashSet<>();
    private final Set<String> cancelledEndpoints = new HashSet<>();
    private final List<Promise> stoppingPromises = new ArrayList<>();
    private WifiP2pManager.Channel channel;
    private WifiP2pDnsSdServiceInfo localService;
    private WifiP2pDnsSdServiceRequest serviceRequest;
    private BroadcastReceiver receiver;
    private volatile ServerSocket server;
    private int serverStartingEpoch = -1;
    private volatile int generation;
    private boolean running;
    private boolean stopping;
    private boolean destroyed;
    private boolean ownsGroup;
    private boolean initiatedConnect;
    private boolean cancellingConnect;
    private boolean groupOwner;
    private InetAddress ownerAddress;
    private String ownerEndpoint;
    private Operation pendingConnect;
    private Operation starting;
    private Runnable discoveryRetry;
    private long discoveryBackoff = 2000;
    private boolean removingCancelledGroup;
    private boolean connectionQueryInFlight;
    private boolean refreshAgain;
    private long lastConnectionQueryAt;
    private Runnable connectionRefresh;
    private int listenerCount;
    private boolean runtimeReceiverRegistered;
    private final BroadcastReceiver runtimeStopReceiver = new BroadcastReceiver() {
        @Override public void onReceive(Context receiverContext, Intent intent) { teardown(null); }
    };

    public PalMeshWifiDirectModule(ReactApplicationContext context) {
        super(context);
        this.context = context;
        this.manager = (WifiP2pManager) context.getSystemService(Context.WIFI_P2P_SERVICE);
        context.addLifecycleEventListener(this);
    }

    @Override public String getName() { return "PalMeshWifiDirect"; }

    @Override public void initialize() {
        super.initialize();
        IntentFilter filter = new IntentFilter("com.palmesh.runtime.STOP_RADIOS");
        String permission = context.getPackageName() + ".permission.PALMESH_INTERNAL";
        if (Build.VERSION.SDK_INT >= 33) context.registerReceiver(runtimeStopReceiver, filter, permission, main, Context.RECEIVER_NOT_EXPORTED);
        else context.registerReceiver(runtimeStopReceiver, filter, permission, main);
        runtimeReceiverRegistered = true;
    }

    @ReactMethod public void addListener(String name) {
        main.post(() -> listenerCount++);
    }

    @ReactMethod public void removeListeners(double count) {
        main.post(() -> listenerCount = Math.max(0, listenerCount - (int) count));
    }

    @ReactMethod public void getStatus(Promise promise) {
        main.post(() -> promise.resolve(status()));
    }

    private WritableMap status() {
        WritableMap result = Arguments.createMap();
        String reason = unavailableReason();
        result.putBoolean("available", reason == null);
        if (reason != null) result.putString("reason", reason);
        return result;
    }

    private String unavailableReason() {
        if (destroyed || manager == null || !context.getPackageManager()
                .hasSystemFeature(PackageManager.FEATURE_WIFI_DIRECT)) return "unsupported";
        String permission = Build.VERSION.SDK_INT >= 33
            ? "android.permission.NEARBY_WIFI_DEVICES" : Manifest.permission.ACCESS_FINE_LOCATION;
        if (context.checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED)
            return "permission-denied";
        WifiManager wifi = (WifiManager) context.getApplicationContext()
            .getSystemService(Context.WIFI_SERVICE);
        if (wifi == null || !wifi.isWifiEnabled()) return "powered-off";
        // Before Android 13, discovery also requires the system location switch.
        if (Build.VERSION.SDK_INT <= 32) {
            LocationManager location = (LocationManager) context.getSystemService(Context.LOCATION_SERVICE);
            boolean enabled = location != null && (Build.VERSION.SDK_INT >= 28
                ? location.isLocationEnabled()
                : location.isProviderEnabled(LocationManager.GPS_PROVIDER)
                    || location.isProviderEnabled(LocationManager.NETWORK_PROVIDER));
            if (!enabled) return "unavailable";
        }
        return null;
    }

    @ReactMethod public void start(String operationId, Promise promise) {
        main.post(() -> {
            if (stopping) { promise.reject("E_STOPPING", "Wi-Fi Direct is stopping"); return; }
            if (starting != null) { promise.reject("E_STARTING", "Wi-Fi Direct startup is still pending"); return; }
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
                channel = manager.initialize(context, Looper.getMainLooper(), () -> {
                    if (!current(epoch)) return;
                    emitError("Wi-Fi P2P channel disconnected");
                    teardown(null);
                });
                if (channel == null) throw new IllegalStateException("Cannot initialize Wi-Fi P2P");
                registerReceiver(epoch);
                // Existing groups may belong to another application. Never adopt
                // or remove one merely because this module was started.
                manager.requestGroupInfo(channel, group -> {
                    if (!active(op)) return;
                    if (group != null) {
                        fail(op, "E_EXISTING_GROUP", "Leave the existing Wi-Fi Direct group first");
                        teardown(null);
                        return;
                    }
                    advertise(op, epoch);
                });
            } catch (Exception error) {
                fail(op, "E_START", error.getMessage());
                teardown(null);
            }
        });
    }

    private void advertise(Operation op, int epoch) {
        if (!active(op)) return;
        try {
            manager.setDnsSdResponseListeners(channel, (name, type, device) -> {
                // TXT responses provide the bounded instance ID and version.
                // The service response alone never exposes arbitrary P2P peers.
            }, (domain, txt, device) -> {
                if (!current(epoch) || domain == null || txt == null || device == null) return;
                String suffix = "." + SERVICE_TYPE + ".local.";
                String canonical = domain.toLowerCase(Locale.ROOT);
                if (!canonical.endsWith(".")) canonical += ".";
                if (!canonical.endsWith(suffix) || !"1".equals(txt.get("v"))
                    || !Integer.toString(PORT).equals(txt.get("port"))) return;
                String id = txt.get("id");
                if (!validUuid(id) || instanceId.equals(id) || device.deviceAddress == null
                    || !device.deviceAddress.matches("(?i)[0-9a-f]{2}(:[0-9a-f]{2}){5}")) return;
                String expected = "palmesh-" + id + suffix;
                if (!canonical.equals(expected)) return;
                String endpoint = "p2p:" + id;
                Peer old = peers.remove(endpoint);
                if (peers.size() >= MAX_PEERS) peers.remove(peers.keySet().iterator().next());
                peers.put(endpoint, new Peer(endpoint, device.deviceAddress, SystemClock.elapsedRealtime()));
                if (old == null || SystemClock.elapsedRealtime() - old.seenAt > 10_000) {
                    WritableMap event = event("discovered");
                    WritableMap value = Arguments.createMap();
                    value.putString("endpointId", endpoint);
                    event.putMap("endpoint", value);
                    emit(event);
                }
                refreshConnection(epoch);
            });
            Map<String, String> txt = new HashMap<>();
            txt.put("v", "1");
            txt.put("id", instanceId);
            txt.put("port", Integer.toString(PORT));
            localService = WifiP2pDnsSdServiceInfo.newInstance("palmesh-" + instanceId, SERVICE_TYPE, txt);
            manager.addLocalService(channel, localService, action(op, () -> {
                // Android's wildcard DNS-SD request returns TXT as well as PTR.
                // A type-only PTR query can omit the identity TXT record. The
                // response callback above strictly filters the PalMesh domain;
                // arbitrary Wi-Fi P2P devices/services are never exposed to JS.
                serviceRequest = WifiP2pDnsSdServiceRequest.newInstance();
                manager.addServiceRequest(channel, serviceRequest, action(op, () ->
                    manager.discoverServices(channel, action(op, () -> {
                        succeed(op, null);
                        scheduleDiscovery(45_000);
                    }))));
            }));
        } catch (Exception error) {
            fail(op, "E_DISCOVERY", error.getMessage());
            teardown(null);
        }
    }

    private WifiP2pManager.ActionListener action(Operation op, Runnable success) {
        return new WifiP2pManager.ActionListener() {
            @Override public void onSuccess() {
                if (!active(op)) return;
                try { success.run(); }
                catch (Exception error) {
                    boolean connecting = pendingConnect == op;
                    fail(op, "E_P2P", error.getMessage());
                    if (connecting) cancelConnectionOperation(op); else teardown(null);
                }
            }
            @Override public void onFailure(int reason) {
                if (!active(op)) return;
                boolean connecting = pendingConnect == op;
                fail(op, "E_P2P_" + reason, "Wi-Fi P2P action failed (" + reason + ")");
                if (connecting) cancelConnectionOperation(op);
                if (!connecting) teardown(null);
            }
        };
    }

    private void registerReceiver(int epoch) {
        IntentFilter filter = new IntentFilter();
        filter.addAction(WifiP2pManager.WIFI_P2P_STATE_CHANGED_ACTION);
        filter.addAction(WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION);
        filter.addAction(WifiP2pManager.WIFI_P2P_DISCOVERY_CHANGED_ACTION);
        receiver = new BroadcastReceiver() {
            @Override public void onReceive(Context ignored, Intent intent) {
                if (!current(epoch)) return;
                if (WifiP2pManager.WIFI_P2P_STATE_CHANGED_ACTION.equals(intent.getAction())) {
                    WritableMap event = event("status");
                    boolean disabled = intent.getIntExtra(WifiP2pManager.EXTRA_WIFI_STATE, -1)
                        == WifiP2pManager.WIFI_P2P_STATE_DISABLED;
                    WritableMap value = status();
                    if (disabled) { value.putBoolean("available", false); value.putString("reason", "powered-off"); }
                    event.putMap("status", value);
                    emit(event);
                    if (intent.getIntExtra(WifiP2pManager.EXTRA_WIFI_STATE, -1)
                            == WifiP2pManager.WIFI_P2P_STATE_DISABLED) teardown(null);
                } else if (WifiP2pManager.WIFI_P2P_DISCOVERY_CHANGED_ACTION.equals(intent.getAction())) {
                    if (intent.getIntExtra(WifiP2pManager.EXTRA_DISCOVERY_STATE, -1)
                            == WifiP2pManager.WIFI_P2P_DISCOVERY_STOPPED) scheduleDiscovery(2000);
                } else refreshConnection(epoch);
            }
        };
        // Android's Wi-Fi process may use a privileged non-system UID. Exported
        // delivery is required; these two broadcasts are system-protected.
        if (Build.VERSION.SDK_INT >= 33) context.registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED);
        else context.registerReceiver(receiver, filter);
    }

    private void refreshConnection(int epoch) {
        if (!current(epoch) || channel == null) return;
        if (connectionQueryInFlight) { refreshAgain = true; return; }
        if (connectionRefresh != null) return;
        connectionRefresh = () -> {
            connectionRefresh = null;
            if (current(epoch)) queryConnection(epoch);
        };
        main.postDelayed(connectionRefresh, Math.max(0, 500 - (SystemClock.elapsedRealtime() - lastConnectionQueryAt)));
    }

    private void queryConnection(int epoch) {
        if (!current(epoch) || channel == null) return;
        connectionQueryInFlight = true;
        lastConnectionQueryAt = SystemClock.elapsedRealtime();
        try {
            manager.requestConnectionInfo(channel, info -> {
                if (!current(epoch)) return;
                try {
                    manager.requestGroupInfo(channel, group -> {
                        if (!current(epoch)) return;
                        connectionQueryInFlight = false;
                        processGroup(info, group, epoch);
                        if (refreshAgain) { refreshAgain = false; refreshConnection(epoch); }
                    });
                } catch (RuntimeException error) {
                    emitError("Wi-Fi Direct permission or channel became unavailable");
                    teardown(null);
                }
            });
        } catch (RuntimeException error) {
            emitError("Wi-Fi Direct permission was revoked");
            teardown(null);
        }
    }

    private void scheduleDiscovery(long delay) {
        if (!running || stopping || starting != null || destroyed) return;
        if (discoveryRetry != null) main.removeCallbacks(discoveryRetry);
        final int epoch = generation;
        discoveryRetry = () -> {
            discoveryRetry = null;
            if (!current(epoch) || channel == null) return;
            try {
                manager.discoverServices(channel, new WifiP2pManager.ActionListener() {
                    @Override public void onSuccess() {
                        if (!current(epoch)) return;
                        discoveryBackoff = 2000;
                        scheduleDiscovery(45_000);
                    }
                    @Override public void onFailure(int reason) {
                        if (!current(epoch)) return;
                        discoveryBackoff = Math.min(60_000, discoveryBackoff * 2);
                        scheduleDiscovery(discoveryBackoff);
                    }
                });
            } catch (RuntimeException error) {
                if (current(epoch)) { emitError("Wi-Fi Direct discovery became unavailable"); teardown(null); }
            }
        };
        main.postDelayed(discoveryRetry, delay);
    }

    private void processGroup(WifiP2pInfo info, WifiP2pGroup group, int epoch) {
        if (!info.groupFormed || group == null) {
            if (ownsGroup) {
                closeConnections();
                ownsGroup = false;
                ownerAddress = null;
                ownerEndpoint = null;
                attemptedInGroup.clear();
                scheduleDiscovery(2000);
            }
            return;
        }
        if (links.isEmpty() && groupMatchesCancelledEndpoint(group)) {
            removeCancelledGroup(epoch);
            return;
        }
        Peer groupPeer = peerForDevice(group.getOwner());
        if (groupPeer == null) for (WifiP2pDevice client : group.getClientList()) {
            groupPeer = peerForDevice(client);
            if (groupPeer != null) break;
        }
        // A group only becomes ours after this session observes a PalMesh member.
        // A pre-existing group was rejected in start() before advertising.
        if (!ownsGroup && groupPeer == null) return;
        ownsGroup = true;
        initiatedConnect = false;
        groupOwner = info.isGroupOwner;
        ownerAddress = info.groupOwnerAddress;
        Peer owner = peerForDevice(group.getOwner());
        ownerEndpoint = owner == null ? null : owner.endpoint;
        if (ownerAddress == null || !ownerAddress.isSiteLocalAddress()) {
            emitError("Wi-Fi Direct did not supply a private group address");
            return;
        }
        if (groupOwner) startServer(ownerAddress, epoch);
        else if (ownerEndpoint != null && !attemptedInGroup.contains(ownerEndpoint)
            && findLink(ownerEndpoint) == null && !dialing.contains(ownerEndpoint)) {
            attemptedInGroup.add(ownerEndpoint);
            dial(ownerEndpoint, ownerAddress, epoch);
        }
    }

    private Peer peerForDevice(WifiP2pDevice device) {
        if (device == null || device.deviceAddress == null) return null;
        for (Peer peer : peers.values())
            if (peer.address.equalsIgnoreCase(device.deviceAddress)) return peer;
        return null;
    }

    @ReactMethod public void connect(String endpointId, String operationId, Promise promise) {
        main.post(() -> {
            if (!running || stopping) { promise.reject("E_STOPPED", "Start Wi-Fi Direct first"); return; }
            if (unavailableReason() != null) { promise.reject("E_UNAVAILABLE", unavailableReason()); return; }
            Link existing = findLink(endpointId);
            if (existing != null) { promise.resolve(linkMap(existing)); return; }
            Peer peer = peers.get(endpointId);
            if (peer == null || SystemClock.elapsedRealtime() - peer.seenAt > PEER_MAX_AGE_MS) {
                promise.reject("E_UNKNOWN_PEER", "Endpoint must have a recent PalMesh DNS-SD advertisement"); return;
            }
            if (pendingConnect != null || links.size() + handshakes.size() >= MAX_LINKS) {
                promise.reject("E_BUSY", "Wi-Fi Direct connection capacity reached"); return;
            }
            if (ownsGroup && !groupOwner && !endpointId.equals(ownerEndpoint)) {
                promise.reject("E_GROUP_LIMIT", "A Wi-Fi Direct client can connect only to its group owner"); return;
            }
            Operation op = begin(operationId, promise, 25_000);
            if (op == null) return;
            pendingConnect = op;
            op.endpoint = endpointId;
            op.createdGroup = !ownsGroup;
            cancelledEndpoints.remove(endpointId);
            if (ownsGroup && !groupOwner && ownerAddress != null) {
                if (!dialing.contains(endpointId)) dial(endpointId, ownerAddress, generation);
                return;
            }
            try {
                WifiP2pConfig config = new WifiP2pConfig();
                config.deviceAddress = peer.address;
                config.wps.setup = WpsInfo.PBC;
                config.groupOwnerIntent = ownsGroup ? 15 : 7;
                initiatedConnect = true;
                // Success acknowledges negotiation only. The Promise resolves only
                // after a real local TCP connection and native protocol greeting.
                manager.connect(channel, config, action(op, () -> refreshConnection(generation)));
            } catch (Exception error) {
                fail(op, "E_CONNECT", error.getMessage());
                cancelConnectionOperation(op);
            }
        });
    }

    private void startServer(InetAddress bindAddress, int epoch) {
        if (server != null || serverStartingEpoch == epoch) return;
        serverStartingEpoch = epoch;
        try {
            submitIo(() -> {
                ServerSocket listener = null;
                try {
                    listener = new ServerSocket();
                    listener.setReuseAddress(true);
                    listener.bind(new InetSocketAddress(bindAddress, PORT), MAX_LINKS);
                    listener.setSoTimeout(1000);
                    final ServerSocket ready = listener;
                    main.post(() -> {
                        if (serverStartingEpoch == epoch) serverStartingEpoch = -1;
                        if (!current(epoch)) { close(ready); return; }
                        server = ready;
                        try { submitIo(() -> accept(ready, epoch)); }
                        catch (RejectedExecutionException error) { close(ready); server = null; }
                    });
                } catch (IOException error) {
                    close(listener);
                    main.post(() -> listenerFailed(epoch));
                }
            });
        } catch (RejectedExecutionException error) { listenerFailed(epoch); }
    }

    private void listenerFailed(int epoch) {
        if (serverStartingEpoch == epoch) serverStartingEpoch = -1;
        if (!current(epoch)) return;
        if (pendingConnect != null) {
            Operation op = pendingConnect;
            fail(op, "E_LISTEN", "Cannot open the Wi-Fi Direct local listener");
            cancelConnectionOperation(op);
        }
        emitError("Cannot open the Wi-Fi Direct local listener");
    }

    private void accept(ServerSocket socket, int epoch) {
        try {
            while (currentVolatile(epoch) && !socket.isClosed()) {
                try {
                    Socket accepted = socket.accept();
                    if (handshakes.size() >= MAX_LINKS) { close(accepted); continue; }
                    handshakes.add(accepted);
                    main.post(() -> {
                        if (!current(epoch) || links.size() + handshakes.size() > MAX_LINKS) {
                            handshakes.remove(accepted); close(accepted); return;
                        }
                        handshake(accepted, null, epoch);
                    });
                } catch (SocketTimeoutException ignored) { /* cancellation polling */ }
            }
        } catch (IOException error) {
            if (!socket.isClosed()) main.post(() -> {
                if (current(epoch)) emitError("Wi-Fi Direct listener failed");
            });
        } finally {
            close(socket);
            main.post(() -> { if (server == socket) server = null; });
        }
    }

    private void dial(String endpoint, InetAddress address, int epoch) {
        dialing.add(endpoint);
        Socket socket = new Socket();
        handshakes.add(socket);
        Operation op = pendingConnect != null && endpoint.equals(pendingConnect.endpoint) ? pendingConnect : null;
        if (op != null) op.socket = socket;
        try {
            submitIo(() -> {
                try {
                    socket.connect(new InetSocketAddress(address, PORT), 7000);
                    performHandshake(socket, endpoint, epoch);
                } catch (Exception error) {
                    close(socket);
                    main.post(() -> socketFailed(socket, endpoint, epoch, "Wi-Fi Direct socket connection failed"));
                }
            });
        } catch (RejectedExecutionException error) {
            close(socket);
            socketFailed(socket, endpoint, epoch, "Wi-Fi Direct IO capacity reached");
        }
    }

    private void handshake(Socket socket, String expected, int epoch) {
        try {
            submitIo(() -> {
                try { performHandshake(socket, expected, epoch); }
                catch (Exception error) {
                    close(socket);
                    main.post(() -> socketFailed(socket, expected, epoch, "Invalid or interrupted PalMesh greeting"));
                }
            });
        } catch (RejectedExecutionException error) {
            close(socket); handshakes.remove(socket);
        }
    }

    private void performHandshake(Socket socket, String expected, int epoch) throws IOException {
        socket.setTcpNoDelay(true);
        socket.setSoTimeout(5000);
        socket.getOutputStream().write(MAGIC);
        socket.getOutputStream().write(instanceId.getBytes(StandardCharsets.US_ASCII));
        socket.getOutputStream().flush();
        byte[] greeting = new byte[MAGIC.length + 36];
        int offset = 0;
        while (offset < greeting.length) {
            int count = socket.getInputStream().read(greeting, offset, greeting.length - offset);
            if (count < 0) throw new EOFException();
            offset += count;
        }
        if (!Arrays.equals(MAGIC, Arrays.copyOf(greeting, MAGIC.length))) throw new IOException("Protocol mismatch");
        String id = new String(greeting, MAGIC.length, 36, StandardCharsets.US_ASCII);
        String endpoint = "p2p:" + id;
        if (!validUuid(id) || instanceId.equals(id) || (expected != null && !expected.equals(endpoint)))
            throw new IOException("Endpoint mismatch");
        socket.setSoTimeout(1000);
        main.post(() -> {
            handshakes.remove(socket);
            dialing.remove(endpoint);
            if (!current(epoch) || socket.isClosed() || !peers.containsKey(endpoint) || cancelledEndpoints.contains(endpoint)
                || links.size() >= MAX_LINKS || findLink(endpoint) != null) {
                close(socket); return;
            }
            Link link = new Link(UUID.randomUUID().toString(), endpoint, socket, epoch);
            links.put(link.id, link);
            WritableMap event = event("connected");
            event.putMap("link", linkMap(link));
            emit(event);
            if (pendingConnect != null && endpoint.equals(pendingConnect.endpoint)) {
                pendingConnect.socket = null;
                succeed(pendingConnect, linkMap(link));
            }
            try { submitIo(() -> read(link)); }
            catch (RejectedExecutionException error) { closeLink(link); }
        });
    }

    private void socketFailed(Socket socket, String endpoint, int epoch, String message) {
        handshakes.remove(socket);
        if (endpoint != null) dialing.remove(endpoint);
        if (!current(epoch)) return;
        if (pendingConnect != null && endpoint != null && endpoint.equals(pendingConnect.endpoint)) {
            Operation op = pendingConnect;
            fail(op, "E_SOCKET", message);
            cancelConnectionOperation(op);
        }
        emitError(message);
    }

    private void read(Link link) {
        byte[] buffer = new byte[CHUNK];
        try {
            InputStream input = link.socket.getInputStream();
            while (currentVolatile(link.epoch) && !link.closed.get()) {
                try {
                    int count = input.read(buffer);
                    if (count < 0) break;
                    if (count == 0) continue;
                    String base64 = Base64.encodeToString(Arrays.copyOf(buffer, count), Base64.NO_WRAP);
                    // Posting in read order preserves the byte stream. The JS
                    // adapter performs application framing across these chunks.
                    // Bound the pending main-thread delivery queue too. Once it
                    // fills, stop reading and let TCP backpressure reach peers.
                    while (!link.incoming.tryAcquire(1000, TimeUnit.MILLISECONDS))
                        if (!currentVolatile(link.epoch) || link.closed.get()) return;
                    main.post(() -> {
                        try {
                            if (!current(link.epoch) || link.closed.get()) return;
                            WritableMap event = event("data");
                            event.putString("linkId", link.id);
                            event.putString("base64", base64);
                            emit(event);
                        } finally { link.incoming.release(); }
                    });
                } catch (SocketTimeoutException ignored) { /* cancellation polling */ }
            }
        } catch (IOException ignored) { /* reported as disconnected below */ }
        catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
        finally { main.post(() -> closeLink(link)); }
    }

    @ReactMethod public void write(String linkId, String base64, String operationId, Promise promise) {
        main.post(() -> {
            Link link = links.get(linkId);
            if (link == null || link.closed.get()) { promise.reject("E_DISCONNECTED", "Link is closed"); return; }
            byte[] bytes;
            try {
                if (base64 == null || base64.length() > 4 * ((CHUNK + 2) / 3))
                    throw new IllegalArgumentException("Chunk exceeds native limit");
                bytes = Base64.decode(base64, Base64.NO_WRAP);
                if (bytes.length == 0 || bytes.length > CHUNK) throw new IllegalArgumentException("Invalid chunk length");
            } catch (IllegalArgumentException error) { promise.reject("E_CHUNK", error.getMessage()); return; }
            Operation op = begin(operationId, promise, 10_000);
            if (op == null) return;
            op.link = link;
            try {
                op.future = writes.submit(() -> {
                    try {
                        // One ordered stream per link. The adapter awaits writes;
                        // this lock also prevents accidental concurrent interleave.
                        synchronized (link.writeLock) {
                            if (op.done.get() || link.closed.get()) return;
                            link.socket.getOutputStream().write(bytes);
                            link.socket.getOutputStream().flush();
                        }
                        main.post(() -> { if (active(op)) succeed(op, null); });
                    } catch (IOException error) {
                        main.post(() -> {
                            if (active(op)) fail(op, "E_WRITE", "Wi-Fi Direct write failed");
                            closeLink(link);
                        });
                    }
                });
            } catch (RejectedExecutionException error) {
                fail(op, "E_BUSY", "Wi-Fi Direct write capacity reached");
            }
        });
    }

    @ReactMethod public void disconnect(String linkId, Promise promise) {
        main.post(() -> {
            Link link = links.get(linkId);
            if (link != null) closeLink(link);
            promise.resolve(null);
        });
    }

    @ReactMethod public void cancel(String operationId) {
        main.post(() -> {
            Operation op = operations.get(operationId);
            if (op == null) return;
            boolean wasStart = op.link == null && op.endpoint == null;
            boolean wasConnect = pendingConnect == op;
            Link writing = op.link;
            fail(op, "E_CANCELLED", "Operation cancelled");
            if (writing != null) closeLink(writing);
            if (wasConnect) cancelConnectionOperation(op);
            if (wasStart) teardown(null);
        });
    }

    @ReactMethod public void stop(Promise promise) { main.post(() -> teardown(promise)); }

    private void teardown(Promise promise) {
        if (promise != null) stoppingPromises.add(promise);
        if (stopping) return;
        stopping = true;
        for (Link link : links.values()) {
            WritableMap value = event("disconnected"); value.putString("linkId", link.id); emit(value);
        }
        if (running) {
            WritableMap value = event("status"); WritableMap unavailable = Arguments.createMap();
            unavailable.putBoolean("available", false);
            String reason = unavailableReason(); unavailable.putString("reason", reason == null ? "unavailable" : reason);
            value.putMap("status", unavailable); emit(value);
        }
        running = false;
        generation++; // invalidates callbacks/data before any cleanup can resolve
        if (discoveryRetry != null) { main.removeCallbacks(discoveryRetry); discoveryRetry = null; }
        if (connectionRefresh != null) { main.removeCallbacks(connectionRefresh); connectionRefresh = null; }
        connectionQueryInFlight = false; refreshAgain = false;
        for (Operation op : new ArrayList<>(operations.values())) fail(op, "E_STOPPED", "Wi-Fi Direct stopped");
        closeConnections();
        Set<String> sessionAddresses = new HashSet<>();
        for (Peer peer : peers.values()) sessionAddresses.add(peer.address.toLowerCase(Locale.ROOT));
        peers.clear(); attemptedInGroup.clear(); cancelledEndpoints.clear();
        if (receiver != null) {
            try { context.unregisterReceiver(receiver); } catch (IllegalArgumentException ignored) { }
            receiver = null;
        }
        final WifiP2pManager.Channel oldChannel = channel;
        try {
            if (oldChannel != null) {
                manager.stopPeerDiscovery(oldChannel, ignoreAction());
                if (localService != null) manager.removeLocalService(oldChannel, localService, ignoreAction());
                if (serviceRequest != null) manager.removeServiceRequest(oldChannel, serviceRequest, ignoreAction());
            }
        } catch (RuntimeException ignored) { /* still release sockets and owned resources */ }
        localService = null; serviceRequest = null;
        AtomicBoolean finished = new AtomicBoolean();
        Runnable timeout = () -> finishStop(oldChannel, finished, "Timed out removing PalMesh's Wi-Fi Direct group");
        if (oldChannel == null) { finishStop(null, finished, null); return; }
        main.postDelayed(timeout, 6000);
        Runnable reconcile = () -> reconcileStoppedGroup(oldChannel, sessionAddresses, finished, timeout);
        if (initiatedConnect || cancellingConnect) {
            initiatedConnect = false;
            try {
                manager.cancelConnect(oldChannel, new WifiP2pManager.ActionListener() {
                    @Override public void onSuccess() { if (!finished.get()) reconcile.run(); }
                    @Override public void onFailure(int reason) { if (!finished.get()) reconcile.run(); }
                });
            } catch (RuntimeException error) { reconcile.run(); }
        } else reconcile.run();
    }

    private void reconcileStoppedGroup(WifiP2pManager.Channel oldChannel, Set<String> sessionAddresses,
            AtomicBoolean finished, Runnable timeout) {
        if (finished.get()) return;
        try {
            manager.requestGroupInfo(oldChannel, group -> {
                if (finished.get()) return;
                boolean sessionGroup = group != null && (ownsGroup || groupHasAddress(group, sessionAddresses));
                if (!sessionGroup) {
                    main.removeCallbacks(timeout); finishStop(oldChannel, finished, null); return;
                }
                try {
                    manager.removeGroup(oldChannel, new WifiP2pManager.ActionListener() {
                        @Override public void onSuccess() {
                            main.removeCallbacks(timeout); finishStop(oldChannel, finished, null);
                        }
                        @Override public void onFailure(int reason) {
                            main.removeCallbacks(timeout);
                            finishStop(oldChannel, finished, "Could not remove PalMesh's Wi-Fi Direct group (" + reason + ")");
                        }
                    });
                } catch (RuntimeException error) {
                    main.removeCallbacks(timeout); finishStop(oldChannel, finished, "Could not remove PalMesh's Wi-Fi Direct group");
                }
            });
        } catch (RuntimeException error) {
            main.removeCallbacks(timeout); finishStop(oldChannel, finished, "Could not reconcile Wi-Fi Direct group cleanup");
        }
    }

    private void finishStop(WifiP2pManager.Channel oldChannel, AtomicBoolean finished, String error) {
        if (!finished.compareAndSet(false, true)) return;
        if (oldChannel != null && Build.VERSION.SDK_INT >= 27) oldChannel.close();
        if (channel == oldChannel) channel = null;
        ownsGroup = false; groupOwner = false; ownerAddress = null; ownerEndpoint = null;
        cancellingConnect = false;
        removingCancelledGroup = false;
        stopping = false;
        for (Promise promise : stoppingPromises) {
            if (error == null) promise.resolve(null); else promise.reject("E_STOP", error);
        }
        stoppingPromises.clear();
    }

    private void cancelConnectionOperation(Operation op) {
        if (op.endpoint == null) return;
        cancelledEndpoints.add(op.endpoint);
        final int epoch = generation;
        Runnable reconcile = () -> {
            if (!current(epoch) || !op.createdGroup || !links.isEmpty()) return;
            refreshConnection(epoch);
        };
        if (initiatedConnect && channel != null) {
            initiatedConnect = false;
            cancellingConnect = true;
            try {
                manager.cancelConnect(channel, new WifiP2pManager.ActionListener() {
                    @Override public void onSuccess() {
                        if (current(epoch)) cancellingConnect = false;
                        reconcile.run();
                    }
                    @Override public void onFailure(int reason) {
                        if (current(epoch)) cancellingConnect = false;
                        reconcile.run();
                    }
                });
            } catch (RuntimeException ignored) { cancellingConnect = false; reconcile.run(); }
        } else reconcile.run();
    }

    private boolean groupMatchesCancelledEndpoint(WifiP2pGroup group) {
        Set<String> addresses = new HashSet<>();
        for (String endpoint : cancelledEndpoints) {
            Peer peer = peers.get(endpoint);
            if (peer != null) addresses.add(peer.address.toLowerCase(Locale.ROOT));
        }
        return groupHasAddress(group, addresses);
    }

    private static boolean groupHasAddress(WifiP2pGroup group, Set<String> addresses) {
        if (group.getOwner() != null && group.getOwner().deviceAddress != null
                && addresses.contains(group.getOwner().deviceAddress.toLowerCase(Locale.ROOT))) return true;
        for (WifiP2pDevice client : group.getClientList())
            if (client.deviceAddress != null && addresses.contains(client.deviceAddress.toLowerCase(Locale.ROOT))) return true;
        return false;
    }

    private void removeCancelledGroup(int epoch) {
        if (removingCancelledGroup || channel == null) return;
        removingCancelledGroup = true;
        try {
            manager.removeGroup(channel, new WifiP2pManager.ActionListener() {
                @Override public void onSuccess() {
                    if (!current(epoch)) return;
                    removingCancelledGroup = false; ownsGroup = false;
                    closeConnections(); ownerAddress = null; ownerEndpoint = null;
                    attemptedInGroup.clear(); scheduleDiscovery(2000);
                }
                @Override public void onFailure(int reason) {
                    if (!current(epoch)) return;
                    removingCancelledGroup = false;
                    emitError("Could not remove cancelled PalMesh Wi-Fi Direct group");
                }
            });
        } catch (RuntimeException error) {
            removingCancelledGroup = false;
            if (current(epoch)) emitError("Could not remove cancelled PalMesh Wi-Fi Direct group");
        }
    }

    private void closeConnections() {
        close(server); server = null;
        serverStartingEpoch = -1;
        for (Socket socket : handshakes) close(socket);
        handshakes.clear(); dialing.clear();
        for (Link link : new ArrayList<>(links.values())) closeLink(link);
    }

    private void closeLink(Link link) {
        if (!link.closed.compareAndSet(false, true)) return;
        links.remove(link.id);
        close(link.socket);
        for (Operation op : new ArrayList<>(operations.values()))
            if (op.link == link) fail(op, "E_DISCONNECTED", "Link disconnected");
        if (current(link.epoch)) {
            WritableMap event = event("disconnected"); event.putString("linkId", link.id); emit(event);
        }
    }

    private Operation begin(String id, Promise promise, long timeoutMs) {
        if (id == null || id.isEmpty() || id.length() > 256 || !id.equals(id.trim()) || operations.containsKey(id)
                || operations.size() >= MAX_OPERATIONS) {
            promise.reject("E_OPERATION", "Expected a unique operation ID within the pending-operation limit");
            return null;
        }
        Operation op = new Operation(id, promise, generation);
        operations.put(id, op);
        op.timeout = () -> {
            if (!active(op)) return;
            boolean wasStart = op.link == null && op.endpoint == null;
            boolean wasConnect = pendingConnect == op;
            Link writing = op.link;
            fail(op, "E_TIMEOUT", "Wi-Fi Direct operation timed out");
            if (writing != null) closeLink(writing);
            if (wasConnect) cancelConnectionOperation(op);
            if (wasStart) teardown(null);
        };
        main.postDelayed(op.timeout, timeoutMs);
        return op;
    }

    private boolean active(Operation op) { return current(op.epoch) && !op.done.get(); }
    private boolean current(int epoch) { return running && !stopping && generation == epoch && !destroyed; }
    private boolean currentVolatile(int epoch) { return generation == epoch; }

    private void succeed(Operation op, Object value) {
        if (!op.done.compareAndSet(false, true)) return;
        operations.remove(op.id); main.removeCallbacks(op.timeout);
        if (pendingConnect == op) pendingConnect = null;
        if (starting == op) starting = null;
        op.promise.resolve(value);
    }

    private void fail(Operation op, String code, String message) {
        if (!op.done.compareAndSet(false, true)) return;
        operations.remove(op.id); main.removeCallbacks(op.timeout);
        if (op.future != null) op.future.cancel(true);
        if (op.socket != null) { handshakes.remove(op.socket); close(op.socket); }
        if (pendingConnect == op) pendingConnect = null;
        if (starting == op) starting = null;
        op.promise.reject(code, message == null ? code : message);
    }

    private Link findLink(String endpoint) {
        for (Link link : links.values()) if (link.endpoint.equals(endpoint) && !link.closed.get()) return link;
        return null;
    }

    private WritableMap linkMap(Link link) {
        WritableMap value = Arguments.createMap();
        value.putString("id", link.id); value.putString("endpointId", link.endpoint); value.putInt("maxChunkBytes", CHUNK);
        return value;
    }

    private WritableMap event(String type) {
        WritableMap value = Arguments.createMap(); value.putString("type", type); return value;
    }

    private void emitError(String message) {
        WritableMap value = event("error"); value.putString("message", message); emit(value);
    }

    private void emit(WritableMap value) {
        if (destroyed || listenerCount == 0 || !context.hasActiveReactInstance()) return;
        context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class).emit(EVENT, value);
    }

    private void submitIo(Runnable task) { io.execute(task); }

    private static void close(Closeable resource) {
        if (resource != null) try { resource.close(); } catch (IOException ignored) { }
    }

    private static boolean validUuid(String value) {
        if (value == null || value.length() != 36) return false;
        try { return UUID.fromString(value).toString().equals(value.toLowerCase(Locale.ROOT)); }
        catch (IllegalArgumentException ignored) { return false; }
    }

    private static WifiP2pManager.ActionListener ignoreAction() {
        return new WifiP2pManager.ActionListener() {
            @Override public void onSuccess() { }
            @Override public void onFailure(int reason) { }
        };
    }

    @Override public void onHostResume() { }
    @Override public void onHostPause() { }
    @Override public void onHostDestroy() { main.post(() -> teardown(null)); }

    @Override public void invalidate() {
        main.post(() -> {
            destroyed = true;
            teardown(null);
            io.shutdownNow(); writes.shutdownNow();
            if (runtimeReceiverRegistered) { context.unregisterReceiver(runtimeStopReceiver); runtimeReceiverRegistered = false; }
            context.removeLifecycleEventListener(this);
        });
        super.invalidate();
    }

    private static final class Peer {
        final String endpoint;
        final String address;
        final long seenAt;
        Peer(String endpoint, String address, long seenAt) {
            this.endpoint = endpoint; this.address = address; this.seenAt = seenAt;
        }
    }

    private static final class Link {
        final String id;
        final String endpoint;
        final Socket socket;
        final int epoch;
        final Object writeLock = new Object();
        final Semaphore incoming = new Semaphore(16);
        final AtomicBoolean closed = new AtomicBoolean();
        Link(String id, String endpoint, Socket socket, int epoch) {
            this.id = id; this.endpoint = endpoint; this.socket = socket; this.epoch = epoch;
        }
    }

    private static final class Operation {
        final String id;
        final Promise promise;
        final int epoch;
        final AtomicBoolean done = new AtomicBoolean();
        Runnable timeout;
        Future<?> future;
        Socket socket;
        Link link;
        String endpoint;
        boolean createdGroup;
        Operation(String id, Promise promise, int epoch) {
            this.id = id; this.promise = promise; this.epoch = epoch;
        }
    }
}
