export const validPrice=(s:string)=>/^\d{1,8}(\.\d{1,2})?$/.test(s)&&Number(s)>0;
function hundredths(value:string){const [whole,part='']=value.split('.');return BigInt(whole)*100n+BigInt(part.padEnd(2,'0'))}
export function markedUp(cost:string,percent:string):string{
 if(!validPrice(cost)||!/^\d{1,5}(\.\d{1,2})?$/.test(percent))return '';
 const cents=(hundredths(cost)*(10000n+hundredths(percent))+5000n)/10000n;
 const value=String(cents/100n)+'.'+String(cents%100n).padStart(2,'0');
 return validPrice(value)?value:'';
}
