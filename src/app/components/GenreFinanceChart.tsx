"use client";
import {useEffect,useMemo,useRef,useState} from 'react';
import {AreaSeries,CandlestickSeries,LineSeries,ColorType,CrosshairMode,createChart,type ISeriesApi,type UTCTimestamp} from 'lightweight-charts';
import type {Point} from '../lib/dashboardData';
import {buildCandles,candleInterval} from '../lib/chartCandles.mjs';
import {number} from '../lib/display';

type ChartStyle='line'|'candles'|'both';
type Hover={time:string;value?:number;open?:number;high?:number;low?:number;close?:number;samples?:number};
export default function GenreFinanceChart({data,loading=false,label='Players',height=280,hours=24}:{data:Point[];loading?:boolean;label?:string;height?:number;hours?:number}) {
  const ref=useRef<HTMLDivElement>(null);
  const [style,setStyle]=useState<ChartStyle>('line');
  const [hover,setHover]=useState<Hover|null>(null);
  const interval=candleInterval(hours);
  const candles=useMemo(()=>buildCandles(data,interval),[data,interval]);
  const intervalLabel=interval===86400?'1 day':`${interval/3600}h`;
  const needsHistory=data.length<(style==='line'?2:1);
  useEffect(()=>{
    if(!ref.current||needsHistory)return;
    const chart=createChart(ref.current,{
      width:ref.current.clientWidth,height,
      layout:{background:{type:ColorType.Solid,color:'transparent'},textColor:'#898991',fontFamily:'Arial',fontSize:11},
      grid:{vertLines:{visible:false},horzLines:{color:'#29292e',style:2}},
      rightPriceScale:{borderVisible:false,scaleMargins:{top:0.12,bottom:0.12}},
      timeScale:{borderVisible:false,timeVisible:true,secondsVisible:false,maxBarSpacing:style==='line'?0:60},
      crosshair:{mode:CrosshairMode.Normal,vertLine:{color:'#777783',labelBackgroundColor:'#383842'},horzLine:{color:'#777783',labelBackgroundColor:'#383842'}},
      handleScroll:false,handleScale:false,
    });
    let candleSeries:ISeriesApi<'Candlestick'>|undefined;
    let lineSeries:ISeriesApi<'Area'>|ISeriesApi<'Line'>|undefined;
    const priceFormat={type:'custom' as const,formatter:(value:number)=>number(value)};
    if(style!=='line'){
      candleSeries=chart.addSeries(CandlestickSeries,{upColor:'#9ec9ff',downColor:'#ee9a9a',wickUpColor:'#9ec9ff',wickDownColor:'#ee9a9a',borderVisible:false,priceLineVisible:false,lastValueVisible:false,priceFormat});
      candleSeries.setData(candles.map(candle=>({...candle,time:candle.time as UTCTimestamp,...(candle.open===candle.close?{color:'#9999a5',wickColor:'#9999a5'}:{})})));
    }
    if(style!=='candles'){
      lineSeries=style==='both'?chart.addSeries(LineSeries,{color:'#d1d5ff',lineWidth:2,priceLineVisible:false,lastValueVisible:false,crosshairMarkerRadius:4,priceFormat}):chart.addSeries(AreaSeries,{lineColor:'#b8c2ff',topColor:'rgba(184,194,255,.12)',bottomColor:'rgba(184,194,255,0)',lineWidth:2,priceLineVisible:false,lastValueVisible:false,crosshairMarkerRadius:5,priceFormat});
      lineSeries.setData(data.map(point=>({...point,time:point.time as UTCTimestamp})));
    }
    chart.timeScale().fitContent();
    chart.subscribeCrosshairMove(param=>{
      if(typeof param.time!=='number'){setHover(null);return;}
      const time=new Date(param.time*1000).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'});
      const bar=candleSeries&&param.seriesData.has(candleSeries)?candles.find(candle=>candle.time===param.time):undefined;
      const point=lineSeries&&param.seriesData.has(lineSeries)?data.find(point=>point.time===param.time):undefined;
      if(bar)setHover({time,open:bar.open,high:bar.high,low:bar.low,close:bar.close,samples:bar.samples});
      else if(point)setHover({time,value:point.value});
      else setHover(null);
    });
    const observer=new ResizeObserver(()=>{if(ref.current)chart.applyOptions({width:ref.current.clientWidth});});observer.observe(ref.current);
    return()=>{observer.disconnect();chart.remove();};
  },[data,height,style,candles,needsHistory]);
  return <div className="chartSurface">
    <div className="chartControls"><div className="segmented" role="group" aria-label="Chart style">{([{id:'line',label:'Line'},{id:'candles',label:'Candles'},{id:'both',label:'Both'}] as const).map(item=><button key={item.id} type="button" className={style===item.id?'active':''} aria-pressed={style===item.id} onClick={()=>{setStyle(item.id);setHover(null);}}>{item.label}</button>)}</div><span className="chartInterval">{style==='line'?'Recorded player counts':`${intervalLabel} candles · ${candles.length} ${candles.length===1?'interval':'intervals'}`}</span></div>
    <div className="chartHover" aria-live="polite">{hover?.open!=null?<><span className="candleValues"><span><b>O</b> {number(hover.open)}</span><span><b>H</b> {number(hover.high)}</span><span><b>L</b> {number(hover.low)}</span><span><b>C</b> {number(hover.close)}</span></span><span>{hover.samples} snapshots · {hover.time}</span></>:hover?.value!=null?<><strong>{number(hover.value)}</strong> {label.toLowerCase()} <span>{hover.time}</span></>:<span>{!needsHistory?'Collected observations · Chart axis in UTC':''}</span>}</div>
    <div ref={ref} style={{height}} role="img" aria-label={`${label} ${style==='both'?'line and candle':style} history chart with ${data.length} observations${style==='line'?'':` across ${candles.length} sampled ${candles.length===1?'interval':'intervals'}`}`}/>
    {style!=='line'?<p className="candleHelp">Open / high / low / close of collected counts. Single snapshots make flat candles; gaps stay empty. The latest interval may be incomplete.</p>:null}
    {loading?<div className="chartOverlay"><span className="loadingDot"/> Loading observations…</div>:needsHistory?<div className="chartOverlay"><svg width="48" height="32" viewBox="0 0 48 32" aria-hidden="true"><path d="m2 27 11-8 9 3 10-15 14-5" stroke="#b8c2ff" strokeWidth="2" fill="none" strokeLinecap="round" strokeDasharray="3 5"/></svg><strong>{data.length?'A trend starts with time.':'History is on its way.'}</strong><span>{data.length?'First observation recorded. More collections will reveal the chart.':'New observations appear after the next collection.'}</span></div>:null}
  </div>;
}
