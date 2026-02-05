// app/api/genres/series/route.ts
import { NextResponse } from "next/server";
import { SupabaseServer } from "@/app/lib/supabaseServer";

type Row = {
  game_id: string;
  active_players: number | null;
  captured_at: string;
  games?: {
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
function median(nums: number[]) {
  const arr = nums.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (arr.length === 0) return 0;
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 === 1 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

function recommendedBucketMinutes(windowHours: number) {
  // Keep charts ~100–200 points max
  // 24h -> 30m (48)
  // 7d  -> 60m (168)
  // 2w  -> 120m (168)
  // 30d -> 360m (120)
  if (windowHours <= 36) return 30;          // up to ~1.5 days
  if (windowHours <= 24 * 8) return 60;      // up to ~8 days
  if (windowHours <= 24 * 16) return 120;    // up to ~16 days
  return 360;                                // >16 days
}

function applyGenreFilter(q: any, key: string, group: string) {
  if (group === "l1") {
    const g1 = key === "Unknown" ? null : key;
    return g1 == null ? q.is("games.genre_l1", null) : q.eq("games.genre_l1", g1);
  }

  if (group === "l2") {
    const g2 = key === "Unknown" ? null : key;
    return g2 == null ? q.is("games.genre_l2", null) : q.eq("games.genre_l2", g2);
  }

  // group === "both"
  if (key.includes(" / ")) {
    const [aRaw, bRaw] = key.split(" / ");
    const a = (aRaw ?? "").trim();
    const b = (bRaw ?? "").trim();

    const g1 = a === "Unknown" ? null : a;
    const g2 = b === "Unknown" ? null : b;

    q = g1 == null ? q.is("games.genre_l1", null) : q.eq("games.genre_l1", g1);
    q = g2 == null ? q.is("games.genre_l2", null) : q.eq("games.genre_l2", g2);
    return q;
  }

  // key like "Survival" => ONLY filter genre_l1 (do NOT force genre_l2 null)
  const g1 = key === "Unknown" ? null : key;
  return g1 == null ? q.is("games.genre_l1", null) : q.eq("games.genre_l1", g1);
}

async function getAnchorNowMs(): Promise<number> {
  const { data, error } = await SupabaseServer
    .from("game_snapshots")
    .select("captured_at")
    .order("captured_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return Date.now();
  const ms = parseMs((data as any)?.captured_at ?? "");
  return ms || Date.now();
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);

    const key = (url.searchParams.get("key") ?? "").trim();
    const group = (url.searchParams.get("group") ?? "both").toLowerCase(); // l1|l2|both

    const windowHours = clamp(Number(url.searchParams.get("windowHours") ?? "168"), 6, 24 * 30);

    // client can request bucketMinutes, but server enforces a sensible minimum by window
    const requestedBucketMinutes = clamp(
      Number(url.searchParams.get("bucketMinutes") ?? "0"),
      0,
      24 * 60 // allow up to 1 day buckets if someone wants it
    );

    const minBucket = recommendedBucketMinutes(windowHours);

    // if client didn't send bucketMinutes (0), we use the recommended one
    const bucketMinutes = clamp(
      Math.max(requestedBucketMinutes || minBucket, minBucket),
      5,
      24 * 60
    );

    // NOTE: this is total cap, across pages
    const maxRows = clamp(Number(url.searchParams.get("maxRows") ?? "2000000"), 2000, 2_000_000);

    if (!key) return NextResponse.json({ points: [] });

    // Anchor to the most recent snapshot time in the DB (prevents “now” drift)
    const anchorNowMs = await getAnchorNowMs();
    const anchorNowIso = new Date(anchorNowMs).toISOString();

    const sinceIso = new Date(anchorNowMs - windowHours * 3600_000).toISOString();

    const bucketSec = bucketMinutes * 60;

    // Bucket window boundaries (aligned to bucket size)
    const startSec =
      Math.floor((anchorNowMs / 1000 - windowHours * 3600) / bucketSec) * bucketSec;
    const endSec = Math.floor(anchorNowMs / 1000 / bucketSec) * bucketSec;

    const pageSize = 1000;
    const rows: Row[] = [];

    let cursorIso = anchorNowIso; // move backward in time

    while (rows.length < maxRows) {
      let q = SupabaseServer
        .from("game_snapshots")
        .select("game_id, active_players, captured_at, games!inner(genre_l1, genre_l2)")
        .gte("captured_at", sinceIso)
        .lte("captured_at", cursorIso)
        .order("captured_at", { ascending: false })
        .limit(pageSize);

      q = applyGenreFilter(q, key, group);

      const { data, error } = await q;
      if (error) return NextResponse.json({ points: [], error: error.message }, { status: 500 });

      const chunk = (data ?? []) as Row[];
      if (chunk.length === 0) break;

      rows.push(...chunk);

      // move cursor to the oldest row we just fetched
      cursorIso = chunk[chunk.length - 1].captured_at;

      if (chunk.length < pageSize) break;
    }

    // Build per-bucket updates: bucketTime -> (game_id -> latest value in that bucket)
    // Build per-bucket updates: bucketTime -> (game_id -> latest snapshot in that bucket)
    const updates = new Map<number, Map<string, { ms: number; v: number }>>();

    for (const r of rows) {
      const ms = parseMs(r.captured_at);
      if (!ms) continue;

        const tSec = Math.floor(ms / 1000);
        const bucket = Math.floor(tSec / bucketSec) * bucketSec;

        const v = Math.max(0, safeNum(r.active_players));

        let byGame = updates.get(bucket);
        if (!byGame) {
          byGame = new Map();
          updates.set(bucket, byGame);
        }

        const prev = byGame.get(r.game_id);
        if (!prev || ms > prev.ms) {
          byGame.set(r.game_id, { ms, v }); // keep latest by timestamp
        }
    }


    // Forward-fill: carry last known value per game across buckets
    const lastByGame = new Map<string, number>();
    const points: Array<{ time: number; value: number }> = [];

    // Don't draw past the last bucket we actually have data for
    const maxBucket = updates.size ? Math.max(...Array.from(updates.keys())) : endSec;
    const safeEndSec = Math.min(endSec, maxBucket);

    for (let t = startSec; t <= safeEndSec; t += bucketSec) {
      const byGame = updates.get(t);
      if (byGame) {
        for (const [gid, obj] of byGame.entries()) lastByGame.set(gid, obj.v);
      }

      if (lastByGame.size === 0) continue;

      const values = Array.from(lastByGame.values());
      points.push({ time: t, value: median(values) });
    }

    const minRowMs = rows.length ? Math.min(...rows.map(r => parseMs(r.captured_at))) : 0;
    const maxRowMs = rows.length ? Math.max(...rows.map(r => parseMs(r.captured_at))) : 0;

    return NextResponse.json({
      points,
      meta: {
        key,
        group,
        windowHours,
        bucketMinutes,
        bucketRequested: requestedBucketMinutes || null,
        bucketRecommended: minBucket,
        bucketUsed: bucketMinutes,
        sinceIso,
        anchorNowIso,
        rows: rows.length,
        gamesTracked: lastByGame.size,

        // debug coverage
        minRowIso: minRowMs ? new Date(minRowMs).toISOString() : null,
        maxRowIso: maxRowMs ? new Date(maxRowMs).toISOString() : null,
        hitCap: rows.length >= maxRows,
      },
    });
  } catch (e: any) {
    return NextResponse.json(
      { points: [], error: e?.message ?? "Unknown error" },
      { status: 500 }
    );
  }
}
