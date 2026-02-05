// app/roblox/top/route.ts
import { NextResponse } from "next/server";

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

export async function GET(req: Request) {
  const url = new URL(req.url);

  // Which chart do you want?
  // Default = top playing right now
  const sortId = url.searchParams.get("sortId") ?? "top-playing-now";

  // Top 50 (cap at 100 because charts commonly return ~100)
  const limit = clamp(Number(url.searchParams.get("limit") ?? "50"), 1, 100);

  // Roblox says sessionId is required; can just be a random GUID
  const sessionId = crypto.randomUUID();

  const exploreUrl =
    `https://apis.roblox.com/explore-api/v1/get-sort-content` +
    `?sessionId=${encodeURIComponent(sessionId)}` +
    `&sortId=${encodeURIComponent(sortId)}`;

  const robloxRes = await fetch(exploreUrl, {
    cache: "no-store",
    headers: {
      "User-Agent": "roblox-trends/1.0",
      Accept: "application/json",
    },
  });

  if (!robloxRes.ok) {
    return NextResponse.json(
      { error: `Roblox Explore API failed: ${robloxRes.status}` },
      { status: 502 }
    );
  }

  const body: any = await robloxRes.json();

  // The response shape is undocumented, so we defensively try common keys
  const items: any[] =
    body?.content ??
    body?.data ??
    body?.games ??
    body?.sortContent ??
    body?.results ??
    [];

  // Extract IDs we might need later
  const top = items.slice(0, limit).map((it) => ({
    universeId: it?.universeId ?? it?.universe?.id ?? null,
    placeId: it?.placeId ?? it?.rootPlaceId ?? null,
    name: it?.name ?? it?.title ?? null,
    raw: it,
  }));

  return NextResponse.json({
    sortId,
    limit,
    count: top.length,
    top,
    rawKeys: Object.keys(body ?? {}),
  });
}
