"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

type TimeRange = "24h" | "7d" | "30d";

type TrendingGame = {
  id: string;
  name: string;
  creator: string;
  tags: string[];
  activePlayers: number;
  growthPct: number; // +12.3 means up 12.3%
};

export default function Home() {
  const [range, setRange] = useState<TimeRange>("7d");
  const [games, setGames] = useState<TrendingGame[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function Load() {
      setLoading(true);
      const Res = await fetch(`/api/trending?range=${range}`);
      const Data = (await Res.json()) as { games: TrendingGame[] };
      if (!cancelled) {
        setGames(Data.games);
        setLoading(false);
      }
    }

    Load();
    return () => {
      cancelled = true;
    };
  }, [range]);

  const TrendingTags = useMemo(() => {
    const Counts = new Map<string, number>();
    for (const Game of games) {
      for (const Tag of Game.tags) {
        Counts.set(Tag, (Counts.get(Tag) ?? 0) + 1);
      }
    }
    return [...Counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([Tag]) => Tag);
  }, [games]);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-xl bg-zinc-800" />
            <div>
              <p className="text-sm text-zinc-400">Roblox AI</p>
              <h1 className="text-lg font-semibold leading-none">Trends</h1>
            </div>
          </div>

          <nav className="flex items-center gap-4 text-sm text-zinc-300">
            <Link className="hover:text-white" href="/">
              Dashboard
            </Link>
            <Link className="hover:text-white" href="/about">
              About
            </Link>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-3xl font-bold tracking-tight">Trending right now</h2>
            <p className="mt-2 max-w-xl text-zinc-400">
              Step 1 uses mock data + a simple API route. Later we’ll replace this with real ingest + DB.
            </p>
          </div>

          <div className="flex items-center gap-2">
            {(["24h", "7d", "30d"] as const).map((R) => (
              <button
                key={R}
                onClick={() => setRange(R)}
                className={[
                  "rounded-xl border px-3 py-2 text-sm",
                  range === R
                    ? "border-zinc-600 bg-zinc-800 text-white"
                    : "border-zinc-800 bg-zinc-900 text-zinc-300 hover:bg-zinc-800",
                ].join(" ")}
              >
                {R}
              </button>
            ))}
          </div>
        </div>

        <section className="mt-8 grid gap-4 md:grid-cols-3">
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-5 md:col-span-2">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold">Top trending games</h3>
              <p className="text-sm text-zinc-400">Range: {range}</p>
            </div>

            {loading ? (
              <p className="mt-4 text-zinc-400">Loading…</p>
            ) : (
              <div className="mt-4 grid gap-3">
                {games.map((Game) => (
                  <Link
                    key={Game.id}
                    href={`/games/${Game.id}`}
                    className="rounded-2xl border border-zinc-800 bg-zinc-950 p-4 hover:bg-zinc-900"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <p className="text-base font-semibold">{Game.name}</p>
                        <p className="text-sm text-zinc-400">by {Game.creator}</p>

                        <div className="mt-3 flex flex-wrap gap-2">
                          {Game.tags.map((Tag) => (
                            <span
                              key={Tag}
                              className="rounded-full border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs text-zinc-300"
                            >
                              {Tag}
                            </span>
                          ))}
                        </div>
                      </div>

                      <div className="text-right">
                        <p className="text-sm text-zinc-400">Active</p>
                        <p className="text-xl font-bold">{Game.activePlayers.toLocaleString()}</p>
                        <p className={Game.growthPct >= 0 ? "text-green-400" : "text-red-400"}>
                          {Game.growthPct >= 0 ? "+" : ""}
                          {Game.growthPct.toFixed(1)}%
                        </p>
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-5">
            <h3 className="text-lg font-semibold">Trending tags</h3>
            <p className="mt-1 text-sm text-zinc-400">Most common tags in the list.</p>

            <div className="mt-4 flex flex-wrap gap-2">
              {TrendingTags.length === 0 && !loading ? (
                <span className="text-zinc-400">No tags yet.</span>
              ) : (
                TrendingTags.map((Tag) => (
                  <span
                    key={Tag}
                    className="rounded-full border border-zinc-800 bg-zinc-950 px-3 py-1 text-sm text-zinc-200"
                  >
                    {Tag}
                  </span>
                ))
              )}
            </div>

            <div className="mt-6 rounded-2xl border border-zinc-800 bg-zinc-950 p-4">
              <p className="text-sm font-semibold">Next up (Step 2)</p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-zinc-400">
                <li>Supabase Postgres schema</li>
                <li>Ingest job (GitHub Actions)</li>
                <li>Real trend scoring</li>
              </ul>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-zinc-800">
        <div className="mx-auto max-w-6xl px-6 py-6 text-sm text-zinc-500">
          Built with Next.js + TypeScript (Step 1)
        </div>
      </footer>
    </div>
  );
}
