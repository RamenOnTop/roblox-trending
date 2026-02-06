// app/api/genres/trending/route.ts
import { NextResponse } from "next/server";
import { SupabaseServer } from "@/app/lib/supabaseServer";

const __TREND_CACHE: Map<string, { exp: number; payload: any }> =
  (globalThis as any).__TREND_CACHE ?? ((globalThis as any).__TREND_CACHE = new Map());


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
function chunk<T>(arr: T[], size: number) {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Find snapshot closest to (now - minutesBack), preferring <= target.
 * If none exist, returns oldest snapshot (this is the "use max available" behavior).
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

function scoreGame(snaps: Row[], windowHours: number) {
  const now = snaps[0];
  const nowMs = parseMs(now.captured_at) || Date.now();

  const P0 = Math.max(0, safeNum(now.active_players));
  const V0 = Math.max(0, safeNum(now.visits));
  const F0 = Math.max(0, safeNum(now.favorites));
  const like = clamp(now.like_ratio == null ? 0.5 : safeNum(now.like_ratio), 0, 1);

  const liquidity = clamp(Math.log1p(P0), 0, 8);
  const qualityTilt = 2 * (like - 0.5);

  // momentum horizons
  const s30 = pickSnapshot(snaps, nowMs, 30);
  const s6h = pickSnapshot(snaps, nowMs, 6 * 60);
  const s24h = pickSnapshot(snaps, nowMs, 24 * 60);

  let r30 = 0, r6h = 0, r24h = 0;
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

  let hoursUsed24 = 0;
  if (has24) {
    const P24 = Math.max(0, safeNum(s24h!.active_players));
    r24h = clamp(logReturn(P0, P24, 50), -2.0, 2.0);
    const h24 = hoursBetween(nowMs, parseMs(s24h!.captured_at));
    hoursUsed24 = h24;

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

  // Window stats (ALWAYS "up to windowHours back", fallback to oldest available)
  const sWin = pickSnapshot(snaps, nowMs, windowHours * 60);

  let rWindowPct = 0;
  let growthAbsWindow = 0;
  let windowHoursUsed = 0;

  if (sWin && sWin !== now) {
    const Pw = Math.max(0, safeNum(sWin.active_players));
    const rWindow = clamp(logReturn(P0, Pw, 50), -3.0, 3.0);
    rWindowPct = (Math.exp(rWindow) - 1) * 100;
    growthAbsWindow = P0 - Pw;
    windowHoursUsed = hoursBetween(nowMs, parseMs(sWin.captured_at));
  }

  const r30Pct = (Math.exp(r30) - 1) * 100;
  const r6hPct = (Math.exp(r6h) - 1) * 100;
  const r24hPct = (Math.exp(r24h) - 1) * 100;

  // Median active across the snaps we fetched (which are window-limited)
  const medianActiveWindow = median(snaps.map((s) => Math.max(0, safeNum(s.active_players))));

  // confidence (unchanged)
  const coverage24 = clamp(spanHours / 24, 0, 1);
  const horizonFactor = 0.15 + (has30 ? 0.25 : 0) + (has6 ? 0.25 : 0) + (has24 ? 0.35 : 0);
  const confidence = clamp(coverage24 * horizonFactor, 0, 1);

  const presence = 0.12 * liquidity + 0.35 * qualityTilt;
  const finalScore = liquidity * momentumCore + (1 - confidence) * presence;

  return {
    score: Number.isFinite(finalScore) ? finalScore : 0,
    confidence: Number.isFinite(confidence) ? confidence : 0,

    activePlayersNow: P0,

    medianActiveWindow: Number.isFinite(medianActiveWindow) ? medianActiveWindow : 0,

    rWindowPct: Number.isFinite(rWindowPct) ? rWindowPct : 0,
    growthAbsWindow: Number.isFinite(growthAbsWindow) ? growthAbsWindow : 0,
    windowHoursUsed: Number.isFinite(windowHoursUsed) ? windowHoursUsed : 0,

    has24,
    r24hPct: Number.isFinite(r24hPct) ? r24hPct : 0,
    growthAbs24: Number.isFinite(growthAbs24) ? growthAbs24 : 0,
    hoursUsed24: Number.isFinite(hoursUsed24) ? hoursUsed24 : 0,

    r30Pct: Number.isFinite(r30Pct) ? r30Pct : 0,
    r6hPct: Number.isFinite(r6hPct) ? r6hPct : 0,
    spanHours: Number.isFinite(spanHours) ? spanHours : 0,
  };
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const cacheKey = url.toString();
    const hit = __TREND_CACHE.get(cacheKey);
      if (hit && hit.exp > Date.now()) {
        return NextResponse.json(hit.payload, {
      headers: { "Cache-Control": "public, max-age=10, s-maxage=60, stale-while-revalidate=120" },
      });
    }


    const group = (url.searchParams.get("group") ?? "both").toLowerCase();
    const limit = clamp(Number(url.searchParams.get("limit") ?? "20"), 1, 100);

    const windowHours = clamp(
      Number(url.searchParams.get("windowHours") ?? String(24 * 7)),
      6,
      24 * 30
    );

    const minPlayers = clamp(Number(url.searchParams.get("minPlayers") ?? "0"), 0, 1_000_000);
    const topK = clamp(Number(url.searchParams.get("topK") ?? "5"), 1, 25);

    // caps you can tune
    // Auto-tune: longer windows => fewer candidates (because history rows per game explode)
    const autoMaxGames =
      windowHours <= 24 ? 1600 :
      windowHours <= 24 * 7 ? 1000 :
      windowHours <= 24 * 14 ? 700 :
      500;

    const maxGames = clamp(
      Number(url.searchParams.get("maxGames") ?? String(autoMaxGames)),
      100,
      10000
    );

    const maxNowRows = clamp(Number(url.searchParams.get("maxNowRows") ?? "200000"), 10_000, 500_000);
    const maxHistRowsTotal = clamp(Number(url.searchParams.get("maxHistRows") ?? "600000"), 10_000, 800_000);

    const NOW_LOOKBACK_HOURS = clamp(Number(url.searchParams.get("nowLookbackHours") ?? "2"), 1, 12);
    const BUFFER_HOURS = 2;

    // Anchor "now" to latest captured_at in DB
    const { data: lastRow, error: lastErr } = await SupabaseServer
      .from("game_snapshots")
      .select("captured_at")
      .order("captured_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (lastErr) return NextResponse.json({ genres: [], error: lastErr.message }, { status: 500 });

    const anchorNowMs = parseMs((lastRow as any)?.captured_at ?? "") || Date.now();
    const anchorNowIso = new Date(anchorNowMs).toISOString();

    const sinceIso = new Date(anchorNowMs - (windowHours + BUFFER_HOURS) * 3600_000).toISOString();
    const nowSinceIso = new Date(anchorNowMs - NOW_LOOKBACK_HOURS * 3600_000).toISOString();

    // Step 1: pick current games (latest row per game from the last NOW_LOOKBACK_HOURS)
    const latestByGame = new Map<string, Row>();

    const pageSizeNow = 1000;
    for (let offset = 0; offset < maxNowRows; offset += pageSizeNow) {
      const { data: page, error: pageErr } = await SupabaseServer
        .from("game_snapshots")
        .select("game_id, active_players, visits, favorites, like_ratio, captured_at, games(name, creator, genre_l1, genre_l2)")
        .gte("captured_at", nowSinceIso)
        .lte("captured_at", anchorNowIso)
        .order("captured_at", { ascending: false })
        .range(offset, offset + pageSizeNow - 1);

      if (pageErr) return NextResponse.json({ genres: [], error: pageErr.message }, { status: 500 });

      const pageRows = (page ?? []) as Row[];
      for (const r of pageRows) {
        if (!latestByGame.has(r.game_id)) {
          latestByGame.set(r.game_id, r);
          if (latestByGame.size >= maxGames) break;
        }
      }

      if (latestByGame.size >= maxGames) break;
      if (pageRows.length < pageSizeNow) break;
    }

    const gameIds = Array.from(latestByGame.keys());
    if (gameIds.length === 0) {
      return NextResponse.json({
        genres: [],
        meta: { group, limit, windowHours, sinceIso, anchorNowIso, gamesScored: 0, distinctGenres: 0 },
      });
    }

    // Step 2: fetch history for those games only
    const rows: Row[] = [];
    const idChunks = chunk(gameIds, 100);
    const pageSizeHist = 1000;

    let truncatedLikely = false;

    for (const ids of idChunks) {
        let cursorIso = anchorNowIso;
        let first = true;

        while (rows.length < maxHistRowsTotal) {
          const q = SupabaseServer
          .from("game_snapshots")
          .select("game_id, active_players, visits, favorites, like_ratio, captured_at")
          .in("game_id", ids)
          .gte("captured_at", sinceIso)
          .order("captured_at", { ascending: false })
          .limit(pageSizeHist);

        const { data: page, error: pageErr } = await (first
          ? q.lte("captured_at", cursorIso)
          : q.lt("captured_at", cursorIso));

        if (pageErr) return NextResponse.json({ genres: [], error: pageErr.message }, { status: 500 });

        const pageRows = (page ?? []) as Row[];
        if (pageRows.length === 0) break;

        rows.push(...pageRows);

        if (pageRows.length < pageSizeHist) break;

        cursorIso = pageRows[pageRows.length - 1]!.captured_at;
        first = false;
      }
    }

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

    // Score games
    const scoredGames = Array.from(byGame.entries())
      .map(([gameId, snaps]) => {
        const meta = latestByGame.get(gameId);
        const g1 = (meta?.games?.genre_l1 ?? null) as string | null;
        const g2 = (meta?.games?.genre_l2 ?? null) as string | null;

        const s = scoreGame(snaps, windowHours);

        return {
          id: gameId,
          name: meta?.games?.name ?? "Unknown",
          creator: meta?.games?.creator ?? "Unknown",
          genre_l1: g1,
          genre_l2: g2,

          activePlayersNow: s.activePlayersNow,
          medianActiveWindow: s.medianActiveWindow,

          score: s.score,
          confidence: s.confidence,

          rWindowPct: s.rWindowPct,
          growthAbsWindow: s.growthAbsWindow,
          windowHoursUsed: s.windowHoursUsed,

          has24: s.has24,
          r24hPct: s.r24hPct,
          growthAbs24: s.growthAbs24,
          hoursUsed24: s.hoursUsed24,
        };
      })
      .filter((g) => g.activePlayersNow >= minPlayers);

    type GameEntry = (typeof scoredGames)[number];
    type GenreAgg = { key: string; genre_l1: string | null; genre_l2: string | null; games: GameEntry[] };
    const byGenre = new Map<string, GenreAgg>();

    function makeKey(g1: string | null, g2: string | null) {
      if (group === "l1") return g1 ?? "Unknown";
      if (group === "l2") return g2 ?? "Unknown";
      const a = g1 ?? "Unknown";
      const b = g2 ?? null;
      return b ? `${a} / ${b}` : a;
    }

    for (const g of scoredGames) {
      const key = makeKey(g.genre_l1, g.genre_l2);
      const existing = byGenre.get(key);
      if (existing) existing.games.push(g);
      else {
        byGenre.set(key, {
          key,
          genre_l1: group === "l2" ? null : (g.genre_l1 ?? null),
          genre_l2: group === "l1" ? null : (g.genre_l2 ?? null),
          games: [g],
        });
      }
    }

    const genres = Array.from(byGenre.values())
      .map((agg) => {
        const games = agg.games.slice().sort((a, b) => b.score - a.score);

        const top = games.slice(0, topK);
        const trendScore = top.reduce((sum, g) => {
          const w = 0.5 + 0.5 * clamp(g.confidence, 0, 1);
          return sum + Math.max(0, g.score) * w;
        }, 0);

        const gamesCount = games.length;
        const opportunityScore = gamesCount > 0 ? trendScore / Math.log1p(gamesCount) : 0;

        const medianActivePlayers = median(
          games.map((g) => (Number.isFinite(g.medianActiveWindow) ? g.medianActiveWindow : g.activePlayersNow))
        );

        const medianGrowthPct = median(games.map((g) => g.rWindowPct));
        const medianWindowHoursUsed = median(games.map((g) => safeNum((g as any).windowHoursUsed, 0)));

        const fullCoverageCount = games.filter((g) => safeNum((g as any).windowHoursUsed, 0) >= windowHours * 0.9).length;
        const windowCoverage = gamesCount > 0 ? fullCoverageCount / gamesCount : 0;

        // "24h median" secondary (but still "max available up to 24h" if you have less)
        const medianGrowth24hPct = median(games.map((g) => g.r24hPct));
        const full24Count = games.filter((g) => safeNum((g as any).hoursUsed24, 0) >= 24 * 0.9).length;
        const growth24Coverage = gamesCount > 0 ? full24Count / gamesCount : 0;

        const medianConfidence = median(games.map((g) => g.confidence));
        const confidenceBand = confidenceLabel(medianConfidence);

        const leaders = games.filter((g) => g.activePlayersNow >= 100_000);
        const smalls = games.filter((g) => g.activePlayersNow < 50_000);

        const leaderGrowthMedian = median(leaders.map((g) => g.rWindowPct));
        const breakoutGrowthMedian = median(smalls.map((g) => g.rWindowPct));

        const breakoutsCount = games.filter(
          (g) => g.activePlayersNow < 75_000 && g.rWindowPct >= 8 && g.growthAbsWindow >= 2000
        ).length;

        const topGames = games.slice(0, 5).map((g) => ({
          id: g.id,
          name: g.name,
          creator: g.creator,
          activePlayersNow: g.activePlayersNow,
          rWindowPct: g.rWindowPct,
          r24hPct: g.r24hPct,
        }));

        return {
          key: agg.key,
          genre_l1: agg.genre_l1,
          genre_l2: agg.genre_l2,

          windowHours,

          trendScore: Number.isFinite(trendScore) ? trendScore : 0,
          opportunityScore: Number.isFinite(opportunityScore) ? opportunityScore : 0,
          gamesCount,
          breakoutsCount,

          medianActivePlayers: Number.isFinite(medianActivePlayers) ? medianActivePlayers : 0,
          medianGrowthPct: Number.isFinite(medianGrowthPct) ? medianGrowthPct : 0,
          windowCoverage,
          medianWindowHoursUsed,

          medianGrowth24hPct: Number.isFinite(medianGrowth24hPct) ? medianGrowth24hPct : 0,
          growth24Coverage: Number.isFinite(growth24Coverage) ? growth24Coverage : 0,

          leaderGrowthMedian: Number.isFinite(leaderGrowthMedian) ? leaderGrowthMedian : 0,
          breakoutGrowthMedian: Number.isFinite(breakoutGrowthMedian) ? breakoutGrowthMedian : 0,

          medianConfidence: Number.isFinite(medianConfidence) ? medianConfidence : 0,
          confidenceBand,

          topGames,
        };
      })
      .sort((a, b) => b.trendScore - a.trendScore)
      .slice(0, limit);

    const payload = {
        genres,
        meta: {
          group,
          limit,
          windowHours,
          sinceIso,
          anchorNowIso,
          nowLookbackHours: NOW_LOOKBACK_HOURS,
          bufferHours: BUFFER_HOURS,
          maxGames,
          maxNowRows,
          maxHistRowsTotal,
          gamesScored: scoredGames.length,
          distinctGenres: byGenre.size,
          truncatedLikely,
          rowsFetched: rows.length,
        },
    }

    __TREND_CACHE.set(cacheKey, { exp: Date.now() + 60_000, payload });

    return NextResponse.json(payload, {
      headers: { "Cache-Control": "public, max-age=10, s-maxage=60, stale-while-revalidate=120" },
    });
  } catch (e: any) {
    return NextResponse.json({ genres: [], error: e?.message ?? "Unknown error" }, { status: 500 });
  }
}
