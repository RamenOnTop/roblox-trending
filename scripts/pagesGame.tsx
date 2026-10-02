"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type RelatedGame = { id: string; name: string; rootPlaceId: string | null };
type Enrichment = { iconUrl?: string; thumbnails?: string[]; badges?: {id:string;name:string;description:string;enabled:boolean;awardedCount:number|null;pastDayAwardedCount:number|null}[];
  badgesHasMore?: boolean; badgesCheckedAt?: string; relatedGames?: RelatedGame[]; relatedCheckedAt?: string; creatorGames?: RelatedGame[]; creatorCheckedAt?: string; };
type Game = { id: string; rootPlaceId: string | null; name: string; creator: string; creatorType?: string; description: string; genreL1: string | null; genreL2: string | null; activePlayers: number | null; enrichment?: Enrichment };

function RelatedList({ title, items, checkedAt, trackedIds }: {title:string;items?:RelatedGame[];checkedAt?:string;trackedIds:Set<string>}) {
  return <section className="mt-6 rounded-2xl border border-zinc-800 bg-zinc-900 p-6">
    <h2 className="text-xl font-semibold">{title}</h2>
    {checkedAt ? <p className="mt-1 text-xs text-zinc-500">Collected {new Date(checkedAt).toLocaleString()}</p> : null}
    {items == null ? <p className="mt-3 text-sm text-zinc-400">Waiting for a scheduled detail refresh.</p> : items.length === 0 ? <p className="mt-3 text-sm text-zinc-400">No games returned by Roblox.</p> :
      <ul className="mt-4 space-y-3">{items.map(item => <li key={item.id}>
        {trackedIds.has(item.id) ? <Link className="text-blue-300 hover:text-blue-200" href={`/game/?id=${item.id}`}>{item.name}</Link> : item.rootPlaceId ?
          <a className="text-blue-300 hover:text-blue-200" href={`https://www.roblox.com/games/${item.rootPlaceId}`} target="_blank" rel="noopener noreferrer">{item.name} ↗</a> : <span>{item.name}</span>}
      </li>)}</ul>}
  </section>;
}

export default function GamePage() {
  const [game, setGame] = useState<Game | null>(null);
  const [message, setMessage] = useState("Loading game…");
  const [trackedIds, setTrackedIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const id = new URLSearchParams(window.location.search).get("id");
        const response = await fetch(`${process.env.dashboardBasePath ?? ""}/data/dashboard.json`);
        if (!response.ok) throw new Error("Game data is temporarily unavailable.");
        const dataset = await response.json();
        const found = (dataset.games as Game[]).find(item => item.id === id);
        if (!cancelled) {
          setGame(found ?? null);
          setTrackedIds(new Set((dataset.games as Game[]).map(item => item.id)));
          setMessage(found ? "" : "This game is not in the current tracked sample.");
        }
      } catch (error) { if (!cancelled) setMessage(error instanceof Error ? error.message : "Could not load game data."); }
    }
    load();
    return () => { cancelled = true; };
  }, []);
  return (
    <main className="min-h-screen bg-zinc-950 px-6 py-10 text-zinc-100">
      <div className="mx-auto max-w-3xl">
        <Link href="/" className="text-sm text-zinc-400 hover:text-white">← Back to Dashboard</Link>
        {message ? <p className="mt-6 text-zinc-400" role="status">{message}</p> : null}
        {game ? <>
          <div className="mt-5 flex items-center gap-4">
            {game.enrichment?.iconUrl ? <img src={game.enrichment.iconUrl} alt={`${game.name} icon`} width={72} height={72} className="h-18 w-18 shrink-0 rounded-xl" onError={event => {event.currentTarget.style.display = 'none';}} /> : null}
            <h1 className="min-w-0 break-words text-3xl font-bold">{game.name}</h1>
          </div>
          <p className="mt-2 text-zinc-400">by {game.creator} · {[game.genreL1, game.genreL2].filter(Boolean).join(" / ")}</p>
          <section className="mt-6 rounded-2xl border border-zinc-800 bg-zinc-900 p-6">
            <p className="text-sm text-zinc-400">Players at latest collection</p>
            <p className="mt-1 text-3xl font-bold">{game.activePlayers?.toLocaleString() ?? "Unavailable"}</p>
            <p className="mt-6 whitespace-pre-line text-zinc-300">{game.description}</p>
            {game.rootPlaceId ? <a href={`https://www.roblox.com/games/${game.rootPlaceId}`} target="_blank" rel="noopener noreferrer" className="mt-6 inline-block rounded-xl bg-blue-600 px-4 py-2 text-white hover:bg-blue-500">View on Roblox</a> : null}
          </section>
          {game.enrichment?.thumbnails?.length ? <section className="mt-6" aria-label="Game screenshots">
            <h2 className="mb-3 text-xl font-semibold">Screenshots</h2>
            <div className="grid gap-3 sm:grid-cols-2">{game.enrichment.thumbnails.map(url => <img key={url} src={url} alt={`${game.name} promotional screenshot`} width={768} height={432} loading="lazy" className="aspect-video w-full rounded-xl object-cover" onError={event => {event.currentTarget.style.display = 'none';}} />)}</div>
          </section> : null}
          <section className="mt-6 rounded-2xl border border-zinc-800 bg-zinc-900 p-6">
            <h2 className="text-xl font-semibold">Badges</h2>
            <p className="mt-1 text-xs text-zinc-500">Up to 10 badges per game. Awards describe badges, not unique players or retention.</p>
            {game.enrichment?.badgesCheckedAt ? <p className="mt-1 text-xs text-zinc-500">Collected {new Date(game.enrichment.badgesCheckedAt).toLocaleString()}</p> : null}
            {game.enrichment?.badges == null ? <p className="mt-3 text-sm text-zinc-400">Waiting for a scheduled detail refresh.</p> : game.enrichment.badges.length === 0 ? <p className="mt-3 text-sm text-zinc-400">No badges returned by Roblox.</p> :
              <ul className="mt-4 space-y-4">{game.enrichment.badges.map(badge => <li key={badge.id}>
                <a className="font-medium text-blue-300 hover:text-blue-200" href={`https://www.roblox.com/badges/${badge.id}`} target="_blank" rel="noopener noreferrer">{badge.name} ↗</a>
                {!badge.enabled ? <span className="ml-2 text-xs text-zinc-500">Disabled</span> : null}
                <p className="mt-1 text-sm text-zinc-400">{badge.description}</p>
                <p className="mt-1 text-xs text-zinc-500">Total awards: {badge.awardedCount?.toLocaleString() ?? 'Unavailable'} · Past day: {badge.pastDayAwardedCount?.toLocaleString() ?? 'Unavailable'}</p>
              </li>)}</ul>}
            {game.enrichment?.badgesHasMore ? <p className="mt-4 text-xs text-zinc-500">Roblox has additional badges beyond this sample.</p> : null}
          </section>
          <RelatedList title="Roblox recommendations" items={game.enrichment?.relatedGames} checkedAt={game.enrichment?.relatedCheckedAt} trackedIds={trackedIds} />
          {game.creatorType === 'User' ? <RelatedList title="More from this creator" items={game.enrichment?.creatorGames} checkedAt={game.enrichment?.creatorCheckedAt} trackedIds={trackedIds} /> : null}
        </> : null}
      </div>
    </main>
  );
}
