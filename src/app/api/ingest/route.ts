import { NextResponse } from "next/server";
import { SupabaseServer } from "@/app/lib/supabaseServer"; // <-- make sure file name matches

function chunk<T>(arr: T[], size: number) {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function gamesStatsUrl(universeIds: string[]) {
  const ids = universeIds.join(",");
  return `https://games.roblox.com/v1/games?universeIds=${encodeURIComponent(ids)}`;
}

export async function GET(req: Request) {
  return POST(req);
}

export async function POST(req: Request) {
  try {
    const url = new URL(req.url);

    const sortId = url.searchParams.get("sortId") ?? "top-playing-now";
    const limit = clamp(Number(url.searchParams.get("limit") ?? "50"), 1, 100);

    // Build base URL to call your own internal API (works in prod + local)
    const baseUrl = `${url.protocol}//${url.host}`;

    // 1) Fetch Top list (your existing route)
    const topUrl = `${baseUrl}/api/roblox/top?sortId=${encodeURIComponent(
      sortId
    )}&limit=${encodeURIComponent(String(limit))}`;

    const topRes = await fetch(topUrl, { cache: "no-store" });
    if (!topRes.ok) {
      const text = await topRes.text().catch(() => "");
      return NextResponse.json(
        { ok: false, step: "top", status: topRes.status, body: text.slice(0, 500) },
        { status: 502 }
      );
    }

    const topJson: any = await topRes.json();
    const topArr: any[] = Array.isArray(topJson?.top) ? topJson.top : [];

    const universeIds: string[] = topArr
      .map((t) => String(t?.universeId ?? ""))
      .filter(Boolean);

    // Votes from Explore "raw"
    const votesById = new Map<
      string,
      { up: number; down: number; playerCount?: number; rootPlaceId?: number; name?: string }
    >();

    for (const t of topArr) {
      const id = String(t?.universeId ?? "");
      if (!id) continue;

      const raw = t?.raw ?? {};
      votesById.set(id, {
        up: Number(raw?.totalUpVotes ?? 0),
        down: Number(raw?.totalDownVotes ?? 0),
        playerCount: raw?.playerCount != null ? Number(raw.playerCount) : undefined,
        rootPlaceId: raw?.rootPlaceId != null ? Number(raw.rootPlaceId) : undefined,
        name: t?.name ?? raw?.name ?? undefined,
      });
    }

    // 2) Fetch detailed per-game stats (chunks)
    const BATCH_SIZE = 25;
    const allGameData: any[] = [];

    for (const batch of chunk(universeIds, BATCH_SIZE)) {
      const res = await fetch(gamesStatsUrl(batch), { cache: "no-store" });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return NextResponse.json(
          { ok: false, step: "games", status: res.status, body: text.slice(0, 500) },
          { status: 502 }
        );
      }
      const json: any = await res.json();
      if (Array.isArray(json?.data)) allGameData.push(...json.data);
    }

    const nowIso = new Date().toISOString();

    // 3) Upsert into games (metadata)
    const gamesRows = allGameData.map((g: any) => {
      const creator = g?.creator ?? {};
      return {
        id: String(g?.id), // universeId as text (matches your schema)
        root_place_id: g?.rootPlaceId ?? null,
        name: g?.name ?? null,
        description: g?.description ?? null,
        creator_id: creator?.id ?? null,
        creator_type: creator?.type ?? null,
        creator: creator?.name ?? null,
        max_players: g?.maxPlayers ?? null,
        genre_l1: g?.genre_l1 ?? null,
        genre_l2: g?.genre_l2 ?? null,
        created_at: g?.created ?? null,
        updated_at: g?.updated ?? null,
        last_seen_at: nowIso,
      };
    });

    if (gamesRows.length > 0) {
      const { error } = await SupabaseServer.from("games").upsert(gamesRows, {
        onConflict: "id",
      });
      if (error) throw error;
    }

    // 4) Insert snapshots (combined)
    const snapshotRows = allGameData.map((g: any) => {
      const id = String(g?.id);
      const votes = votesById.get(id);

      const up = votes?.up ?? null;
      const down = votes?.down ?? null;

      const like_ratio =
        up != null && down != null && up + down > 0 ? up / (up + down) : null;

      return {
        game_id: id,
        captured_at: nowIso,
        active_players: g?.playing ?? null,
        visits: g?.visits ?? null,
        favorites: g?.favoritedCount ?? null,
        up_votes: up,
        down_votes: down,
        like_ratio,
        source: "combined",
      };
    });

    if (snapshotRows.length > 0) {
      const { error } = await SupabaseServer
        .from("game_snapshots")
        .insert(snapshotRows);

      if (error) throw error;
    }

    return NextResponse.json({
      ok: true,
      sortId,
      limit,
      tracked: universeIds.length,
      detailedFetched: allGameData.length,
      insertedSnapshots: snapshotRows.length,
    });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message ?? String(err) },
      { status: 500 }
    );
  }
}
