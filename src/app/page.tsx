"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import GenreFinanceChart from "@/app/components/GenreFinanceChart";
import type { UTCTimestamp } from "lightweight-charts";
import { gameHref, loadGenreSeries, loadTrendingGenres, type DatasetMeta } from "@/app/lib/dashboardData";

type TimeRange = "24h" | "7d" | "2w" | "30d";

type TrendingGenre = {
  key: string;
  trendScore: number;
  gamesCount: number;

  medianActivePlayers: number;
  medianGrowthPct: number | null;

  medianWindowHoursUsed?: number;
  windowCoverage?: number;

  medianGrowth24hPct: number | null;

  medianConfidence: number;
  leaderGrowthMedian: number | null;
  breakoutGrowthMedian: number | null;

  confidenceBand: "Low" | "Medium" | "High";
  opportunityScore: number;
  breakoutsCount: number;

  topGames: Array<{
    id: string;
    name: string;
    creator: string;
    activePlayersNow: number;
    rWindowPct: number | null;
    r24hPct: number;
  }>;
};

function confidenceColor(band: "Low" | "Medium" | "High") {
  if (band === "High") return "text-green-400";
  if (band === "Medium") return "text-yellow-400";
  return "text-zinc-400";
}

function opportunityBand(x: number) {
  if (x >= 30) return { label: "High", cls: "text-green-400" };
  if (x >= 18) return { label: "Medium", cls: "text-yellow-400" };
  return { label: "Low", cls: "text-zinc-400" };
}

function saturationBand(gamesCount: number) {
  if (gamesCount >= 25) return { label: "High", cls: "text-red-400" };
  if (gamesCount >= 12) return { label: "Medium", cls: "text-yellow-400" };
  return { label: "Low", cls: "text-green-400" };
}


function rangeToHours(range: TimeRange) {
  if (range === "24h") return 24;
  if (range === "7d") return 24 * 7;
  if (range === "2w") return 24 * 14;
  return 24 * 30;
}

function fmtHours(h: number) {
  if (!Number.isFinite(h) || h <= 0) return "—";
  if (h < 24) return `${h.toFixed(0)}h`;
  const d = h / 24;
  // 0-3 days: show 1 decimal, otherwise no decimals
  const s = d < 3 ? d.toFixed(1) : d.toFixed(0);
  return `${s}d`;
}

