import React, { useMemo } from 'react';
import QRCode from 'qrcode-generator';
import Svg, { Path, Rect } from 'react-native-svg';
export function qrMatrix(payload:string): {size:number;path:string} {
  const qr=QRCode(0,'M'); qr.addData(payload,'Byte'); qr.make();
  const count=qr.getModuleCount(); const parts:string[]=[];
  for(let y=0;y<count;y++) for(let x=0;x<count;x++) if(qr.isDark(y,x)) parts.push(`M${x+4} ${y+4}h1v1h-1z`);
  return {size:count+8,path:parts.join('')};
}
/** One native path, quiet zone and opaque background; no thousands of Views. */
export const PublicIdentityQr = React.memo(function PublicIdentityQr({payload,label}:{readonly payload:string;readonly label:string}) {
  const matrix=useMemo(()=>qrMatrix(payload),[payload]);
  return <Svg width="100%" height={300} viewBox={`0 0 ${matrix.size} ${matrix.size}`} accessibilityLabel={label} accessible>
    <Rect x={0} y={0} width={matrix.size} height={matrix.size} fill="#ffffff" />
    <Path d={matrix.path} fill="#000000" />
  </Svg>;
});
