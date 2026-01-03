import { NextResponse } from "next/server";
import { SupabaseServer } from "@/app/lib/supabaseServer";

type Row = {
  game_id: string;
  active_players: number | null;
  visits: number | null;
  favorites: number | null;
  like_ratio: number | null;
  captured_at: string;
  games?: { name?: string; creator?: string; genre_l1?: string; genre_l2?: string } | null;
};

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const limit = Math.max(1, Math.min(50, Number(url.searchParams.get("limit") ?? "20")));

    const { data, error } = await SupabaseServer
      .from("game_snapshots")
      .select("game_id, active_players, visits, favorites, like_ratio, captured_at, games(name, creator, genre_l1, genre_l2)")
      .order("captured_at", { ascending: false })
      .limit(1000);

    if (error) return NextResponse.json({ games: [], error: error.message }, { status: 500 });

    const rows = (data ?? []) as Row[];

    const latestTwo = new Map<string, Row[]>();
    for (const r of rows) {
      const arr = latestTwo.get(r.game_id) ?? [];
      if (arr.length < 2) {
        arr.push(r);
        latestTwo.set(r.game_id, arr);
      }
    }

    const trending = Array.from(latestTwo.entries())
      .filter(([, arr]) => arr.length >= 2)
      .map(([gameId, arr]) => {
        const now = arr[0];
        const prev = arr[1];

        const nowPlayers = now.active_players ?? 0;
        const prevPlayers = prev.active_players ?? 0;

        const growthAbs = nowPlayers - prevPlayers;
        const growthPct = prevPlayers > 0 ? (growthAbs / prevPlayers) * 100 : 0;

        return {
          id: gameId,
          name: now.games?.name ?? "Unknown",
          creator: now.games?.creator ?? "Unknown",
          tags: [], // ✅ REQUIRED for your UI

          activePlayers: nowPlayers,
          growthPct, // ✅ now real (not hardcoded 0)

          // optional extras (won't hurt UI)
          prevPlayers,
          growthAbs,
          genre_l1: now.games?.genre_l1 ?? null,
          genre_l2: now.games?.genre_l2 ?? null,
          visits: now.visits ?? null,
          favorites: now.favorites ?? null,
          likeRatio: now.like_ratio ?? null,
          capturedAt: now.captured_at,
          prevCapturedAt: prev.captured_at,
        };
      })
      .sort((a, b) => (b.growthPct ?? 0) - (a.growthPct ?? 0))
      .slice(0, limit);

    // fallback so UI still shows something if you only have 1 snapshot/game
    if (trending.length === 0) {
      const fallback = rows.slice(0, limit).map((row) => ({
        id: row.game_id,
        name: row.games?.name ?? "Unknown",
        creator: row.games?.creator ?? "Unknown",
        tags: [],
        activePlayers: row.active_players ?? 0,
        growthPct: 0,
      }));
      return NextResponse.json({ games: fallback, meta: { fallback: true } });
    }

    return NextResponse.json({ games: trending, meta: { fallback: false } });
  } catch (e: any) {
    return NextResponse.json({ games: [], error: e?.message ?? "Unknown error" }, { status: 500 });
  }
}