export default function Home() {
  const [range, setRange] = useState<TimeRange>("7d");
  const [genres, setGenres] = useState<TrendingGenre[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [meta, setMeta] = useState<DatasetMeta>({});
  const [seriesError, setSeriesError] = useState("");

  // NEW: selected genre + chart series
  const [selectedKey, setSelectedKey] = useState<string>("");
  const [series, setSeries] = useState<{ time: number; value: number }[]>([]);
  const [seriesLoading, setSeriesLoading] = useState(false);

  // Load trending genres list
  useEffect(() => {
    let cancelled = false;

    async function Load() {
      setLoading(true);

      setError("");
      try {
        const Data = await loadTrendingGenres(rangeToHours(range));
        const Genres = Array.isArray(Data.genres) ? (Data.genres as TrendingGenre[]) : [];
        if (!cancelled) {
          setGenres(Genres);
          setMeta(Data.meta ?? {});
          setSelectedKey(previous => previous && Genres.some(genre => genre.key === previous) ? previous : Genres[0]?.key ?? "");
        }
      } catch (failure) {
        if (!cancelled) setError(failure instanceof Error ? failure.message : "Could not load trends.");
      } finally { if (!cancelled) setLoading(false); }
    }

    Load();
    return () => {
      cancelled = true;
    };
  }, [range]);

  // Load chart series for selected genre + range
  useEffect(() => {
    let cancelled = false;

    async function LoadSeries() {
      if (!selectedKey) { setSeries([]); return; }

      setSeriesLoading(true);

      setSeriesError("");
      try {
        const json = await loadGenreSeries(selectedKey, rangeToHours(range));
        if (!cancelled) setSeries(Array.isArray(json.points) ? json.points : []);
      } catch (failure) {
        if (!cancelled) { setSeries([]); setSeriesError(failure instanceof Error ? failure.message : "Could not load chart."); }
      } finally { if (!cancelled) setSeriesLoading(false); }
    }

    LoadSeries();
    return () => {
      cancelled = true;
    };
  }, [selectedKey, range]);

  // Cast time to UTCTimestamp for lightweight-charts
  const chartData = series.map((p) => ({
    time: p.time as UTCTimestamp,
    value: p.value,
  }));

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-xl bg-zinc-800" />
            <div>
              <p className="text-sm text-zinc-400">Roblox</p>
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
            <h2 className="text-3xl font-bold tracking-tight">Trending genres right now</h2>
            <p className="mt-2 max-w-xl text-zinc-400">
              Use this to decide what kind of game to build (momentum + size + confidence).
            </p>
          </div>

          <div className="flex items-center gap-2">
            {(["24h", "7d", "2w", "30d"] as const).map((R) => (
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

        {meta.generatedAt ? <p className="mt-4 text-sm text-zinc-400">
          Updated {new Date(meta.generatedAt).toLocaleString()} · {meta.gamesCollected} games tracked
          {meta.historySource === "currentSnapshot" ? " · Live snapshot only; historical comparisons are unavailable." : ""}
          {meta.historyTruncated || meta.trackingCapped ? " · Collection coverage is limited." : ""}
        </p> : null}

        <section className="mt-8 grid gap-4 md:grid-cols-3">
          <div className="min-w-0 rounded-2xl border border-zinc-800 bg-zinc-900 p-5 md:col-span-2">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-semibold">Top trending genres</h3>
                <p className="mt-1 text-xs text-zinc-500">
                  Requested range: {range} • Growth uses available history • Score uses momentum + size
                </p>
              </div>
              <p className="text-sm text-zinc-400">Range: {range}</p>
            </div>

            {error ? <p className="mt-4 text-red-400" role="alert">{error}</p> : loading ? (
              <p className="mt-4 text-zinc-400">Loading…</p>
            ) : genres.length === 0 ? (
              <p className="mt-4 text-zinc-400">No current snapshots are available yet.</p>
            ) : (
              <>
                {/* NEW: chart panel */}
                <div className="mt-4">
                  {seriesError ? <p className="text-red-400" role="alert">{seriesError}</p> : seriesLoading ? (
                    <div className="rounded-2xl border border-zinc-800 bg-zinc-950 p-4 text-zinc-400">
                      Loading chart…
                    </div>
                  ) : (
                    <GenreFinanceChart title={selectedKey || "—"} data={chartData} />
                  )}
                </div>

                <div className="mt-4 grid gap-3">
                  {genres.map((G) => (
                    <div
                      key={G.key}
                      onClick={() => setSelectedKey(G.key)}
                      className={[
                        "cursor-pointer rounded-2xl border bg-zinc-950 p-4",
                        selectedKey === G.key ? "border-zinc-500" : "border-zinc-800",
                      ].join(" ")}
                    >
                      <div className="flex flex-col items-start justify-between gap-4 sm:flex-row">
                        <div className="min-w-0 flex-1">
                          <p className="text-base font-semibold">{G.key}</p>

                          <p className="text-sm text-zinc-400">
                            {(() => {
                              const s = saturationBand(G.gamesCount);
                              return (
                                <>
                                  {G.gamesCount} games •{" "}
                                  <span className={s.cls}>sample saturation {s.label}</span> •{" "}
                                </>
                              );
                            })()}
                            <span className={confidenceColor(G.confidenceBand)}>
                              confidence {G.confidenceBand}
                            </span>
                            {" • "}
                            <span className="text-zinc-300">
                              breakouts {G.breakoutsCount}
                              <span className="text-zinc-600"> (≥+8% & +2k)</span>
                            </span>
                            {" • "}
                            {(() => {
                              const o = opportunityBand(G.opportunityScore);
                              return (
                                <span className={o.cls}>
                                  opportunity {o.label}{" "}
                                  <span className="text-zinc-600">
                                    ({G.opportunityScore.toFixed(1)})
                                  </span>
                                </span>
                              );
                            })()}
                          </p>

                          {(G.medianWindowHoursUsed ?? 0) > 0 ? (() => {
                            const leadersCls =
                              (G.leaderGrowthMedian ?? 0) >= 0 ? "text-green-400" : "text-red-400";
                            const smallsCls =
                              (G.breakoutGrowthMedian ?? 0) >= 0 ? "text-green-400" : "text-red-400";

                            return (
                              <div className="text-xs text-zinc-500">
                                <span className={leadersCls}>Leaders: {G.leaderGrowthMedian == null ? "—" : `${G.leaderGrowthMedian.toFixed(1)}%`}</span>
                                  { " • "}
                                <span className={smallsCls}>Smalls: {G.breakoutGrowthMedian == null ? "—" : `${G.breakoutGrowthMedian.toFixed(1)}%`}</span>
                              </div>
                            );
                          })() : null}

                          <div className="mt-3 grid gap-2">
                            {G.topGames?.slice(0, 3).map((tg) => (
                              <Link
                                key={tg.id}
                                href={gameHref(tg.id)}
                                className="block rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 hover:bg-zinc-800"
                                onClick={(e) => e.stopPropagation()} // so clicking a game doesn't also change selection
                              >
                                <div className="flex items-center justify-between gap-3">
                                  <div className="min-w-0">
                                    <p className="truncate text-sm font-medium">{tg.name}</p>
                                    <p className="truncate text-xs text-zinc-400">by {tg.creator}</p>
                                  </div>
                                  <div className="text-right">
                                    <p className="text-xs text-zinc-400">{tg.activePlayersNow.toLocaleString()}</p>
                                    {tg.rWindowPct == null ? (
                                      <p className="text-zinc-500 text-xs">—</p>
                                      ) : (
                                      <p className={tg.rWindowPct >= 0 ? "text-green-400 text-xs" : "text-red-400 text-xs"}>
                                        {tg.rWindowPct >= 0 ? "+" : ""}
                                        {tg.rWindowPct.toFixed(1)}%
                                      </p>
                                      )}
                                  </div>
                                </div>
                              </Link>
                            ))}
                          </div>
                        </div>
                        <div className="shrink-0 sm:text-right">
                          <p className="text-sm text-zinc-400">Median active</p>
                          <p className="text-xl font-bold">
                            {Math.round(G.medianActivePlayers).toLocaleString()}
                          </p>

                          {G.medianGrowthPct == null ? (
                            <p className="text-xs text-zinc-500 mt-1">—</p>
                          ) : (
                            <p className={G.medianGrowthPct >= 0 ? "text-green-400" : "text-red-400"}>
                              {G.medianGrowthPct >= 0 ? "+" : ""}
                              {G.medianGrowthPct.toFixed(1)}% <span className="text-zinc-500">({range})</span>
                            </p>
                          )}

                          <p className="mt-1 text-xs text-zinc-500">
                            req {range} • avail {fmtHours(G.medianWindowHoursUsed ?? rangeToHours(range))}
                            {typeof G.windowCoverage === "number" ? (
                            <span className="text-zinc-600"> • coverage {(G.windowCoverage * 100).toFixed(0)}%</span>
                          ) : null}
                        </p>

                        {range !== "24h" && G.medianGrowth24hPct != null && (
                          <p className="text-xs text-zinc-500">
                          24h median: {G.medianGrowth24hPct >= 0 ? "+" : ""}
                          {G.medianGrowth24hPct.toFixed(1)}%
                        </p>
                      )}
                    </div>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-5">
            <h3 className="text-lg font-semibold">How to use this</h3>
            <p className="mt-1 text-sm text-zinc-400">
              Compare growth, audience size, and historical coverage. These results describe the
              tracked sample, which does not include every Roblox game.
            </p>

            <div className="mt-6 rounded-2xl border border-zinc-800 bg-zinc-950 p-4">
              <p className="text-sm font-semibold">Reading the results</p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-zinc-400">
                <li>Growth requires at least two recorded observations.</li>
                <li>Check available history against the selected range.</li>
                <li>Opportunity is a momentum heuristic; ML predictions are not available yet.</li>
              </ul>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-zinc-800">
        <div className="mx-auto max-w-6xl px-6 py-6 text-sm text-zinc-500">
          Built with Next.js + TypeScript
        </div>
      </footer>
    </div>
  );
}
