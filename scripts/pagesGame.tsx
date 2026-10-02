"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type Game = { id: string; rootPlaceId: string | null; name: string; creator: string; description: string; genreL1: string | null; genreL2: string | null; activePlayers: number | null };

export default function GamePage() {
  const [game, setGame] = useState<Game | null>(null);
  const [message, setMessage] = useState("Loading game…");
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
          <h1 className="mt-5 text-3xl font-bold">{game.name}</h1>
          <p className="mt-2 text-zinc-400">by {game.creator} · {[game.genreL1, game.genreL2].filter(Boolean).join(" / ")}</p>
          <section className="mt-6 rounded-2xl border border-zinc-800 bg-zinc-900 p-6">
            <p className="text-sm text-zinc-400">Players at latest collection</p>
            <p className="mt-1 text-3xl font-bold">{game.activePlayers?.toLocaleString() ?? "Unavailable"}</p>
            <p className="mt-6 whitespace-pre-line text-zinc-300">{game.description}</p>
            {game.rootPlaceId ? <a href={`https://www.roblox.com/games/${game.rootPlaceId}`} target="_blank" rel="noopener noreferrer" className="mt-6 inline-block rounded-xl bg-blue-600 px-4 py-2 text-white hover:bg-blue-500">View on Roblox</a> : null}
          </section>
        </> : null}
      </div>
    </main>
  );
}
