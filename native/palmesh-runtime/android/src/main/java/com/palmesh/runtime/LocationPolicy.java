package com.palmesh.runtime;
import java.util.ArrayList;
import java.util.List;
/** Permission-aware provider selection: coarse permission must never select GPS. */
final class LocationPolicy {
 static List<String> providers(boolean fine,boolean coarse,boolean gps,boolean network){
  List<String> result=new ArrayList<>();if(fine&&gps)result.add("gps");if((fine||coarse)&&network)result.add("network");return result;
 }
 static boolean fresh(long elapsedNanos,long fixElapsedNanos,long maximumAgeMs){return fixElapsedNanos>0&&elapsedNanos>=fixElapsedNanos&&(elapsedNanos-fixElapsedNanos)/1000000L<=maximumAgeMs;}
 static boolean prefer(float currentAccuracy,long currentTime,float nextAccuracy,long nextTime){return nextAccuracy<currentAccuracy||(nextAccuracy==currentAccuracy&&nextTime>currentTime);}
}
