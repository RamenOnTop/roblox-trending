"use client";
import {useEffect,useRef,useState} from 'react';
import {AreaSeries,ColorType,CrosshairMode,createChart,type UTCTimestamp} from 'lightweight-charts';
import type {Point} from '../lib/dashboardData';
import {number} from '../lib/display';

export default function GenreFinanceChart({data,loading=false,label='Players',height=280}:{data:Point[];loading?:boolean;label?:string;height?:number}) {
  const ref=useRef<HTMLDivElement>(null);
  const [hover,setHover]=useState<{value:number;time:string}|null>(null);
  useEffect(()=>{
    if(!ref.current||data.length<2)return;
    const chart=createChart(ref.current,{
      width:ref.current.clientWidth,height,
      layout:{background:{type:ColorType.Solid,color:'transparent'},textColor:'#76837c',fontFamily:'Arial',fontSize:11},
      grid:{vertLines:{visible:false},horzLines:{color:'#1e2722',style:2}},
      rightPriceScale:{borderVisible:false,scaleMargins:{top:0.12,bottom:0.12}},
      timeScale:{borderVisible:false,timeVisible:true,secondsVisible:false},
      crosshair:{mode:CrosshairMode.Normal,vertLine:{color:'#6c7b70',labelBackgroundColor:'#314435'},horzLine:{color:'#6c7b70',labelBackgroundColor:'#314435'}},
      handleScroll:false,handleScale:false,
    });
    const falling=data.at(-1)!.value<data[0].value;
    const series=chart.addSeries(AreaSeries,{lineColor:falling?'#eea296':'#b6ef8b',topColor:falling?'rgba(238,162,150,.12)':'rgba(182,239,139,.15)',bottomColor:'rgba(182,239,139,0)',lineWidth:2,priceLineVisible:false,lastValueVisible:false,crosshairMarkerRadius:5,priceFormat:{type:'custom',formatter:(value:number)=>number(value)},pointMarkersVisible:data.length===1});
    series.setData(data.map(point=>({...point,time:point.time as UTCTimestamp})));
    chart.timeScale().fitContent();
    chart.subscribeCrosshairMove(param=>{
      const observation=param.seriesData.get(series);
      if(!observation||!('value' in observation)||typeof param.time!=='number'){setHover(null);return;}
      setHover({value:observation.value,time:new Date(param.time*1000).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'})});
    });
    const observer=new ResizeObserver(()=>{if(ref.current)chart.applyOptions({width:ref.current.clientWidth});});observer.observe(ref.current);
    return()=>{observer.disconnect();chart.remove();};
  },[data,height]);
  return <div className="chartSurface" role="img" aria-label={`${label} history chart with ${data.length} observations`}>
    <div className="chartHover">{hover?<><strong>{number(hover.value)}</strong> {label.toLowerCase()} <span>{hover.time}</span></>:<span>{data.length>=2?'Collected observations · Chart axis in UTC':''}</span>}</div>
    <div ref={ref} style={{height}}/>
    {loading?<div className="chartOverlay"><span className="loadingDot"/> Loading observations…</div>:data.length<2?<div className="chartOverlay"><svg width="48" height="32" viewBox="0 0 48 32" aria-hidden="true"><path d="m2 27 11-8 9 3 10-15 14-5" stroke="#b6ef8b" strokeWidth="2" fill="none" strokeLinecap="round" strokeDasharray="3 5"/></svg><strong>{data.length?'A trend starts with time.':'History is on its way.'}</strong><span>{data.length?'First observation recorded. More collections will reveal the curve.':'New observations appear after the next collection.'}</span></div>:null}
  </div>;
}
