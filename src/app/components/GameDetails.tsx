"use client";
import Image from 'next/image';
import {Suspense,useEffect,useMemo,useState} from 'react';
import {useSearchParams} from 'next/navigation';
import {Brand,GameIcon,Icon,PageLink as Link,RangePicker,useWatchlist} from './TrendsUi';
import GenreFinanceChart from './GenreFinanceChart';
import {gameHref,loadDashboard,loadGameHistory,type Game,type Point,type RelatedGame} from '../lib/dashboardData';
import {compact,duration,number,percent} from '../lib/display';

export default function GameDetails(){return <Suspense fallback={<div className="tableEmpty">Loading experience…</div>}><GameContent/></Suspense>;}
function GameContent(){
  const params=useSearchParams();
  const id=params.get('id');
  const [game,setGame]=useState<Game|null>(null);
  const [games,setGames]=useState<Game[]>([]);
  const [history,setHistory]=useState<Point[]>([]);
  const [message,setMessage]=useState('Loading experience…');
  const [historyError,setHistoryError]=useState('');
  const [generatedAt,setGeneratedAt]=useState('');
  const [hours,setHours]=useState(24);
  const {watchlist,toggle,ready,storageError}=useWatchlist();
  useEffect(()=>{let cancelled=false;
    loadDashboard().then(async data=>{
      if(!id){if(!cancelled)setMessage('Choose a game from the dashboard to explore its activity.');return;}
      if(cancelled)return;const found=data.games.find(item=>item.id===id);setGame(found??null);setGames(data.games);setGeneratedAt(data.meta.generatedAt??'');setMessage(found?'':'This game is outside the current tracked sample.');
      if(found)try{const points=await loadGameHistory(id);if(!cancelled)setHistory(points);}catch{if(!cancelled)setHistoryError('Full history is temporarily unavailable. Showing collected preview observations.');}
    }).catch(failure=>{if(!cancelled)setMessage(failure.message);});return()=>{cancelled=true;};
  },[id]);
  const metric=game?.metrics?.[String(hours)];
  const points=useMemo(()=>history.length?history.filter(point=>point.time>=Date.parse(generatedAt)/1000-hours*3600):metric?.sparkline??[],[history,generatedAt,hours,metric]);
  function related(title:string,items:RelatedGame[]|undefined,checkedAt?:string){return <section className="detailSection"><h2>{title}</h2><p className="detailQuiet">{checkedAt?`Collected ${new Date(checkedAt).toLocaleString()}`:'Details refresh in scheduled batches.'}</p>{items==null?<p className="sectionDescription">Waiting for this game’s next detail refresh.</p>:items.length===0?<p className="sectionDescription">Roblox returned no games for this experience.</p>:<div className="relatedGrid">{items.map(item=>games.some(known=>known.id===item.id)?<Link className="relatedCard" key={item.id} href={gameHref(item.id)}><span>{item.name}</span><Icon name="arrow" size={15}/></Link>:item.rootPlaceId?<a className="relatedCard" key={item.id} href={`https://www.roblox.com/games/${item.rootPlaceId}`} target="_blank" rel="noopener noreferrer"><span>{item.name}</span><Icon name="arrow" size={15}/></a>:<span className="relatedCard" key={item.id}>{item.name}</span>)}</div>}</section>;}
  return <main className="detailShell"><header className="detailHeader"><Link href="/" aria-label="Roblox Trends home"><Brand/></Link><Link href="/" className="backLink"><Icon name="back" size={15}/> Back to overview</Link></header><div className="detailBreadcrumb">Discover <Icon name="chevron" size={11}/> Experience activity</div>
    {message?<div className="tableEmpty" role="status"><Icon name="chart" size={30}/><p>{message}</p><Link href="/" className="softButton">Explore games</Link></div>:null}
    {game?<><div className="detailGrid"><div className="detailMain"><section className="panel"><div className="detailHeroTitle"><GameIcon game={game} size="large"/><div><h1>{game.name}</h1><p>by {game.creator}</p></div><button className={`iconButton watchButton ${watchlist.includes(game.id)?'saved':''}`} aria-label={`${watchlist.includes(game.id)?'Remove':'Add'} ${game.name} ${watchlist.includes(game.id)?'from':'to'} watchlist`} aria-pressed={watchlist.includes(game.id)} disabled={!ready} onClick={()=>toggle(game.id)}><Icon name="watch"/></button></div>
      <div className="heroValue"><strong>{number(game.activePlayers)}</strong><span>concurrent players</span></div><p className="heroChange">{metric?.growthPct==null?<span className="muted">Growth appears after more observations</span>:<><span className={metric.growthPct>=0?'positive':'negative'}>{percent(metric.growthPct)}</span><span className="muted"> across {duration(metric.hoursUsed)} of collected history</span></>}</p>
      <GenreFinanceChart data={points} height={300}/><div className="chartFooter"><RangePicker hours={hours} onChange={setHours}/><span className="quietLabel">PLAYER ACTIVITY</span></div>{historyError?<p className="chartNote">{historyError}</p>:null}
      </section><div className="detailStats"><div className="detailStat"><span>Lifetime visits</span><strong>{compact(game.visits)}</strong></div><div className="detailStat"><span>Favorites</span><strong>{compact(game.favorites)}</strong></div><div className="detailStat"><span>Positive votes</span><strong>{game.likeRatio==null?'—':`${Math.round(game.likeRatio*100)}%`}</strong></div></div>
      <details className="descriptionDetails"><summary>About this experience</summary><p>{game.description||'No description provided by Roblox.'}</p></details>
    </div><aside className="panel detailAside"><p className="eyebrow">THE BIGGER PICTURE</p><h2>Experience details</h2><dl className="detailFacts"><dt>Genre</dt><dd>{game.genreL1??'Unknown'}</dd><dt>Subgenre</dt><dd>{game.genreL2??'—'}</dd><dt>Creator</dt><dd>{game.creator}</dd><dt>Created</dt><dd>{game.createdAt?new Date(game.createdAt).toLocaleDateString():'—'}</dd><dt>Last updated</dt><dd>{game.updatedAt?new Date(game.updatedAt).toLocaleDateString():'—'}</dd><dt>Our collection</dt><dd>{generatedAt?new Date(generatedAt).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'}):'—'}</dd></dl>{game.rootPlaceId?<a className="primaryButton" href={`https://www.roblox.com/games/${game.rootPlaceId}`} target="_blank" rel="noopener noreferrer">Open on Roblox <Icon name="arrow" size={15}/></a>:null}<p className="localNote">Public stats. Refreshed about every 30 minutes.</p>{storageError?<p className="chartNote">Watchlist storage is unavailable in this browser.</p>:null}</aside></div>
    {game.enrichment?.thumbnails?.length?<section className="detailSection"><h2>A look inside</h2><div className="screenshotGrid">{game.enrichment.thumbnails.map(url=><Image unoptimized key={url} src={url} alt={`${game.name} promotional screenshot`} width={768} height={432} loading="lazy"/>)}</div></section>:null}
    <section className="detailSection"><h2>Milestones & badges</h2><p className="detailQuiet">Up to 10 badges. Award counts measure badges earned, not unique players or retention.{game.enrichment?.badgesCheckedAt?` Collected ${new Date(game.enrichment.badgesCheckedAt).toLocaleString()}.`:''}</p>{game.enrichment?.badges==null?<p className="sectionDescription">Waiting for this game’s next badge refresh.</p>:game.enrichment.badges.length===0?<p className="sectionDescription">No badges returned by Roblox.</p>:<div className="badgeGrid">{game.enrichment.badges.map(badge=><article className="badgeCard" key={badge.id}><a href={`https://www.roblox.com/badges/${badge.id}`} target="_blank" rel="noopener noreferrer">{badge.name}<Icon name="arrow" size={14}/></a><p>{badge.description}{!badge.enabled?' · Currently disabled':''}</p><div className="badgeCounts"><span>{compact(badge.awardedCount)} lifetime awards</span><span>{compact(badge.pastDayAwardedCount)} past day</span></div></article>)}</div>}{game.enrichment?.badgesHasMore?<p className="chartNote">More badges exist beyond this collected sample.</p>:null}</section>
    {related('Recommended by Roblox',game.enrichment?.relatedGames,game.enrichment?.relatedCheckedAt)}
    {game.creatorType==='User'?related('More from this creator',game.enrichment?.creatorGames,game.enrichment?.creatorCheckedAt):null}
    <footer className="dashboardFooter"><span>Player history describes our tracked sample. Growth uses available observations.</span><Link href="/about">How the data works <Icon name="arrow" size={13}/></Link></footer></>:null}
  </main>;
}
