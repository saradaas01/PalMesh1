package com.palmesh.runtime;
import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.location.*;
import android.os.*;
import com.facebook.react.bridge.*;
import java.util.*;

/** Foreground, one-shot OS providers only. No fused/Play Services or HTTP dependency. */
public final class PalMeshLocationModule extends ReactContextBaseJavaModule implements LifecycleEventListener {
 private final Handler main=new Handler(Looper.getMainLooper());
 private final LocationManager manager;
 private Promise pending;private int token;private Location candidate;private boolean precise;private long maximumAge;
 private final Runnable deadline=()->{if(!deliverCandidate())fail("GPS_TIMEOUT");};
 private final Runnable fallback=()->{deliverCandidate();};
 private final LocationListener listener=new LocationListener(){
  @Override public void onLocationChanged(Location location){
   if(pending==null||!valid(location)||!LocationPolicy.fresh(SystemClock.elapsedRealtimeNanos(),location.getElapsedRealtimeNanos(),maximumAge))return;
   if(LocationManager.GPS_PROVIDER.equals(location.getProvider()))success(location);
   else {
    if(candidate!=null&&!LocationPolicy.fresh(SystemClock.elapsedRealtimeNanos(),candidate.getElapsedRealtimeNanos(),maximumAge)){candidate=null;main.removeCallbacks(fallback);}
    boolean first=candidate==null;if(first||LocationPolicy.prefer(candidate.getAccuracy(),candidate.getElapsedRealtimeNanos(),location.getAccuracy(),location.getElapsedRealtimeNanos()))candidate=new Location(location);
    if(first)main.postDelayed(fallback,10000);
   }
  }
  @Override public void onProviderDisabled(String provider){if(pending==null)return;try{if(!deviceEnabled())fail("GPS_DISABLED");else if(enabledProviders().isEmpty())fail("GPS_PROVIDER");}catch(Exception e){fail("GPS_PROVIDER");}}
  @Override public void onProviderEnabled(String provider){}
  @Override public void onStatusChanged(String provider,int status,Bundle extras){}
 };
 public PalMeshLocationModule(ReactApplicationContext context){super(context);manager=(LocationManager)context.getSystemService(Context.LOCATION_SERVICE);context.addLifecycleEventListener(this);}
 @Override public String getName(){return "PalMeshLocation";}
 private boolean allowed(String p){return getReactApplicationContext().checkSelfPermission(p)==PackageManager.PERMISSION_GRANTED;}
 private boolean deviceEnabled(){return Build.VERSION.SDK_INT>=28?manager.isLocationEnabled():manager.isProviderEnabled(LocationManager.GPS_PROVIDER)||manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER);}
 private List<String> enabledProviders(){return LocationPolicy.providers(allowed(Manifest.permission.ACCESS_FINE_LOCATION),allowed(Manifest.permission.ACCESS_COARSE_LOCATION),manager.isProviderEnabled(LocationManager.GPS_PROVIDER),manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER));}
 @ReactMethod public void read(int requestId,double timeoutMs,double maximumAgeMs,Promise promise){main.post(()->{
  if(pending!=null){promise.reject("GPS_BUSY","Location request already active");return;}
  pending=promise;token=requestId;candidate=null;
  if(!Double.isFinite(timeoutMs)||timeoutMs<1||timeoutMs>90000||!Double.isFinite(maximumAgeMs)||maximumAgeMs<0||maximumAgeMs>60000){fail("GPS_PROVIDER");return;}
  maximumAge=(long)maximumAgeMs;
  try{
   precise=allowed(Manifest.permission.ACCESS_FINE_LOCATION);
   if(!precise&&!allowed(Manifest.permission.ACCESS_COARSE_LOCATION)){fail("GPS_DENIED");return;}
   if(manager==null){fail("GPS_PROVIDER");return;}
   if(!deviceEnabled()){fail("GPS_DISABLED");return;}
   List<String> providers=enabledProviders();android.util.Log.i("PalMeshGps","request_started precise="+precise+" providers="+providers);if(providers.isEmpty()){fail("GPS_PROVIDER");return;}
   main.postDelayed(deadline,(long)timeoutMs);
   int watching=0;
   for(String provider:providers){
    try{
     Location last=manager.getLastKnownLocation(provider);
     if(last!=null&&valid(last)&&LocationPolicy.fresh(SystemClock.elapsedRealtimeNanos(),last.getElapsedRealtimeNanos(),maximumAge)){
      if(LocationManager.GPS_PROVIDER.equals(provider)){success(last);return;}candidate=new Location(last);main.postDelayed(fallback,10000);
     }
     manager.requestLocationUpdates(provider,1000,0,listener,Looper.getMainLooper());watching++;
    }catch(SecurityException denied){if(!allowed(Manifest.permission.ACCESS_FINE_LOCATION)&&!allowed(Manifest.permission.ACCESS_COARSE_LOCATION)){fail("GPS_DENIED");return;}}
    catch(RuntimeException unavailable){/* Try the other permitted OS provider. */}
   }
   if(watching==0&&!deliverCandidate())fail("GPS_PROVIDER");
  }catch(SecurityException denied){fail("GPS_DENIED");}catch(RuntimeException unavailable){fail("GPS_PROVIDER");}
 });}
 @ReactMethod public void cancel(int requestId){main.post(()->{if(pending!=null&&token==requestId)fail("GPS_CANCELLED");});}
 private boolean deliverCandidate(){
  Location value=candidate;
  if(value!=null&&valid(value)&&LocationPolicy.fresh(SystemClock.elapsedRealtimeNanos(),value.getElapsedRealtimeNanos(),maximumAge)){success(value);return true;}
  candidate=null;return false;
 }
 private boolean valid(Location l){return Double.isFinite(l.getLatitude())&&Math.abs(l.getLatitude())<=90&&Double.isFinite(l.getLongitude())&&Math.abs(l.getLongitude())<=180&&l.getTime()>0&&l.getTime()<=System.currentTimeMillis()+300000&&l.hasAccuracy()&&Float.isFinite(l.getAccuracy())&&l.getAccuracy()>=0;}
 private void success(Location l){Promise p=pending;if(p==null)return;WritableMap coords=Arguments.createMap();coords.putDouble("latitude",l.getLatitude());coords.putDouble("longitude",l.getLongitude());coords.putDouble("accuracy",l.getAccuracy());WritableMap result=Arguments.createMap();result.putMap("coords",coords);result.putDouble("timestamp",l.getTime());result.putBoolean("approximate",!precise||!LocationManager.GPS_PROVIDER.equals(l.getProvider())||l.getAccuracy()>100);android.util.Log.i("PalMeshGps","fix_received provider="+l.getProvider());cleanup();p.resolve(result);}
 private void fail(String code){Promise p=pending;if(p==null)return;android.util.Log.i("PalMeshGps",code);cleanup();p.reject(code,"Foreground location could not complete");}
 private void cleanup(){pending=null;candidate=null;main.removeCallbacks(deadline);main.removeCallbacks(fallback);try{if(manager!=null)manager.removeUpdates(listener);}catch(RuntimeException ignored){}}
 @Override public void onHostPause(){main.post(()->fail("GPS_CANCELLED"));}
 @Override public void onHostDestroy(){main.post(()->fail("GPS_CANCELLED"));}
 @Override public void onHostResume(){}
 @Override public void invalidate(){getReactApplicationContext().removeLifecycleEventListener(this);main.post(()->fail("GPS_CANCELLED"));super.invalidate();}
}
