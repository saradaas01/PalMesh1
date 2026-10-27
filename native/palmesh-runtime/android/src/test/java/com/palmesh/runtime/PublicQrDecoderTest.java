package com.palmesh.runtime;
import org.junit.Test;
import static org.junit.Assert.*;
import com.google.zxing.*;
import com.google.zxing.common.BitMatrix;
import com.google.zxing.qrcode.QRCodeWriter;
public class PublicQrDecoderTest {
 @Test public void liveLuminanceFrameDecodesOfflineInBothOrientations() throws Exception {
  String payload="{\"type\":\"palmesh-public-identity\",\"version\":1,\"publicIdentity\":{\"signingKey\":\"public-test-only\",\"encryptionKey\":\"public-test-only\"}}";
  BitMatrix pixels=new QRCodeWriter().encode(payload,BarcodeFormat.QR_CODE,640,480);
  byte[] frame=new byte[640*480];for(int y=0;y<480;y++)for(int x=0;x<640;x++)frame[y*640+x]=(byte)(pixels.get(x,y)?0:255);
  assertEquals(payload,PublicQrDecoder.decode(frame,640,480));
  byte[] rotated=new byte[frame.length];for(int y=0;y<480;y++)for(int x=0;x<640;x++)rotated[x*480+(479-y)]=frame[y*640+x];
  assertEquals(payload,PublicQrDecoder.decode(rotated,480,640));
 }
 @Test public void missingMalformedOrOversizedFramesAreBounded(){assertNull(PublicQrDecoder.decode(null,640,480));assertNull(PublicQrDecoder.decode(new byte[1],640,480));assertNull(PublicQrDecoder.decode(new byte[10],0,1));assertNull(PublicQrDecoder.decode(new byte[10],99999,99999));assertNull(PublicQrDecoder.decode(new byte[640*480],640,480));}
}
