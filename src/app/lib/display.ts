export const timeRanges = [{label:'1D',hours:24},{label:'1W',hours:168},{label:'2W',hours:336},{label:'1M',hours:720}];
export function compact(value:number|null|undefined) {return value == null ? '—' : new Intl.NumberFormat('en',{notation:'compact',maximumFractionDigits:1}).format(value);}
export function number(value:number|null|undefined) {return value == null ? '—' : Math.round(value).toLocaleString('en-US');}
export function percent(value:number|null|undefined) {return value == null ? '—' : `${value>=0?'+':''}${value.toFixed(2)}%`;}
export function duration(hours:number) {return hours<=0?'First observation':hours<1?`${Math.max(1,Math.round(hours*60))} min`:hours<24?`${hours.toFixed(1)}h`:`${(hours/24).toFixed(1)}d`;}
