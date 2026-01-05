// app/api/genres/trending/route.ts
import { NextResponse } from "next/server";
import { SupabaseServer } from "@/app/lib/supabaseServer";

type Row = {
  game_id: string;
  active_players: number | null;
  visits: number | null;
  favorites: number | null;
  like_ratio: number | null; // 0..1
  captured_at: string;
  games?: {
    name?: string;
    creator?: string;
    genre_l1?: string | null;
    genre_l2?: string | null;
  } | null;
};

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}
function safeNum(x: any, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}
function parseMs(iso: string) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}
function hoursBetween(aMs: number, bMs: number) {
  const h = Math.abs(aMs - bMs) / 3600000;
  return h > 0 ? h : 0;
}
function logReturn(now: number, then: number, k = 50) {
  return Math.log((now + k) / (then + k));
}
function median(nums: number[]) {
  const arr = nums.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (arr.length === 0) return 0;
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 === 1 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}
function confidenceLabel(c: number) {
  if (c >= 0.66) return "High";
  if (c >= 0.33) return "Medium";
  return "Low";
}
function confidenceColor(c: number) {
  if (c >= 0.66) return "text-green-400";
  if (c >= 0.33) return "text-yellow-400";
  return "text-zinc-400";
}

/**
 * Find the snapshot closest to (now - minutesBack), preferring snapshots at/before target.
 * If none exist, returns the oldest snapshot.
 */
function pickSnapshot(snaps: Row[], nowMs: number, minutesBack: number): Row | null {
  if (snaps.length === 0) return null;
  const target = nowMs - minutesBack * 60_000;

  // snaps are sorted desc (newest first)
  for (const s of snaps) {
    const t = parseMs(s.captured_at);
    if (t !== 0 && t <= target) return s;
  }
  return snaps[snaps.length - 1] ?? null;
}

