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

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);

    const key = (url.searchParams.get("key") ?? "").trim();
    const group = (url.searchParams.get("group") ?? "both").toLowerCase(); // l1|l2|both

    const windowHours = clamp(Number(url.searchParams.get("windowHours") ?? "168"), 6, 24 * 30);
    const bucketMinutes = clamp(Number(url.searchParams.get("bucketMinutes") ?? "30"), 5, 180);
    const maxRows = clamp(Number(url.searchParams.get("maxRows") ?? "80000"), 2000, 200000);

    if (!key) return NextResponse.json({ points: [] });

    const sinceIso = new Date(Date.now() - windowHours * 3600_000).toISOString();
    const bucketSec = bucketMinutes * 60;

    // 1) Build query FIRST
    let q = SupabaseServer
      .from("game_snapshots")
      .select("game_id, active_players, captured_at, games!inner(genre_l1, genre_l2)")
      .gte("captured_at", sinceIso)
      .order("captured_at", { ascending: true })
      .limit(maxRows);

    // 2) Apply genre filters AFTER q exists
    if (group === "l1") {
      const g1 = key === "Unknown" ? null : key;
      q = g1 == null ? q.is("games.genre_l1", null) : q.eq("games.genre_l1", g1);
    } else if (group === "l2") {
      const g2 = key === "Unknown" ? null : key;
      q = g2 == null ? q.is("games.genre_l2", null) : q.eq("games.genre_l2", g2);
    } else {
      // group === "both"
      if (key.includes(" / ")) {
        const [a, b] = key.split(" / ");
        const g1 = a === "Unknown" ? null : a;
        const g2 = b === "Unknown" ? null : b;

        q = g1 == null ? q.is("games.genre_l1", null) : q.eq("games.genre_l1", g1);
        q = g2 == null ? q.is("games.genre_l2", null) : q.eq("games.genre_l2", g2);
      } else {
        // key like "Survival" => ONLY filter genre_l1 (do NOT force genre_l2 null)
        const g1 = key === "Unknown" ? null : key;
        q = g1 == null ? q.is("games.genre_l1", null) : q.eq("games.genre_l1", g1);
      }
    }

    const { data, error } = await q;
    if (error) return NextResponse.json({ points: [], error: error.message }, { status: 500 });

    const rows = (data ?? []) as Row[];

    // bucket -> (game_id -> latest active in that bucket)
    const buckets = new Map<number, Map<string, number>>();

    for (const r of rows) {
      const ms = parseMs(r.captured_at);
      if (!ms) continue;

      const tSec = Math.floor(ms / 1000);
      const bucket = Math.floor(tSec / bucketSec) * bucketSec;

      const v = Math.max(0, safeNum(r.active_players));
      let byGame = buckets.get(bucket);
      if (!byGame) {
        byGame = new Map();
        buckets.set(bucket, byGame);
      }

      // rows are ascending time => overwriting means "latest snapshot per game in bucket"
      byGame.set(r.game_id, v);
    }

    const points = [...buckets.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([bucketTimeSec, byGame]) => {
        const values = [...byGame.values()];
        return { time: bucketTimeSec, value: median(values) };
      });

    return NextResponse.json({
      points,
      meta: { key, group, windowHours, bucketMinutes, sinceIso, rows: rows.length },
    });
  } catch (e: any) {
    return NextResponse.json({ points: [], error: e?.message ?? "Unknown error" }, { status: 500 });
  }
}
