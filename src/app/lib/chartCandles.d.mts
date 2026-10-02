import type {Point} from './dashboardData';
export type PlayerCandle = {time:number;open:number;high:number;low:number;close:number;samples:number};
export function candleInterval(hours:number):number;
export function buildCandles(points:Point[],intervalSeconds:number):PlayerCandle[];