function scoreGame(snaps: Row[]) {
  const now = snaps[0];
  const nowMs = parseMs(now.captured_at) || Date.now();

  const P0 = Math.max(0, safeNum(now.active_players));
  const V0 = Math.max(0, safeNum(now.visits));
  const F0 = Math.max(0, safeNum(now.favorites));
  const like = clamp(now.like_ratio == null ? 0.5 : safeNum(now.like_ratio), 0, 1);

  // liquidity weight (keeps tiny games from dominating)
  const liquidity = clamp(Math.log1p(P0), 0, 8);
  const qualityTilt = 2 * (like - 0.5);

  const s30 = pickSnapshot(snaps, nowMs, 30);
  const s6h = pickSnapshot(snaps, nowMs, 6 * 60);
  const s24h = pickSnapshot(snaps, nowMs, 24 * 60);

  let r30 = 0,
    r6h = 0,
    r24h = 0;

  let r6hPerHour = 0;
  let r24hPerHour = 0;

  let vPerHour24 = 0;
  let fPerHour24 = 0;
  let growthAbs24 = 0;

  const has30 = !!(s30 && s30 !== now);
  const has6 = !!(s6h && s6h !== now);
  const has24 = !!(s24h && s24h !== now);

  if (has30) {
    const P30 = Math.max(0, safeNum(s30!.active_players));
    r30 = clamp(logReturn(P0, P30, 50), -0.7, 0.7);
  }

  if (has6) {
    const P6 = Math.max(0, safeNum(s6h!.active_players));
    r6h = clamp(logReturn(P0, P6, 50), -1.2, 1.2);
    const h6 = hoursBetween(nowMs, parseMs(s6h!.captured_at));
    if (h6 > 0) r6hPerHour = r6h / h6;
  }

  if (has24) {
    const P24 = Math.max(0, safeNum(s24h!.active_players));
    r24h = clamp(logReturn(P0, P24, 50), -2.0, 2.0);
    const h24 = hoursBetween(nowMs, parseMs(s24h!.captured_at));
    growthAbs24 = P0 - P24;
    if (h24 > 0) {
      r24hPerHour = r24h / h24;

      const V24 = Math.max(0, safeNum(s24h!.visits));
      const F24 = Math.max(0, safeNum(s24h!.favorites));
      vPerHour24 = (V0 - V24) / h24;
      fPerHour24 = (F0 - F24) / h24;
    }
  }

  let accel = 0;
  if (has30 && has6 && r6hPerHour !== 0) {
    accel = clamp(r30 - r6hPerHour * 0.5, -0.7, 0.7);
  }

  const flowVisits = Math.log1p(Math.max(0, vPerHour24));
  const flowFavs = Math.log1p(Math.max(0, fPerHour24));

  let momentumCore = 0;
  if (has30) momentumCore += 1.35 * r30;
  if (has6) momentumCore += 1.0 * r6hPerHour;
  if (has24) momentumCore += 0.65 * r24hPerHour;
  if (has30 && has6) momentumCore += 0.9 * accel;
  if (has24) {
    momentumCore += 0.1 * flowVisits;
    momentumCore += 0.18 * flowFavs;
  }
  momentumCore += 0.2 * qualityTilt;

  const oldest = snaps[snaps.length - 1];
  const spanHours = oldest ? hoursBetween(nowMs, parseMs(oldest.captured_at)) : 0;

  // confidence ramps toward 1 as you approach 24h of coverage + horizons exist
  const coverage24 = clamp(spanHours / 24, 0, 1);
  const horizonFactor =
    0.15 + (has30 ? 0.25 : 0) + (has6 ? 0.25 : 0) + (has24 ? 0.35 : 0);
  const confidence = clamp(coverage24 * horizonFactor, 0, 1);

  const presence = 0.12 * liquidity + 0.35 * qualityTilt;
  const finalScore = liquidity * momentumCore + (1 - confidence) * presence;

  const r30Pct = (Math.exp(r30) - 1) * 100;
  const r6hPct = (Math.exp(r6h) - 1) * 100;
  const r24hPct = (Math.exp(r24h) - 1) * 100;

  return {
    score: Number.isFinite(finalScore) ? finalScore : 0,
    confidence: Number.isFinite(confidence) ? confidence : 0,
    activePlayers: P0,

    r30Pct: Number.isFinite(r30Pct) ? r30Pct : 0,
    r6hPct: Number.isFinite(r6hPct) ? r6hPct : 0,
    r24hPct: Number.isFinite(r24hPct) ? r24hPct : 0,
    
    growthAbs24,  
    has24,
    spanHours,
  };
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);

    // How you want to group genres:
    // - group=both -> "l1 / l2"
    // - group=l1   -> only genre_l1
    // - group=l2   -> only genre_l2
    const group = (url.searchParams.get("group") ?? "both").toLowerCase();

    // Genre list limit
    const limit = clamp(Number(url.searchParams.get("limit") ?? "20"), 1, 100);

    // Analyze last N hours (defaults 7d)
    const windowHours = clamp(Number(url.searchParams.get("windowHours") ?? String(24 * 7)), 6, 24 * 30);

    // Ignore ultra tiny games (optional)
    const minPlayers = clamp(Number(url.searchParams.get("minPlayers") ?? "0"), 0, 1_000_000);

    // Sum only the top K games in each genre (reduces outlier domination)
    const topK = clamp(Number(url.searchParams.get("topK") ?? "5"), 1, 25);

    // Global row limit (raise as you track more games)
    const maxRows = clamp(Number(url.searchParams.get("maxRows") ?? "50000"), 1000, 200000);

    const sinceIso = new Date(Date.now() - windowHours * 3600_000).toISOString();

    const { data, error } = await SupabaseServer
      .from("game_snapshots")
      .select("game_id, active_players, visits, favorites, like_ratio, captured_at, games(name, creator, genre_l1, genre_l2)")
      .gte("captured_at", sinceIso)
      .order("captured_at", { ascending: false })
      .limit(maxRows);

    if (error) return NextResponse.json({ genres: [], error: error.message }, { status: 500 });

    const rows = (data ?? []) as Row[];

    // Group by game_id
    const byGame = new Map<string, Row[]>();
    for (const r of rows) {
      const arr = byGame.get(r.game_id) ?? [];
      arr.push(r);
      byGame.set(r.game_id, arr);
    }

    // Ensure newest->oldest per game
    for (const [id, arr] of byGame) {
      arr.sort((a, b) => parseMs(b.captured_at) - parseMs(a.captured_at));
      byGame.set(id, arr);
    }

    // Score each game once
    const scoredGames = Array.from(byGame.entries())
      .map(([gameId, snaps]) => {
        const now = snaps[0];
        const g1 = (now.games?.genre_l1 ?? null) as string | null;
        const g2 = (now.games?.genre_l2 ?? null) as string | null;

        const s = scoreGame(snaps);

        return {
          id: gameId,
          name: now.games?.name ?? "Unknown",
          creator: now.games?.creator ?? "Unknown",
          genre_l1: g1,
          genre_l2: g2,

          activePlayers: s.activePlayers,
          score: s.score,
          confidence: s.confidence,
          growthAbs24: s.growthAbs24,


          r30Pct: s.r30Pct,
          r6hPct: s.r6hPct,
          r24hPct: s.r24hPct,
          has24: s.has24,
        };
      })
      .filter((g) => g.activePlayers >= minPlayers);

    // Group games into genres
    type GameEntry = (typeof scoredGames)[number];
    type GenreAgg = {
      key: string;
      genre_l1: string | null;
      genre_l2: string | null;

      games: GameEntry[];
    };

    const byGenre = new Map<string, GenreAgg>();

    function makeKey(g1: string | null, g2: string | null) {
      if (group === "l1") return g1 ?? "Unknown";
      if (group === "l2") return g2 ?? "Unknown";

      // group === "both"
      const a = g1 ?? "Unknown";
      const b = g2 ?? null;
      return b ? `${a} / ${b}` : a; // no trailing slash
    }

    for (const g of scoredGames) {
      const key = makeKey(g.genre_l1, g.genre_l2);
      const existing = byGenre.get(key);
      if (existing) {
        existing.games.push(g);
      } else {
        byGenre.set(key, {
          key,
          genre_l1: group === "l2" ? null : (g.genre_l1 ?? null),
          genre_l2: group === "l1" ? null : (g.genre_l2 ?? null),
          games: [g],
        });
      }
    }

    // Build final genre list
    const genres = Array.from(byGenre.values())
      .map((agg) => {
        const games = agg.games.slice().sort((a, b) => b.score - a.score);

        // Trend score = sum of topK games, weighted slightly by confidence (reduces noisy 1-snapshot spikes)
        const top = games.slice(0, topK);
        const trendScore = top.reduce((sum, g) => {
          const w = 0.5 + 0.5 * clamp(g.confidence, 0, 1);
          return sum + Math.max(0, g.score) * w;
        }, 0);

        const gamesCount = games.length;
        const opportunityScore = gamesCount > 0 ? trendScore / Math.log1p(gamesCount) : 0;

        // medians
        const medianActivePlayers = median(games.map((g) => g.activePlayers));
        const medianConfidence = median(games.map((g) => g.confidence));
        const confidenceBand = confidenceLabel(medianConfidence);

        // 24h median growth (only from games that actually have 24h coverage)
        const with24 = games.filter((g) => g.has24);
        const bigGames = with24.filter((g) => g.activePlayers >= 100_000);
        const smallGames = with24.filter((g) => g.activePlayers < 50_000);

        const leaderGrowthMedian = median(bigGames.map((g) => g.r24hPct));
        const breakoutGrowthMedian = median(smallGames.map((g) => g.r24hPct));
        const growth24Median = median(with24.map((g) => g.r24hPct));
        const growth24Coverage = gamesCount > 0 ? with24.length / gamesCount : 0;
        const breakoutsCount = games.filter(
          (g) => g.has24 &&
            g.activePlayers < 75_000 &&
            g.r24hPct >= 8 &&
             g.growthAbs24 >= 2000
        ).length;

        // show top games for the genre (for drill-down UI)
        const topGames = games.slice(0, 5).map((g) => ({
          id: g.id,
          name: g.name,
          creator: g.creator,
          activePlayers: g.activePlayers,
          score: g.score,
          confidence: g.confidence,
          r30Pct: g.r30Pct,
          r24hPct: g.r24hPct,
        }));

        return {
          key: agg.key,
          genre_l1: agg.genre_l1,
          genre_l2: agg.genre_l2,

          trendScore: Number.isFinite(trendScore) ? trendScore : 0,
          opportunityScore: Number.isFinite(opportunityScore) ? opportunityScore : 0,
          gamesCount,
          breakoutsCount,

          leaderGrowthMedian: Number.isFinite(leaderGrowthMedian) ? leaderGrowthMedian : 0,
          breakoutGrowthMedian: Number.isFinite(breakoutGrowthMedian) ? breakoutGrowthMedian : 0,
          medianActivePlayers: Number.isFinite(medianActivePlayers) ? medianActivePlayers : 0,
          medianGrowth24hPct: Number.isFinite(growth24Median) ? growth24Median : 0,
          growth24Coverage: Number.isFinite(growth24Coverage) ? growth24Coverage : 0,
          medianConfidence: Number.isFinite(medianConfidence) ? medianConfidence : 0,
          confidenceBand,

          topGames,
        };
      })
      .sort((a, b) => b.trendScore - a.trendScore)
      .slice(0, limit);

    return NextResponse.json({
      genres,
      meta: {
        group,
        limit,
        windowHours,
        sinceIso,
        maxRows,
        minPlayers,
        topK,
        gamesScored: scoredGames.length,
        distinctGenres: byGenre.size,
        truncatedLikely: rows.length >= maxRows,
      },
    });
  } catch (e: any) {
    return NextResponse.json({ genres: [], error: e?.message ?? "Unknown error" }, { status: 500 });
  }
}
