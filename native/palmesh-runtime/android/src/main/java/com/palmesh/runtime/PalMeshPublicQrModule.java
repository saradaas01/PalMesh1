package com.palmesh.runtime;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.CancellationSignal;
import android.os.Handler;
import android.os.Looper;
import com.facebook.react.bridge.*;
import com.google.zxing.*;
import com.google.zxing.common.HybridBinarizer;
import com.google.zxing.multi.qrcode.QRCodeMultiReader;
import java.io.*;
import java.util.*;
import java.util.concurrent.*;

/** Explicit, scoped image selection; no camera/storage permission or network API. */
public final class PalMeshPublicQrModule extends ReactContextBaseJavaModule implements ActivityEventListener {
    private static final int REQUEST = 0x504d;
    private final ExecutorService worker = new ThreadPoolExecutor(1,1,0,TimeUnit.SECONDS,new ArrayBlockingQueue<>(1));
    private final Handler ui = new Handler(Looper.getMainLooper());
    private Promise pending;
    private CancellationSignal cancellation;
    private long generation;
    private boolean invalid;
    public PalMeshPublicQrModule(ReactApplicationContext context) { super(context); context.addActivityEventListener(this); }
    @Override public String getName() { return "PalMeshPublicQr"; }
    @ReactMethod public void scanImage(Promise promise) {
        ui.post(() -> {
            if (invalid || pending != null || getCurrentActivity() == null) { promise.reject("QR_UNAVAILABLE","Image selection unavailable or busy"); return; }
            pending = promise; generation++;
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("image/*").addCategory(Intent.CATEGORY_OPENABLE);
            intent.putExtra(Intent.EXTRA_LOCAL_ONLY,true);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            try { getCurrentActivity().startActivityForResult(intent,REQUEST); }
            catch (Exception error) { finish(null,"QR_UNAVAILABLE"); }
        });
    }
    @Override public void onActivityResult(Activity activity, int request, int result, Intent data) {
        if (request != REQUEST) return;
        ui.post(() -> {
            if (pending == null) return;
            if (result != Activity.RESULT_OK || data == null || data.getData() == null) { finish(null,null); return; }
            Uri uri = data.getData();
            if (!"content".equals(uri.getScheme())) { finish(null,"QR_INVALID_IMAGE"); return; }
            final long operation = generation;
            cancellation = new CancellationSignal(); final CancellationSignal signal = cancellation;
            ui.postDelayed(() -> { if (pending != null && generation == operation) finish(null,"QR_TIMEOUT"); },15000);
            try {
                worker.execute(() -> {
                    Bitmap bitmap = null;
                    String text = null; String error = null;
                    try (android.content.res.AssetFileDescriptor file = getReactApplicationContext().getContentResolver().openAssetFileDescriptor(uri,"r",signal)) {
                        if (file == null) throw new IOException();
                        byte[] bytes;
                        try (InputStream input = file.createInputStream(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                            byte[] chunk = new byte[8192]; int read;
                            while ((read=input.read(chunk)) != -1) {
                                if (signal.isCanceled() || output.size()+read > 8*1024*1024) throw new IOException();
                                output.write(chunk,0,read);
                            }
                            bytes=output.toByteArray();
                        }
                        BitmapFactory.Options bounds = new BitmapFactory.Options(); bounds.inJustDecodeBounds=true;
                        BitmapFactory.decodeByteArray(bytes,0,bytes.length,bounds);
                        if (bounds.outWidth <= 0 || bounds.outHeight <= 0 || bounds.outWidth > 100000 || bounds.outHeight > 100000) throw new IOException();
                        BitmapFactory.Options options = new BitmapFactory.Options(); options.inSampleSize=1;
                        while (bounds.outWidth/options.inSampleSize > 2048 || bounds.outHeight/options.inSampleSize > 2048) options.inSampleSize *= 2;
                        options.inPreferredConfig=Bitmap.Config.ARGB_8888;
                        bitmap=BitmapFactory.decodeByteArray(bytes,0,bytes.length,options);
                        if (bitmap == null) throw new IOException();
                        int width=bitmap.getWidth(),height=bitmap.getHeight(); int[] pixels=new int[width*height];
                        bitmap.getPixels(pixels,0,width,0,0,width,height);
                        BinaryBitmap source=new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(width,height,pixels)));
                        Map<DecodeHintType,Object> hints=new EnumMap<>(DecodeHintType.class); hints.put(DecodeHintType.TRY_HARDER,Boolean.TRUE);
                        Result[] results=new QRCodeMultiReader().decodeMultiple(source,hints);
                        if (results.length != 1) throw new IOException();
                        text=results[0].getText();
                        if (text == null || text.getBytes(java.nio.charset.StandardCharsets.UTF_8).length > 2048) throw new IOException();
                    } catch (Exception failure) { error="QR_INVALID_IMAGE"; }
                    finally { if (bitmap != null) bitmap.recycle(); }
                    final String value=text, failure=error;
                    ui.post(() -> { if (pending != null && operation == generation) finish(value,failure); });
                });
            } catch (RejectedExecutionException error) { finish(null,"QR_UNAVAILABLE"); }
        });
    }
    private void finish(String text, String error) {
        Promise promise=pending; pending=null; generation++;
        if (cancellation != null) { cancellation.cancel(); cancellation=null; }
        if (promise == null) return;
        if (error == null) promise.resolve(text); else promise.reject(error,"Choose a clear locally available image containing one public identity QR");
    }
    @Override public void onNewIntent(Intent intent) { }
    @Override public void invalidate() {
        ui.post(() -> { invalid=true; finish(null,"QR_UNAVAILABLE"); });
        getReactApplicationContext().removeActivityEventListener(this); worker.shutdownNow(); super.invalidate();
    }
}
