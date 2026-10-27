package com.palmesh.runtime;
import org.junit.Test;
import static org.junit.Assert.*;
import java.util.List;
public class LocationPolicyTest {
 @Test public void approximateNeverSelectsGps(){assertEquals(List.of("network"),LocationPolicy.providers(false,true,true,true));assertTrue(LocationPolicy.providers(false,true,true,false).isEmpty());assertTrue(LocationPolicy.providers(false,false,true,true).isEmpty());assertEquals(List.of("gps","network"),LocationPolicy.providers(true,true,true,true));assertEquals(List.of("gps"),LocationPolicy.providers(true,true,true,false));}
 @Test public void cacheAgeUsesMonotonicTimeWithoutInventingAFix(){assertTrue(LocationPolicy.fresh(100000000000L,99000000000L,1000));assertFalse(LocationPolicy.fresh(100000000000L,98000000000L,1000));assertFalse(LocationPolicy.fresh(1000,2000,60000));assertFalse(LocationPolicy.fresh(1000,0,60000));}
}
