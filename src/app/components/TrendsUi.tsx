"use client";
import {useState,useSyncExternalStore} from 'react';
import type {ComponentProps} from 'react';
import Image from 'next/image';
import type {Game,Point} from '../lib/dashboardData';
import {timeRanges} from '../lib/display';

export function PageLink({href,...props}:Omit<ComponentProps<'a'>,'href'>&{href:string}){return <a {...props} href={`${process.env.dashboardBasePath??''}${href}`}/>;}

export function Icon({name,size=20}:{name:string;size?:number}) {
  const paths:Record<string,string>={overview:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',discover:'M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16 M17 17l4 4',watch:'m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z',arrow:'M5 19 19 5 M5 5h14v14',chevron:'m9 5 7 7-7 7',back:'m14 5-7 7 7 7',info:'M12 8v.01 M12 11v6 M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18',players:'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M17 4a4 4 0 0 1 0 7 M22 21v-2a4 4 0 0 0-3-3.9',chart:'M3 3v18h18 M7 14l4-4 4 3 6-8',close:'m6 6 12 12 M6 18 18 6',globe:'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M3 12h18 M12 3c-5 5-5 13 0 18 5-5 5-13 0-18',filter:'M4 7h16 M7 12h10 M10 17h4'};
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]??paths.chart}/></svg>;
}
export function Brand() {return <span className="brand"><span className="brandMark"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m4 16 5-6 4 3 7-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M15 4h5v5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/></svg></span><span>roblox<span className="brandAccent">trends</span><span className="brandDot">.</span></span></span>;}
export function GameIcon({game,size='normal'}:{game:Game;size?:'small'|'normal'|'large'}) {
  const [failed,setFailed]=useState(false);
  return <span className={`gameIcon ${size}`}>{game.enrichment?.iconUrl&&!failed?<Image unoptimized src={game.enrichment.iconUrl} alt="" width={size==='large'?72:44} height={size==='large'?72:44} loading="lazy" onError={()=>setFailed(true)}/>:<span>{game.name.replace(/[^a-zA-Z0-9]/g,'').slice(0,2).toUpperCase()||'RT'}</span>}</span>;
}
export function Sparkline({points,positive=true}:{points?:Point[];positive?:boolean}) {
  if (!points||points.length<2) return <span className="sparkMissing" aria-label="More history needed">···</span>;
  const low=Math.min(...points.map(point=>point.value)),high=Math.max(...points.map(point=>point.value));
  const start=points[0].time,end=points.at(-1)!.time;
  const path=points.map(point=>`${2+(point.time-start)/Math.max(1,end-start)*90},${26-(point.value-low)/Math.max(1,high-low)*22}`).join(' ');
  return <svg className={`sparkline ${positive?'positive':'negative'}`} viewBox="0 0 94 30" aria-hidden="true"><polyline points={path} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round"/></svg>;
}
export function RangePicker({hours,onChange}:{hours:number;onChange:(hours:number)=>void}) {return <div className="rangePicker" aria-label="Chart time range">{timeRanges.map(range=><button key={range.hours} type="button" className={hours===range.hours?'active':''} aria-pressed={hours===range.hours} onClick={()=>onChange(range.hours)}>{range.label}</button>)}</div>;}
const serverWatch={watchlist:[] as string[],ready:false,storageError:false};
let watchState=serverWatch;
const watchListeners=new Set<()=>void>();
function publishWatch(){for(const listener of watchListeners)listener();}
function readWatch(){try{const saved=JSON.parse(localStorage.getItem('robloxTrendsWatchlist')??'[]');watchState={watchlist:Array.isArray(saved)?saved.filter(id=>typeof id==='string'&&/^[1-9]\d*$/.test(id)):[],ready:true,storageError:false};}catch{watchState={...watchState,ready:true,storageError:true};}publishWatch();}
function storageChanged(event:StorageEvent){if(event.key==='robloxTrendsWatchlist'||event.key===null)readWatch();}
function subscribeWatch(listener:()=>void){watchListeners.add(listener);if(watchListeners.size===1)window.addEventListener('storage',storageChanged);if(!watchState.ready)readWatch();return()=>{watchListeners.delete(listener);if(!watchListeners.size)window.removeEventListener('storage',storageChanged);};}
function watchSnapshot(){return watchState;}
function serverWatchSnapshot(){return serverWatch;}
export function useWatchlist(){
  const state=useSyncExternalStore(subscribeWatch,watchSnapshot,serverWatchSnapshot);
  function toggle(id:string){const next=watchState.watchlist.includes(id)?watchState.watchlist.filter(item=>item!==id):[...watchState.watchlist,id];let storageError=false;try{localStorage.setItem('robloxTrendsWatchlist',JSON.stringify(next));}catch{storageError=true;}watchState={watchlist:next,ready:true,storageError};publishWatch();}
  return {...state,toggle};
}
