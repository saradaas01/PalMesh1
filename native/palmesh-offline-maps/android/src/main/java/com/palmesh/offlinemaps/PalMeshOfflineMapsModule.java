package com.palmesh.offlinemaps;

import android.content.res.AssetManager;
import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.net.ConnectivityManager;
import android.util.Log;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.os.CancellationSignal;
import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.ReadableMap;
import com.facebook.react.bridge.WritableArray;
import com.facebook.react.bridge.WritableMap;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.GZIPInputStream;
import org.json.JSONArray;
import org.json.JSONObject;

/** Opens only bundled, read-only vector MBTiles. No public network requests are made. */
public final class PalMeshOfflineMapsModule extends ReactContextBaseJavaModule {
    private static final long MAX_ASSET_BYTES = 8L * 1024 * 1024 * 1024;
    // Keep a blob comfortably below Android's default CursorWindow size and bound RAM.
    private static final int MAX_TILE_BYTES = 1024 * 1024;
    private static final Pattern ASSET = Pattern.compile("palmesh/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}\\.mbtiles");
    private static final Pattern LAYER = Pattern.compile("[A-Za-z_][A-Za-z0-9_-]{0,127}");
    private static final Pattern TILE = Pattern.compile("/([a-f0-9]{32})/([0-9]{1,2})/([0-9]{1,7})/([0-9]{1,7})\\.pbf");
    private static final Pattern GLYPH = Pattern.compile("/([a-f0-9]{32})/fonts/([^/]+)/([0-9]{1,5})-([0-9]{1,5})\\.pbf");
    private static final String FONT_STACK = "Klokantech Noto Sans Regular";
    private final ExecutorService lifecycle = Executors.newSingleThreadExecutor();
    private final AtomicLong generation = new AtomicLong();
    private final AtomicReference<CancellationSignal> openingCancellation = new AtomicReference<>();
    private volatile boolean invalidated;
    // Only the lifecycle executor owns the session; shutdown closes worker sockets before DB.
    private TileHost host;

    public PalMeshOfflineMapsModule(ReactApplicationContext context) { super(context); }

