"use client";
import {useEffect,useMemo,useState} from 'react';
import GenreFinanceChart from './components/GenreFinanceChart';
import BreakoutsPanel from './components/BreakoutsPanel';
import {Brand,GameIcon,Icon,PageLink as Link,RangePicker,Sparkline,useWatchlist} from './components/TrendsUi';
import {gameHref,loadDashboard,loadGameHistory,type Dataset,type Game,type Point} from './lib/dashboardData';
import {compact,duration,number,percent} from './lib/display';

type View='overview'|'discover'|'watch'|'breakouts';
const emptyDataset:Dataset={meta:{},games:[],ranges:{}};
const emptyPoints:Point[]=[];

export default function Home(){
  const [dataset,setDataset]=useState<Dataset>(emptyDataset);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  const [view,setView]=useState<View>('overview');
  const [hours,setHours]=useState(24);
  const [selectedId,setSelectedId]=useState('');
  const [selectedGenre,setSelectedGenre]=useState('');
  const [chartMode,setChartMode]=useState<'game'|'genre'>('game');
  const [history,setHistory]=useState<{id:string;points:Point[]}>({id:'',points:[]});
  const [historyError,setHistoryError]=useState('');
  const [search,setSearch]=useState('');
  const [genreFilter,setGenreFilter]=useState('all');
  const [sort,setSort]=useState('players');
  const [limit,setLimit]=useState(12);
  const {watchlist,toggle,ready,storageError}=useWatchlist();

  useEffect(()=>{
    function readView(){const next=window.location.hash.slice(1);if(['overview','discover','watch','breakouts'].includes(next))setView(next as View);}
    readView();window.addEventListener('hashchange',readView);
    return()=>window.removeEventListener('hashchange',readView);
  },[]);

  useEffect(()=>{
    let cancelled=false;let inFlight=false;
    async function refresh(){
      if(cancelled||inFlight||document.hidden)return;
      inFlight=true;
      try{
        const data=await loadDashboard(true);
        if(cancelled)return;
        setDataset(data);setError('');
        setSelectedId(current=>data.games.some(game=>game.id===current)?current:[...data.games].sort((a,b)=>(b.activePlayers??0)-(a.activePlayers??0))[0]?.id??'');
        setSelectedGenre(current=>current||data.ranges['24']?.genres[0]?.key||'');
      }catch(failure){if(!cancelled)setError(failure instanceof Error?failure.message:'The latest collection is temporarily unavailable.');}
      finally{inFlight=false;if(!cancelled)setLoading(false);}
    }
    void refresh();
    const interval=window.setInterval(()=>void refresh(),60000);
    function onVisible(){void refresh();}
    document.addEventListener('visibilitychange',onVisible);
    return()=>{cancelled=true;window.clearInterval(interval);document.removeEventListener('visibilitychange',onVisible);};
  },[]);
  useEffect(()=>{
    if(!selectedId)return;let cancelled=false;
    loadGameHistory(selectedId).then(points=>{if(!cancelled){setHistory({id:selectedId,points});setHistoryError('');}}).catch(()=>{if(!cancelled){setHistory({id:selectedId,points:[]});setHistoryError('Full history is temporarily unavailable. Showing collected preview observations.');}});
    return()=>{cancelled=true;};
  },[selectedId,dataset.meta.generatedAt]);

  const games=dataset.games;
  const selected=games.find(game=>game.id===selectedId);
  const genres=dataset.ranges[String(hours)]?.genres??[];
  const genre=genres.find(item=>item.key===selectedGenre)??genres[0];
  const metric=selected?.metrics?.[String(hours)];
  const fullPoints=history.id===selectedId?history.points:emptyPoints;
  const now=Date.parse(dataset.meta.generatedAt??'')/1000;
  const genrePoints=genre?dataset.ranges[String(hours)]?.series[genre.key]??emptyPoints:emptyPoints;
  const previewPoints=metric?.sparkline??emptyPoints;
  const recentPoints=useMemo(()=>fullPoints.filter(point=>point.time>=now-hours*3600),[hours,fullPoints,now]);
  const points=chartMode==='genre'?genrePoints:fullPoints.length?recentPoints:previewPoints;
  const chartLoading=loading||(chartMode==='game'&&selectedId!==history.id);
  const watched=games.filter(game=>watchlist.includes(game.id));
  const playerTotal=games.reduce((sum,game)=>sum+(game.activePlayers??0),0);
  const measured=games.filter(game=>game.metrics?.[String(hours)]?.growthPct!=null);
  const growers=measured.filter(game=>(game.metrics?.[String(hours)]?.growthPct??0)>0);
  const genreLabels=[...new Set(games.map(game=>game.genreL1??'Unknown'))].sort();
  const filtered=useMemo(()=>{
    const result=games.filter(game=>(view!=='watch'||watchlist.includes(game.id))&&(genreFilter==='all'||game.genreL1===genreFilter)&&`${game.name} ${game.creator} ${game.genreL1??''}`.toLowerCase().includes(search.toLowerCase()));
    result.sort((a,b)=>sort==='growth'?(b.metrics?.[String(hours)]?.growthPct??-Infinity)-(a.metrics?.[String(hours)]?.growthPct??-Infinity):sort==='rating'?(b.likeRatio??-1)-(a.likeRatio??-1):(b.activePlayers??0)-(a.activePlayers??0));
    return result;
  },[games,view,watchlist,genreFilter,search,sort,hours]);
  const topMover=[...growers].sort((a,b)=>(b.metrics?.[String(hours)]?.growthPct??0)-(a.metrics?.[String(hours)]?.growthPct??0))[0];
  function chooseGame(game:Game){setSelectedId(game.id);setChartMode('game');}
  function changeView(next:View){setView(next);window.history.replaceState(null,'',`#${next}`);setLimit(next==='overview'?12:24);setSearch('');setGenreFilter('all');if(next==='watch'&&watched[0])chooseGame(watched[0]);}
  const updated=dataset.meta.generatedAt?new Date(dataset.meta.generatedAt):null;

  return <div className="appShell">
    <aside className="sidebar">
      <Link href="/" className="brandLink" aria-label="Roblox Trends home"><Brand/></Link>
      <div className="workspaceLabel">YOUR RESEARCH SPACE</div>
      <nav className="mainNav" aria-label="Main navigation">{([{id:'overview',label:'Overview',icon:'overview'},{id:'discover',label:'Discover',icon:'discover'},{id:'breakouts',label:'Breakouts',icon:'chart'},{id:'watch',label:'Watchlist',icon:'watch'}] as const).map(item=><button key={item.id} className={view===item.id?'navItem selected':'navItem'} onClick={()=>changeView(item.id)} aria-label={item.label} title={item.label} aria-current={view===item.id?'page':undefined}><Icon name={item.icon}/><span>{item.label}</span>{item.id==='watch'&&watchlist.length>0?<span className="navCount">{watchlist.length}</span>:null}</button>)}</nav>
      <div className="sidebarNote"><span className="noteOrbit"><Icon name="chart" size={24}/></span><h3>Spot the next wave.</h3><p>Follow the games and genres gaining attention.</p><button onClick={()=>changeView('discover')}>Explore games <Icon name="arrow" size={15}/></button></div>
      <div className="sidebarBottom"><Link href="/about"><Icon name="info" size={17}/> How the data works</Link><span>Made for curious creators.</span></div>
    </aside>

    <div className="mainWorkspace">
      <header className="topbar"><div className="breadcrumb">Workspace <span>/</span> <strong>{view==='breakouts'?'Breakouts':view==='watch'?'Watchlist':view==='discover'?'Discover':'Overview'}</strong></div><div className="topbarRight"><span className="collectionStatus"><i/> Public Roblox data</span><span className="creatorAvatar">R<span/></span></div></header>
      <main className="dashboardMain">
        <div className="pageHeading"><div><p className="eyebrow">A LITTLE SIGNAL. A BIGGER PICTURE.</p><h1>{view==='breakouts'?'Catch the next wave of growth.':view==='watch'?'Your next ideas, on watch.':view==='discover'?'Find what’s catching on.':'See where Roblox is heading.'}</h1><p className="pageSubheading">{view==='breakouts'?'Find growing audiences, follow the genres, and see what’s behind the movement.':view==='watch'?'A personal shortlist of experiences worth following.':view==='discover'?'Explore the audience, the movement, and the games behind it.':'Turn player activity into a little inspiration for your next game.'}</p></div><div className="updatePill"><span className="statusDot"/><span>{updated?<>Last collection <strong>{updated.toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'})}</strong></>:'Waiting for collection'}</span></div></div>
        {error?<div className="errorNotice" role="alert">{error} <button onClick={()=>window.location.reload()}>Try again</button></div>:null}
        {storageError?<div className="errorNotice" role="status">Your browser couldn’t save the watchlist. It will last for this session.</div>:null}

        {view!=='breakouts'?<section className="overviewStats" aria-label="Tracked sample overview">
          <div className="statTile"><span className="statLabel">Players in our sample <Icon name="players" size={16}/></span><strong>{loading?'—':compact(playerTotal)}</strong><span>Across {number(games.length)} tracked games</span></div>
          <div className="statTile"><span className="statLabel">Experiences tracked <Icon name="globe" size={16}/></span><strong>{loading?'—':number(games.length)}</strong><span>{genreLabels.length} primary genres to explore</span></div>
          <div className="statTile"><span className="statLabel">Games gaining players <Icon name="chart" size={16}/></span><strong>{loading||!measured.length?'—':`${growers.length}`}<small>{measured.length?` / ${measured.length}`:''}</small></strong><span>{measured.length?'Across available history in this range':'More observations are needed'}</span></div>
          <div className="statTile statHighlight"><span className="statLabel">Your watchlist <Icon name="watch" size={16}/></span><strong>{watchlist.length}<small> {watchlist.length===1?'game':'games'}</small></strong><button className="textButton" onClick={()=>changeView('watch')}>Keep your ideas close <Icon name="arrow" size={14}/></button></div>
        </section>:null}

        {view==='breakouts'?<BreakoutsPanel dataset={dataset} loading={loading} watchlist={watchlist} toggle={toggle} ready={ready}/>:<div className="dashboardGrid">
          <section className="panel heroPanel">
            <div className="panelTop"><div className="segmented"><button className={chartMode==='game'?'active':''} onClick={()=>setChartMode('game')}>Game activity</button><button className={chartMode==='genre'?'active':''} onClick={()=>setChartMode('genre')}>Genre lens</button></div><span className="quietLabel"><span className="statusDot"/> COLLECTED SNAPSHOTS</span></div>
            <div className="heroIdentity">{chartMode==='game'&&selected?<GameIcon game={selected} size="large"/>:<span className="genreHeroIcon"><Icon name="chart" size={30}/></span>}<div className="heroName"><p>{chartMode==='game'?selected?.creator??'Roblox experiences':'A view across the tracked sample'}</p><h2>{chartMode==='game'?selected?.name??(loading?'Loading experiences…':'No games collected yet'):genre?.key??'Genre activity'}</h2></div>{chartMode==='game'&&selected?<button className={`iconButton watchButton ${watchlist.includes(selected.id)?'saved':''}`} aria-label={`${watchlist.includes(selected.id)?'Remove':'Add'} ${selected.name} ${watchlist.includes(selected.id)?'from':'to'} watchlist`} aria-pressed={watchlist.includes(selected.id)} disabled={!ready} onClick={()=>toggle(selected.id)}><Icon name="watch"/></button>:null}</div>
            <div className="heroValue"><strong>{number(chartMode==='game'?selected?.activePlayers:genre?.medianActivePlayers)}</strong><span>{chartMode==='game'?'concurrent players':'median players per game'}</span></div>
            <p className={`heroChange ${((chartMode==='game'?metric?.growthPct:genre?.medianGrowthPct)??0)>=0?'positive':'negative'}`}>
              {chartMode==='game'?(metric?.growthPct==null?<span className="muted">Growth appears after more observations</span>:<><span>{percent(metric.growthPct)}</span><span className="muted"> across {duration(metric.hoursUsed)} of collected history</span></>):<><span>{percent(genre?.medianGrowthPct)}</span><span className="muted"> median change · {duration(genre?.medianWindowHoursUsed??0)} available</span></>}
            </p>
            <GenreFinanceChart hours={hours} data={points} loading={chartLoading} label={chartMode==='game'?'Players':'Median players'} height={280}/>
            <div className="chartFooter"><RangePicker hours={hours} onChange={setHours}/>{chartMode==='game'&&selected?<Link className="subtleLink" href={gameHref(selected.id)}>Explore game <Icon name="arrow" size={15}/></Link>:<span className="quietLabel">MEDIAN OF TRACKED GAMES</span>}</div>
            {historyError&&history.id===selectedId&&chartMode==='game'?<p className="chartNote">{historyError}</p>:null}
          </section>

          <aside className="panel watchPanel"><div className="sectionHeading"><h2>On your radar</h2><Icon name="watch" size={18}/></div><p className="sectionDescription">Small list. Big possibilities.</p>{watched.length?<div className="watchRows">{watched.slice(0,5).map(game=><button className="watchRow" key={game.id} onClick={()=>chooseGame(game)}><GameIcon game={game} size="small"/><span className="watchName"><strong>{game.name}</strong><small>{compact(game.activePlayers)} players</small></span><span className={(game.metrics?.[String(hours)]?.growthPct??0)>=0?'positive':'negative'}>{percent(game.metrics?.[String(hours)]?.growthPct)}</span></button>)}</div>:<div className="watchEmpty"><div className="watchIllustration"><span/><span/><Icon name="watch" size={30}/></div><h3>Good ideas deserve a bookmark.</h3><p>Tap the star on a game to follow its next chapter.</p><button className="softButton" onClick={()=>changeView('discover')}>Find a game <Icon name="arrow" size={15}/></button></div>}
          <div className="watchPanelBottom"><span className="quietLabel">WORTH A CLOSER LOOK</span>{topMover?<button className="moverSpotlight" onClick={()=>chooseGame(topMover)}><GameIcon game={topMover} size="small"/><span><strong>{topMover.name}</strong><small className="positive">{percent(topMover.metrics?.[String(hours)]?.growthPct)} across {duration(topMover.metrics?.[String(hours)]?.hoursUsed??0)}</small></span><Icon name="arrow" size={16}/></button>:<p>Movers will emerge as player history grows.</p>}</div><p className="localNote">Watchlist is saved on this browser.</p></aside>

          <section className="panel discoverPanel"><div className="sectionHeading"><div><p className="eyebrow">FOLLOW THE ATTENTION</p><h2>{view==='watch'?'Your watchlist':'Explore experiences'}</h2></div><span className="resultCount">{filtered.length} games</span></div>
            <div className="tableToolbar"><label className="searchField"><Icon name="discover" size={18}/><input type="search" aria-label="Search games" placeholder="Search games, creators, genres…" value={search} onChange={event=>{setSearch(event.target.value);setLimit(24);}}/>{search?<button onClick={()=>setSearch('')} aria-label="Clear search"><Icon name="close" size={14}/></button>:null}</label><div className="tableFilters"><select aria-label="Filter by genre" value={genreFilter} onChange={event=>{setGenreFilter(event.target.value);setLimit(24);}}><option value="all">All genres</option>{genreLabels.map(label=><option key={label} value={label}>{label}</option>)}</select><select aria-label="Sort games" value={sort} onChange={event=>setSort(event.target.value)}><option value="players">Most players</option><option value="growth">Biggest growth</option><option value="rating">Highest rated</option></select></div></div>
            <div className="gameTableWrap"><table className="gameTable"><thead><tr><th>Experience</th><th className="genreColumn">Genre</th><th>Players</th><th>Change <span title="Based on the available history within the selected range">ⓘ</span></th><th className="trendColumn">Activity</th><th className="ratingColumn">Rating</th><th><span className="sr-only">Watchlist</span></th></tr></thead><tbody>{filtered.slice(0,limit).map(game=>{const value=game.metrics?.[String(hours)];return <tr key={game.id} className={selectedId===game.id&&chartMode==='game'?'selectedRow':''}><td><button className="tableGame" onClick={()=>chooseGame(game)}><GameIcon game={game}/><span><strong>{game.name}</strong><small>{game.creator}</small></span></button></td><td className="genreColumn"><span className="genreTag">{game.genreL1??'Unknown'}</span></td><td className="numeric">{compact(game.activePlayers)}</td><td className={`numeric ${(value?.growthPct??0)>=0?'positive':'negative'}`}><span>{percent(value?.growthPct)}</span><small className="historyLabel">{value?.growthPct!=null?duration(value.hoursUsed):'Collecting'}</small></td><td className="trendColumn"><Sparkline points={value?.sparkline} positive={(value?.growthPct??0)>=0}/></td><td className="ratingColumn numeric">{game.likeRatio==null?'—':`${Math.round(game.likeRatio*100)}%`}</td><td><button className={`iconButton watchButton ${watchlist.includes(game.id)?'saved':''}`} aria-label={`${watchlist.includes(game.id)?'Remove':'Add'} ${game.name} ${watchlist.includes(game.id)?'from':'to'} watchlist`} aria-pressed={watchlist.includes(game.id)} disabled={!ready} onClick={()=>toggle(game.id)}><Icon name="watch" size={17}/></button></td></tr>;})}</tbody></table></div>
            {loading?<div className="tableEmpty">Gathering the latest collection…</div>:filtered.length===0?<div className="tableEmpty"><Icon name={view==='watch'?'watch':'discover'} size={25}/><h3>{view==='watch'?'Your watchlist is ready for its first game.':'No games match those filters.'}</h3><p>{view==='watch'?'Find an experience and tap its star.':'Try a different name or genre.'}</p><button className="softButton" onClick={()=>{if(view==='watch')changeView('discover');else{setSearch('');setGenreFilter('all');}}}>{view==='watch'?'Explore games':'Clear filters'}</button></div>:null}
            <div className="tableBottom"><span>Showing {Math.min(limit,filtered.length)} of {filtered.length} experiences</span>{filtered.length>limit?<button className="textButton" onClick={()=>setLimit(limit+24)}>Show more <Icon name="chevron" size={14}/></button>:<span className="quietLabel">YOUR NEXT IDEA COULD BE HERE</span>}</div>
          </section>

          <section className="genresSection"><div className="sectionHeading"><div><p className="eyebrow">ZOOM OUT A LITTLE</p><h2>Explore the bigger picture</h2></div><span className="quietLabel">GENRES IN YOUR SAMPLE</span></div><div className="genreCards">{genres.slice(0,4).map((item,index)=>{const cover=games.find(game=>[game.genreL1,game.genreL2].filter(Boolean).join(' / ')===item.key);return <button key={item.key} className={`genreCard genreTone${index} ${chartMode==='genre'&&genre?.key===item.key?'selected':''}`} onClick={()=>{setSelectedGenre(item.key);setChartMode('genre');}}><div className="genreCardTop"><span className="genreCardBadge">{item.gamesCount} tracked games</span><Icon name="arrow" size={17}/></div><div className="genreCardIdentity">{cover?<GameIcon game={cover}/>:<Icon name="globe"/>}<h3>{item.key}</h3></div><div className="genreCardBottom"><span>{compact(item.medianActivePlayers)}<small>median players</small></span><span className={item.medianGrowthPct==null?'muted':item.medianGrowthPct>=0?'positive':'negative'}>{percent(item.medianGrowthPct)}<small>{duration(item.medianWindowHoursUsed)}</small></span></div></button>;})}</div>{!genres.length&&!loading?<p className="sectionDescription">Genre comparisons appear after games are collected.</p>:null}</section>
        </div>}
        <footer className="dashboardFooter"><span><span className="statusDot"/> Collected about every 30 minutes · A sample of Roblox, not the whole platform.</span><Link href="/about">Understand the signals <Icon name="arrow" size={13}/></Link></footer>
      </main>
    </div>
  </div>;
}
