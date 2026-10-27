import {StyleSheet} from 'react-native';
import {screen} from '@testing-library/react-native';
/** Measure the rendered text/input against its nearest opaque surface. */
export function renderedContrast(node:ReturnType<typeof screen.getByText>):number {
 let color:string|undefined,background:string|undefined;
 for(let current:typeof node|null=node;current!==null;current=current.parent){const style=StyleSheet.flatten(current.props.style)??{};color??=style.color;background??=style.backgroundColor;if(color&&background)break;}
 if(!color||!background)throw new Error('Rendered foreground/background are missing');
 const luminance=(hex:string)=>{if(!/^#[0-9a-f]{6}$/i.test(hex))throw new Error('Expected opaque RGB');const c=hex.slice(1).match(/../g)!.map(x=>parseInt(x,16)/255).map(x=>x<=0.04045?x/12.92:((x+0.055)/1.055)**2.4);return c[0]!*0.2126+c[1]!*0.7152+c[2]!*0.0722;};
 const a=luminance(color),b=luminance(background);return(Math.max(a,b)+0.05)/(Math.min(a,b)+0.05);
}