    @Override public String getName() { return "PalMeshOfflineMaps"; }
    @Override public Map<String, Object> getConstants() {
        Map<String, Object> constants = new HashMap<>();
        constants.put("renderDiagnosticsEnabled", (getReactApplicationContext().getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0);
        return constants;
    }

    @ReactMethod public synchronized void open(ReadableMap options, Promise promise) {
        final String assetName;
        final String expected;
        try {
            assetName = options.hasKey("assetName") ? options.getString("assetName") : "palmesh/palestine.mbtiles";
            expected = options.hasKey("expectedSha256") ? options.getString("expectedSha256") : null;
            if (assetName == null || !ASSET.matcher(assetName).matches()) throw new IOException("Invalid bundled asset name");
            if (expected != null && !expected.matches("[a-fA-F0-9]{64}")) throw new IOException("Invalid SHA-256 checksum");
        } catch (Exception error) { promise.reject("E_MAP_CONFIG", error.getMessage(), error); return; }
        final long operation = generation.incrementAndGet();
        final CancellationSignal cancellation = new CancellationSignal();
        CancellationSignal previous = openingCancellation.getAndSet(cancellation);
        if (previous != null) previous.cancel();
        try {
            lifecycle.execute(() -> {
                TileHost candidate = null;
                try {
                    checkCurrent(operation);
                    closeHost();
                    File file = prepareAsset(assetName, expected, operation);
                    checkCurrent(operation);
                    candidate = new TileHost(file, cancellation, getReactApplicationContext().getAssets(),
                        (getReactApplicationContext().getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0);
                    checkCurrent(operation);
                    pruneCopies(file);
                    host = candidate;
                    candidate = null;
                    promise.resolve(host.descriptor());
                } catch (Exception error) {
                    if (candidate != null) candidate.close();
                    promise.reject("E_OFFLINE_MAP", error.getMessage(), error);
                } finally {
                    openingCancellation.compareAndSet(cancellation, null);
                }
            });
        } catch (RejectedExecutionException error) {
            openingCancellation.compareAndSet(cancellation, null);
            promise.reject("E_MAP_CLOSED", "Offline maps module is closed", error);
        }
    }

    /** Debug-only aggregate evidence; no resource URLs, keys, feature text or coordinates. */
    @ReactMethod public void recordRenderEvidence(double geometry, double roads, double labels, double arabic, Promise promise) {
        if ((getReactApplicationContext().getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) == 0) { promise.resolve(null); return; }
        for (double value : new double[] { geometry, roads, labels, arabic }) {
            if (!Double.isFinite(value) || value < 0 || value > 1000000 || value != Math.floor(value)) {
                promise.reject("E_MAP_EVIDENCE", "Invalid bounded render counts"); return;
            }
        }
        try {
            lifecycle.execute(() -> {
                try {
                    if (host == null) { promise.resolve(null); return; }
                    JSONObject data = new JSONObject();
                    data.put("geometry", (int) geometry); data.put("roads", (int) roads);
                    data.put("labels", (int) labels); data.put("arabicLabels", (int) arabic);
                    data.put("tileRequests", host.tileRequests.get()); data.put("tileHits", host.tileHits.get());
                    data.put("glyphRequests", host.glyphRequests.get()); data.put("glyphHits", host.glyphHits.get());
                    data.put("loopbackOnly", host.server.getInetAddress().isLoopbackAddress());
                    ConnectivityManager connectivity = (ConnectivityManager) getReactApplicationContext().getSystemService(Context.CONNECTIVITY_SERVICE);
                    android.net.NetworkInfo active = connectivity.getActiveNetworkInfo();
                    data.put("androidInternetConnected", active != null && active.isConnected());
                    data.put("sdkConnected", Class.forName("org.maplibre.android.MapLibre").getMethod("isConnected").invoke(null));
                    Log.i("PalMeshOfflineMap", "render_evidence " + data.toString());
                    promise.resolve(null);
                } catch (Exception error) { promise.reject("E_MAP_EVIDENCE", "Cannot collect map evidence"); }
            });
        } catch (RejectedExecutionException error) { promise.resolve(null); }
    }

    @ReactMethod public synchronized void close(Promise promise) {
        generation.incrementAndGet(); // Cancels a large asset copy before the queued cleanup runs.
        CancellationSignal pending = openingCancellation.get();
        if (pending != null) pending.cancel();
        try {
            lifecycle.execute(() -> {
                closeHost();
                promise.resolve(null);
            });
        } catch (RejectedExecutionException error) { promise.resolve(null); }
    }

    @Override public synchronized void invalidate() {
        invalidated = true;
        generation.incrementAndGet();
        CancellationSignal pending = openingCancellation.get();
        if (pending != null) pending.cancel();
        try { lifecycle.execute(this::closeHost); } catch (RejectedExecutionException ignored) { }
        lifecycle.shutdown();
        super.invalidate();
    }

    private void closeHost() {
        if (host != null) { host.close(); host = null; }
    }

    private void checkCurrent(long operation) throws IOException {
        if (invalidated || generation.get() != operation) throw new IOException("Offline map opening cancelled");
    }

    private File prepareAsset(String assetName, String expected, long operation) throws Exception {
        File directory = new File(getReactApplicationContext().getNoBackupFilesDir(), "palmesh-offline-maps");
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("Cannot create map storage directory");
        // Asset identity includes APK update time: a new bundled map replaces an old retained copy.
        long updatedAt = getReactApplicationContext().getPackageManager().getPackageInfo(
            getReactApplicationContext().getPackageName(), 0).lastUpdateTime;
        String key = hex(MessageDigest.getInstance("SHA-256").digest((assetName + ":" + updatedAt).getBytes(StandardCharsets.UTF_8)));
        File destination = new File(directory, key + ".mbtiles");
        if (destination.isFile()) {
            if (destination.length() <= 0 || destination.length() > MAX_ASSET_BYTES) throw new IOException("Invalid retained map file size");
            if (expected == null || expected.equalsIgnoreCase(digest(destination, operation))) return destination;
            // A corrupt retained copy is replaced from the immutable bundled asset.
            if (!destination.delete()) throw new IOException("Cannot replace failed-checksum map file");
        }
        File temporary = new File(directory, key + ".copying");
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            try (InputStream input = getReactApplicationContext().getAssets().open(assetName);
                 FileOutputStream output = new FileOutputStream(temporary, false)) {
                byte[] buffer = new byte[65536];
                long total = 0;
                int count;
                while ((count = input.read(buffer)) != -1) {
                    checkCurrent(operation);
                    total += count;
                    if (total > MAX_ASSET_BYTES) throw new IOException("Bundled MBTiles exceeds size limit");
                    output.write(buffer, 0, count);
                    digest.update(buffer, 0, count);
                }
                if (total == 0) throw new IOException("Bundled MBTiles is empty");
                output.getFD().sync();
            }
            if (expected != null && !expected.equalsIgnoreCase(hex(digest.digest()))) throw new IOException("Bundled MBTiles checksum mismatch");
            checkCurrent(operation);
            if (!temporary.renameTo(destination)) throw new IOException("Cannot retain bundled map file");
            return destination;
        } finally { if (temporary.exists()) temporary.delete(); }
    }

    private void pruneCopies(File retained) {
        // Only one native session is owned at a time. Remove obsolete APK/asset copies
        // after validating the replacement, including when reusing a retained good copy.
        File[] previousCopies = retained.getParentFile().listFiles();
        if (previousCopies != null) for (File previous : previousCopies) {
            if (!previous.equals(retained) && previous.getName().matches("[a-f0-9]{64}\\.(mbtiles|copying)")) previous.delete();
        }
    }

    private String digest(File file, long operation) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream input = new FileInputStream(file)) {
            byte[] buffer = new byte[65536];
            int count;
            while ((count = input.read(buffer)) != -1) { checkCurrent(operation); digest.update(buffer, 0, count); }
        }
        return hex(digest.digest());
    }

    private static String hex(byte[] bytes) {
        StringBuilder result = new StringBuilder(bytes.length * 2);
        for (byte item : bytes) result.append(String.format(java.util.Locale.ROOT, "%02x", item & 255));
        return result.toString();
    }

    private static final class TileHost {
        final SQLiteDatabase database;
        final AssetManager assets;
        final boolean bundledFonts;
        final ServerSocket server;
        final Thread acceptThread;
        final ThreadPoolExecutor workers;
        final ScheduledExecutorService deadlines = Executors.newSingleThreadScheduledExecutor();
        final Set<Socket> clients = Collections.synchronizedSet(new HashSet<>());
        final Set<CancellationSignal> cancellations = Collections.synchronizedSet(new HashSet<>());
        final String token;
        final double[] bounds;
        final int minZoom;
        final int maxZoom;
        final List<String> layers;
        final String attribution;
        volatile boolean closed;
        final boolean debug;
        final AtomicLong tileRequests = new AtomicLong(), tileHits = new AtomicLong();
        final AtomicLong glyphRequests = new AtomicLong(), glyphHits = new AtomicLong();
        void trace(String message) { if (debug) Log.i("PalMeshOfflineMap", message); }

        TileHost(File file, CancellationSignal opening, AssetManager assetManager, boolean debugBuild) throws Exception {
            debug = debugBuild;
            assets = assetManager;
            boolean foundFonts;
            try (InputStream probe = assets.open("palmesh/fonts/" + FONT_STACK + "/0-255.pbf")) { foundFonts = probe.read() >= 0; }
            catch (IOException missing) { foundFonts = false; }
            bundledFonts = foundFonts;
            database = SQLiteDatabase.openDatabase(file.getAbsolutePath(), null, SQLiteDatabase.OPEN_READONLY | SQLiteDatabase.NO_LOCALIZED_COLLATORS);
            ServerSocket pendingServer = null;
            try {
                Map<String, String> metadata = new HashMap<>();
                try (Cursor cursor = database.rawQuery("SELECT CASE WHEN length(name)<=128 THEN name END, CASE WHEN length(value)<=262144 THEN value END FROM metadata LIMIT 257", null, opening)) {
                    while (cursor.moveToNext()) {
                        String name = cursor.getString(0), value = cursor.getString(1);
                        if (name == null || value == null || name.length() > 128 || value.length() > 262144 || metadata.put(name, value) != null) {
                            throw new IOException("Invalid MBTiles metadata");
                        }
                    }
                }
                if (metadata.size() > 256 || !"pbf".equalsIgnoreCase(metadata.get("format"))) throw new IOException("A vector PBF MBTiles asset is required");
                String scheme = metadata.get("scheme");
                if (scheme != null && !"tms".equalsIgnoreCase(scheme)) throw new IOException("MBTiles must use the TMS row scheme");
                minZoom = integer(metadata.get("minzoom"));
                maxZoom = integer(metadata.get("maxzoom"));
                if (minZoom < 0 || maxZoom > 22 || minZoom > maxZoom) throw new IOException("Invalid MBTiles zoom range");
                String boundsText = metadata.get("bounds");
                String[] components = boundsText == null ? new String[0] : boundsText.split(",", -1);
                if (components.length != 4) throw new IOException("MBTiles bounds are required");
                bounds = new double[4];
                for (int index = 0; index < 4; index++) {
                    bounds[index] = Double.parseDouble(components[index].trim());
                    if (!Double.isFinite(bounds[index])) throw new IOException("Invalid MBTiles bounds");
                }
                if (bounds[0] < -180 || bounds[2] > 180 || bounds[1] < -90 || bounds[3] > 90 || bounds[0] >= bounds[2] || bounds[1] >= bounds[3]) throw new IOException("Invalid MBTiles bounds");
                JSONObject json = new JSONObject(required(metadata, "json"));
                JSONArray sourceLayers = json.getJSONArray("vector_layers");
                if (sourceLayers.length() < 1 || sourceLayers.length() > 128) throw new IOException("Invalid vector source layers");
                layers = new ArrayList<>();
                for (int index = 0; index < sourceLayers.length(); index++) {
                    String layer = sourceLayers.getJSONObject(index).getString("id");
                    if (!LAYER.matcher(layer).matches() || layers.contains(layer)) throw new IOException("Invalid vector source layer name");
                    layers.add(layer);
                }
                // MBTiles attribution is commonly HTML. Return inert readable text to the UI.
                attribution = plainAttribution(metadata.get("attribution"));
                try (Cursor cursor = database.rawQuery("SELECT tile_data FROM tiles WHERE length(tile_data) BETWEEN 1 AND ? LIMIT 1", new String[] { Integer.toString(MAX_TILE_BYTES) }, opening)) {
                    if (!cursor.moveToFirst() || !isVectorTile(cursor.getBlob(0))) throw new IOException("MBTiles has no valid vector tile data");
                }
                byte[] random = new byte[16];
                new SecureRandom().nextBytes(random);
                token = hex(random);
                pendingServer = new ServerSocket();
                pendingServer.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0), 16);
                server = pendingServer;
                workers = new ThreadPoolExecutor(2, 2, 0, TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(16));
                acceptThread = new Thread(this::accept, "PalMeshOfflineTiles");
                acceptThread.setDaemon(true);
                acceptThread.start();
                trace("server_started loopback=true");
            } catch (Exception error) {
                if (pendingServer != null) try { pendingServer.close(); } catch (IOException ignored) { }
                database.close();
                throw error;
            }
        }

        WritableMap descriptor() {
            WritableMap value = Arguments.createMap();
            value.putString("tileUrlTemplate", "http://127.0.0.1:" + server.getLocalPort() + "/" + token + "/{z}/{x}/{y}.pbf");
            if (bundledFonts) value.putString("glyphUrlTemplate", "http://127.0.0.1:" + server.getLocalPort() + "/" + token + "/fonts/{fontstack}/{range}.pbf");
            WritableArray area = Arguments.createArray();
            for (double coordinate : bounds) area.pushDouble(coordinate);
            value.putArray("bounds", area);
            value.putInt("minZoom", minZoom);
            value.putInt("maxZoom", maxZoom);
            WritableArray sourceLayers = Arguments.createArray();
            for (String layer : layers) sourceLayers.pushString(layer);
            value.putArray("sourceLayers", sourceLayers);
            value.putString("attribution", attribution);
            return value;
        }

        void accept() {
            while (!closed) {
                try {
                    Socket client = server.accept();
                    if (!client.getInetAddress().isLoopbackAddress() || closed) { client.close(); continue; }
                    client.setSoTimeout(3000);
                    clients.add(client);
                    try { workers.execute(() -> serve(client)); }
                    catch (RejectedExecutionException error) { clients.remove(client); client.close(); }
                } catch (IOException error) { if (!closed) close(); }
            }
        }

        void serve(Socket client) {
            CancellationSignal cancelled = new CancellationSignal();
            synchronized (cancellations) {
                if (closed) {
                    try { client.close(); } catch (IOException ignored) { }
                    clients.remove(client);
                    return;
                }
                cancellations.add(cancelled);
            }
            final ScheduledFuture<?> deadline;
            try {
                deadline = deadlines.schedule(() -> {
                    cancelled.cancel();
                    try { client.close(); } catch (IOException ignored) { }
                }, 5, TimeUnit.SECONDS);
            } catch (RejectedExecutionException error) {
                try { client.close(); } catch (IOException ignored) { }
                clients.remove(client);
                cancellations.remove(cancelled);
                return;
            }
            try (Socket ignored = client; InputStream input = client.getInputStream(); OutputStream output = client.getOutputStream()) {
                String request = readHeaders(input);
                String[] lines = request.split("\\r\\n");
                String[] first = lines[0].split(" ", -1);
                if (first.length != 3 || !"GET".equals(first[0]) || !"HTTP/1.1".equals(first[2])) { respond(output, 400, null); return; }
                boolean validHost = false;
                for (int index = 1; index < lines.length; index++) {
                    String line = lines[index];
                    if (line.regionMatches(true, 0, "Host:", 0, 5)) {
                        if (validHost || !line.substring(5).trim().equals("127.0.0.1:" + server.getLocalPort())) { respond(output, 400, null); return; }
                        validHost = true;
                    }
                }
                if (!validHost) { respond(output, 400, null); return; }
                Matcher glyph = GLYPH.matcher(first[1]);
                if (glyph.matches() && token.equals(glyph.group(1)) && bundledFonts) {
                    glyphRequests.incrementAndGet();
                    String font = URLDecoder.decode(glyph.group(2), "UTF-8");
                    int start = Integer.parseInt(glyph.group(3)), end = Integer.parseInt(glyph.group(4));
                    if (!FONT_STACK.equals(font) || start % 256 != 0 || end != start + 255 || end > 65535) {
                        respond(output, 404, null); return;
                    }
                    // The path is reconstructed from a fixed font name and bounded integers.
                    // No caller-supplied asset path reaches AssetManager.
                    try (InputStream fontInput = assets.open("palmesh/fonts/" + FONT_STACK + "/" + start + "-" + end + ".pbf");
                         ByteArrayOutputStream data = new ByteArrayOutputStream()) {
                        byte[] chunk = new byte[8192];
                        int count;
                        while ((count = fontInput.read(chunk)) != -1) {
                            if (data.size() + count > 512 * 1024) throw new IOException("Glyph page exceeds limit");
                            data.write(chunk, 0, count);
                        }
                        respond(output, 200, data.toByteArray());
                        glyphHits.incrementAndGet(); trace("local_glyph status=200 bytes=" + data.size());
                    } catch (IOException missing) { respond(output, 404, null); }
                    return;
                }
                Matcher path = TILE.matcher(first[1]);
                if (!path.matches() || !token.equals(path.group(1))) { respond(output, 404, null); return; }
                tileRequests.incrementAndGet();
                int zoom = Integer.parseInt(path.group(2));
                long column = Long.parseLong(path.group(3)), row = Long.parseLong(path.group(4));
                if (zoom < minZoom || zoom > maxZoom || zoom > 22 || column >= (1L << zoom) || row >= (1L << zoom)) { respond(output, 404, null); return; }
                // MapLibre requests XYZ rows (north origin); MBTiles stores TMS (south origin).
                long tmsRow = (1L << zoom) - 1 - row;
                byte[] tile = null;
                try (Cursor cursor = database.rawQuery("SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=? AND length(tile_data) BETWEEN 1 AND ? LIMIT 1",
                    new String[] { Integer.toString(zoom), Long.toString(column), Long.toString(tmsRow), Integer.toString(MAX_TILE_BYTES) }, cancelled)) {
                    if (cursor.moveToFirst()) tile = cursor.getBlob(0);
                }
                if (tile != null && !isVectorTile(tile)) tile = null;
                respond(output, tile == null ? 404 : 200, tile);
                if (tile != null) tileHits.incrementAndGet();
                trace("local_tile status=" + (tile == null ? 404 : 200) + " bytes=" + (tile == null ? 0 : tile.length));
            } catch (Exception ignored) {
                // Closing a session interrupts socket reads/SQLite queries; never retain failed clients.
            } finally { deadline.cancel(false); cancellations.remove(cancelled); clients.remove(client); }
        }

        synchronized void close() {
            if (closed) return;
            closed = true;
            try { server.close(); } catch (IOException ignored) { }
            // Cancel SQLite work before stopping its deadline scheduler or closing DB.
            synchronized (cancellations) {
                for (CancellationSignal cancelled : cancellations) cancelled.cancel();
                cancellations.clear();
            }
            synchronized (clients) {
                for (Socket client : clients) try { client.close(); } catch (IOException ignored) { }
                clients.clear();
            }
            workers.shutdownNow();
            deadlines.shutdownNow();
            database.close();
        }

        static String readHeaders(InputStream input) throws IOException {
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            int matched = 0;
            byte[] ending = new byte[] { 13, 10, 13, 10 };
            while (buffer.size() < 8192) {
                int value = input.read();
                if (value < 0 || value > 127 || (value < 32 && value != 13 && value != 10 && value != 9)) throw new IOException("Invalid HTTP request");
                buffer.write(value);
                matched = value == ending[matched] ? matched + 1 : (value == 13 ? 1 : 0);
                if (matched == 4) return buffer.toString(StandardCharsets.US_ASCII.name());
            }
            throw new IOException("HTTP headers exceed limit");
        }

        static void respond(OutputStream output, int status, byte[] data) throws IOException {
            byte[] body = data == null ? new byte[0] : data;
            boolean gzip = body.length >= 2 && (body[0] & 255) == 31 && (body[1] & 255) == 139;
            String header = "HTTP/1.1 " + status + (status == 200 ? " OK" : status == 404 ? " Not Found" : " Bad Request") + "\r\n"
                + "Content-Type: application/vnd.mapbox-vector-tile\r\nContent-Length: " + body.length + "\r\n"
                + (gzip ? "Content-Encoding: gzip\r\n" : "")
                + "Cache-Control: private, max-age=86400\r\nConnection: close\r\nX-Content-Type-Options: nosniff\r\n\r\n";
            output.write(header.getBytes(StandardCharsets.US_ASCII));
            output.write(body);
            output.flush();
        }

        static String required(Map<String, String> metadata, String key) throws IOException {
            String value = metadata.get(key);
            if (value == null) throw new IOException("MBTiles metadata missing " + key);
            return value;
        }

        /** MVT is a protobuf Tile: top-level repeated field 3 contains Layer messages.
         * Validate framing and bound decompression, without interpreting feature geometry. */
        static boolean isVectorTile(byte[] stored) throws IOException {
            if (stored == null || stored.length == 0 || stored.length > MAX_TILE_BYTES) return false;
            byte[] bytes = stored;
            if (stored.length > 1 && (stored[0] & 255) == 31 && (stored[1] & 255) == 139) {
                try (InputStream gzip = new GZIPInputStream(new java.io.ByteArrayInputStream(stored));
                     ByteArrayOutputStream decoded = new ByteArrayOutputStream()) {
                    byte[] chunk = new byte[16384];
                    int count;
                    while ((count = gzip.read(chunk)) != -1) {
                        if (decoded.size() + count > 4 * 1024 * 1024) return false;
                        decoded.write(chunk, 0, count);
                    }
                    bytes = decoded.toByteArray();
                }
            }
            int[] offset = new int[] { 0 };
            boolean layer = false;
            while (offset[0] < bytes.length) {
                long tag = varint(bytes, offset);
                if (tag <= 0 || tag > 0xffffffffL) return false;
                int wireType = (int) (tag & 7);
                if (tag == 26) layer = true;
                long length;
                switch (wireType) {
                    case 0: if (varint(bytes, offset) < 0) return false; continue;
                    case 1: length = 8; break;
                    case 2: length = varint(bytes, offset); break;
                    case 5: length = 4; break;
                    default: return false;
                }
                if (length < 0 || length > bytes.length - offset[0]) return false;
                offset[0] += (int) length;
            }
            return layer;
        }

        static long varint(byte[] bytes, int[] offset) {
            long value = 0;
            for (int shift = 0; shift < 63 && offset[0] < bytes.length; shift += 7) {
                int next = bytes[offset[0]++] & 255;
                value |= (long) (next & 127) << shift;
                if ((next & 128) == 0) return value;
            }
            return -1;
        }

        static int integer(String value) throws IOException {
            if (value == null || !value.matches("[0-9]{1,2}")) throw new IOException("MBTiles zoom metadata is required");
            return Integer.parseInt(value);
        }

        static String plainAttribution(String value) throws IOException {
            if (value == null) return "";
            if (value.length() > 8192) throw new IOException("MBTiles attribution is too long");
            String plain = value.replaceAll("<[^>]*>", "").replace("&copy;", "©").replace("&amp;", "&")
                .replace("&lt;", "").replace("&gt;", "").replace("&quot;", "\"").replace("&#39;", "'")
                .replaceAll("[<>\\p{Cntrl}]", " ").trim();
            if (plain.length() > 1024) throw new IOException("MBTiles attribution is too long");
            return plain;
        }
    }
}
