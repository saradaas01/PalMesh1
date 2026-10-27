package com.palmesh.runtime;
import com.google.zxing.*;
import com.google.zxing.common.HybridBinarizer;
import com.google.zxing.qrcode.QRCodeReader;
import java.util.*;
/** Pure bounded QR decoder shared by live camera and JVM regression tests. */
public final class PublicQrDecoder {
    public static String decode(byte[] yuv,int width,int height) {
        if(width<=0||height<=0||(long)width*height>1280*720||yuv==null||yuv.length<(long)width*height)return null;
        for(int rotation=0;rotation<4;rotation++){
        try {
            Map<DecodeHintType,Object> hints=new EnumMap<>(DecodeHintType.class);
            hints.put(DecodeHintType.TRY_HARDER,Boolean.TRUE);
            String value=new QRCodeReader().decode(new BinaryBitmap(new HybridBinarizer(new PlanarYUVLuminanceSource(yuv,width,height,0,0,width,height,false))),hints).getText();
            return value!=null&&value.getBytes(java.nio.charset.StandardCharsets.UTF_8).length<=2048?value:null;
        } catch(ReaderException|IllegalArgumentException failure){ /* Try the next sensor orientation. */ }
        byte[] turned=new byte[width*height];for(int y=0;y<height;y++)for(int x=0;x<width;x++)turned[x*height+(height-y-1)]=yuv[y*width+x];yuv=turned;int previous=width;width=height;height=previous;
        }
        return null;
    }
}
