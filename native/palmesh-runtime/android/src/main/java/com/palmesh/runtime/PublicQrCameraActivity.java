package com.palmesh.runtime;
import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.*;
import android.hardware.Camera;
import android.os.*;
import android.view.*;
import android.widget.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;

/** Camera exists only during this explicit user action. No image is saved. */
@SuppressWarnings("deprecation")
public final class PublicQrCameraActivity extends Activity implements SurfaceHolder.Callback,Camera.PreviewCallback {
    private SurfaceView surface;
    private Camera camera;
    private final ExecutorService decoder=Executors.newSingleThreadExecutor();
    private final AtomicBoolean decoding=new AtomicBoolean(false);
    private long nextFrame;
    private boolean resumed,finished,ready,previewLogged;
    private int generation;
    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        boolean ar="ar".equals(getIntent().getStringExtra("language"));
        FrameLayout root=new FrameLayout(this);root.setBackgroundColor(Color.rgb(15,29,34));
        root.setLayoutDirection(ar?View.LAYOUT_DIRECTION_RTL:View.LAYOUT_DIRECTION_LTR);
        surface=new SurfaceView(this);root.addView(surface,new FrameLayout.LayoutParams(-1,-1));
        root.addView(new View(this){final Paint paint=new Paint(3);@Override protected void onDraw(Canvas canvas){float s=Math.min(getWidth(),getHeight())*.72f,l=(getWidth()-s)/2,t=(getHeight()-s)/2;paint.setStyle(Paint.Style.FILL);paint.setColor(0x99000000);canvas.drawRect(0,0,getWidth(),t,paint);canvas.drawRect(0,t+s,getWidth(),getHeight(),paint);canvas.drawRect(0,t,l,t+s,paint);canvas.drawRect(l+s,t,getWidth(),t+s,paint);paint.setStyle(Paint.Style.STROKE);paint.setStrokeWidth(6);paint.setColor(Color.WHITE);canvas.drawRoundRect(l,t,l+s,t+s,20,20,paint);}},new FrameLayout.LayoutParams(-1,-1));
        LinearLayout controls=new LinearLayout(this);controls.setOrientation(LinearLayout.VERTICAL);controls.setPadding(24,32,24,32);controls.setBackgroundColor(0xDD10242B);
        TextView title=new TextView(this);title.setText(ar?"ضع رمز PalMesh داخل الإطار":"Place a PalMesh QR code inside the frame");title.setTextColor(Color.WHITE);title.setTextSize(19);title.setGravity(Gravity.CENTER);controls.addView(title);
        Button cancel=new Button(this);cancel.setText(ar?"إلغاء":"Cancel");cancel.setContentDescription(ar?"إلغاء المسح":"Cancel scanning");cancel.setMinHeight(Math.round(52*getResources().getDisplayMetrics().density));cancel.setOnClickListener(v->finishResult(null,null));controls.addView(cancel);
        FrameLayout.LayoutParams params=new FrameLayout.LayoutParams(-1,-2,Gravity.BOTTOM);root.addView(controls,params);root.setOnApplyWindowInsetsListener((v,insets)->{controls.setPadding(24,32,24,32+insets.getSystemWindowInsetBottom());return insets;});setContentView(root);surface.getHolder().addCallback(this);
        if(!getPackageManager().hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)){finishResult(null,"QR_NO_CAMERA");return;}
        if(checkSelfPermission(Manifest.permission.CAMERA)!=PackageManager.PERMISSION_GRANTED)requestPermissions(new String[]{Manifest.permission.CAMERA},441);
    }
    @Override protected void onResume(){super.onResume();resumed=true;open();}
    @Override protected void onPause(){resumed=false;closeCamera();super.onPause();}
    @Override public void onRequestPermissionsResult(int request,String[] permissions,int[] grants){super.onRequestPermissionsResult(request,permissions,grants);if(request==441){if(grants.length==1&&grants[0]==PackageManager.PERMISSION_GRANTED)open();else finishResult(null,"QR_CAMERA_DENIED");}}
    private void open(){
        if(finished||!resumed||!ready||camera!=null||checkSelfPermission(Manifest.permission.CAMERA)!=PackageManager.PERMISSION_GRANTED)return;
        try {
            int id=0;Camera.CameraInfo info=new Camera.CameraInfo();for(int i=0;i<Camera.getNumberOfCameras();i++){Camera.getCameraInfo(i,info);if(info.facing==Camera.CameraInfo.CAMERA_FACING_BACK){id=i;break;}}
            Camera.CameraInfo selected=new Camera.CameraInfo();Camera.getCameraInfo(id,selected);camera=Camera.open(id);camera.setErrorCallback((error,source)->runOnUiThread(()->finishResult(null,"QR_CAMERA_UNAVAILABLE")));
            Camera.Parameters params=camera.getParameters();Camera.Size size=params.getSupportedPreviewSizes().stream().filter(s->(long)s.width*s.height<=1280*720).max((a,b)->Integer.compare(a.width*a.height,b.width*b.height)).orElse(null);
            if(size==null)throw new IllegalStateException();params.setPreviewSize(size.width,size.height);params.setPreviewFormat(ImageFormat.NV21);
            java.util.List<String> modes=params.getSupportedFocusModes();if(modes!=null&&modes.contains(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE))params.setFocusMode(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE);
            camera.setParameters(params);int rotation=getWindowManager().getDefaultDisplay().getRotation()*90;
            int orientation=selected.facing==Camera.CameraInfo.CAMERA_FACING_FRONT?(360-(selected.orientation+rotation)%360)%360:(selected.orientation-rotation+360)%360;
            camera.setDisplayOrientation(orientation);camera.setPreviewDisplay(surface.getHolder());camera.setPreviewCallback(this);camera.startPreview();
        }catch(Exception error){closeCamera();finishResult(null,"QR_CAMERA_UNAVAILABLE");}
    }
    @Override public void onPreviewFrame(byte[] bytes,Camera source){
        if(finished||SystemClock.elapsedRealtime()<nextFrame||!decoding.compareAndSet(false,true))return;
        if(!previewLogged){previewLogged=true;android.util.Log.i("PalMeshQrCamera","preview_started");}
        nextFrame=SystemClock.elapsedRealtime()+350;final int operation=generation;Camera.Size size=source.getParameters().getPreviewSize();final byte[] copy=bytes.clone();
        try{decoder.execute(()->{String result=PublicQrDecoder.decode(copy,size.width,size.height);runOnUiThread(()->{decoding.set(false);if(operation==generation&&!finished&&resumed&&result!=null){android.util.Log.i("PalMeshQrCamera","decoded_qr");finishResult(result,null);}});});}catch(RejectedExecutionException error){decoding.set(false);}
    }
    private void closeCamera(){generation++;if(camera!=null){try{camera.setPreviewCallback(null);camera.stopPreview();}catch(Exception ignored){}camera.release();camera=null;}}
    private void finishResult(String text,String error){if(finished)return;finished=true;closeCamera();Intent result=new Intent();if(text!=null)result.putExtra("publicQr",text);if(error!=null)result.putExtra("error",error);setResult(text!=null||error!=null?RESULT_OK:RESULT_CANCELED,result);finish();}
    @Override public void onBackPressed(){finishResult(null,null);}
    @Override protected void onDestroy(){closeCamera();decoder.shutdownNow();super.onDestroy();}
    @Override public void surfaceCreated(SurfaceHolder holder){ready=true;open();}
    @Override public void surfaceChanged(SurfaceHolder holder,int format,int width,int height){}
    @Override public void surfaceDestroyed(SurfaceHolder holder){ready=false;closeCamera();}
}
